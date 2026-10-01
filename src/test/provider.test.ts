import assert from "node:assert/strict";
import {
  GetSubscription,
  ListSubscriptions,
  type SubscriptionEvent,
  SubscriptionEvents,
  SubscriptionNotFoundError,
  UpdateSubscriptionPaymentMethod,
} from "@antelopejs/interface-subscriptions";

import {
  HOUR_MS,
  MINUTE_MS,
  type ManualClock,
  SUITE_TIMEOUT,
  TOKENS,
  chargesMade,
  eventTypes,
  key,
  newPayer,
  provider,
  quiesce,
  recordEvents,
  saveMethod,
  settleOn,
  subscribe,
  useManualClock,
} from "./support";

const START = Date.UTC(2027, 5, 1, 9);
const MONTH_LATER = Date.UTC(2027, 6, 1, 9);
const SECONDARY = "secondary";

/** The test provider settles a pending charge on its second read; the module reads once an hour. */
async function readSettlementTwice(clock: ManualClock): Promise<void> {
  for (const _read of [1, 2]) {
    clock.advance(HOUR_MS);
    await quiesce();
  }
}

describe("[fallback] a charge that settles later", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);
  const received = recordEvents();

  async function settlingSubscription(token: string) {
    const payer = await newPayer();
    const created = await subscribe(payer);
    await UpdateSubscriptionPaymentMethod(
      created.id,
      await saveMethod(payer.customer, token),
      key(),
    );
    clock.advanceTo(MONTH_LATER);
    return settleOn(
      created.id,
      (s) => s.currentPeriodStart === MONTH_LATER,
      "renewal attempted",
    );
  }

  it("keeps the subscription active and reports nothing until the charge settles", async () => {
    const renewing = await settlingSubscription(TOKENS.settlesLater);
    assert.equal(renewing.status, "active");
    assert.equal(provider.paymentStatus(renewing.latestPayment!), "pending");
    assert.deepEqual(eventTypes(received, renewing.id), [
      "subscription.created",
      "subscription.payment_succeeded",
    ]);

    await readSettlementTwice(clock);
    await settleOn(
      renewing.id,
      () => eventTypes(received, renewing.id).length === 3,
      "settled",
    );
    assert.equal(
      eventTypes(received, renewing.id).at(-1),
      "subscription.payment_succeeded",
    );
    assert.equal(
      chargesMade(renewing.id).length,
      2,
      "reading a settling charge is not charging again",
    );
  });

  it("goes past_due when a settling charge fails", async () => {
    const renewing = await settlingSubscription(TOKENS.failsLater);

    await readSettlementTwice(clock);
    const failed = await settleOn(
      renewing.id,
      (s) => s.status === "past_due",
      "failed later",
    );
    assert.equal(failed.latestPayment, renewing.latestPayment);
    assert.equal(
      eventTypes(received, renewing.id).at(-1),
      "subscription.payment_failed",
    );
  });
});

describe("[fallback] a provider that cannot be reached", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  afterEach(() => provider.setUnreachable(false));

  it("changes nothing, retries later, and charges under the same key", async () => {
    const created = await subscribe(await newPayer());

    provider.setUnreachable(true);
    clock.advanceTo(MONTH_LATER);
    await quiesce();
    const untouched = await GetSubscription(created.id);
    assert.equal(untouched.status, "active", "an outage is not a decline");
    assert.equal(untouched.currentPeriodEnd, MONTH_LATER);
    const attempted = provider
      .chargesFor(created.id)
      .filter((entry) => entry.unreachable);
    assert.ok(attempted.length >= 1, "the renewal was attempted");

    provider.setUnreachable(false);
    clock.advance(5 * MINUTE_MS);
    const renewed = await settleOn(
      created.id,
      (s) => s.currentPeriodStart === MONTH_LATER,
      "after the outage",
    );
    assert.equal(renewed.status, "active");
    const charged = chargesMade(created.id).at(-1)!;
    assert.equal(charged.idempotencyKey, attempted[0].idempotencyKey);
  });
});

describe("[fallback] several payment accounts", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  it("charges every period to the account the subscription was created on", async () => {
    const payer = await newPayer(TOKENS.succeeds, SECONDARY);
    const created = await subscribe(payer, {}, SECONDARY);

    clock.advanceTo(MONTH_LATER);
    await settleOn(
      created.id,
      () => chargesMade(created.id).length === 2,
      "renewal",
      SECONDARY,
    );

    assert.deepEqual(
      chargesMade(created.id).map((charge) => charge.provider),
      [SECONDARY, SECONDARY],
    );
  });

  it("finds a subscription only under the account it belongs to", async () => {
    const payer = await newPayer(TOKENS.succeeds, SECONDARY);
    const created = await subscribe(payer, {}, SECONDARY);

    assert.equal((await GetSubscription(created.id, SECONDARY)).id, created.id);
    await assert.rejects(
      GetSubscription(created.id),
      SubscriptionNotFoundError,
    );
    assert.deepEqual(await ListSubscriptions(payer.customer), []);
    assert.equal(
      (await ListSubscriptions(payer.customer, SECONDARY)).length,
      1,
    );
  });
});

describe("[fallback] delivering events", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);
  recordEvents();

  it("delivers an event again when a handler throws, and stops once it is handled", async () => {
    const seen: SubscriptionEvent[] = [];
    let shouldFail = true;
    SubscriptionEvents.register("flaky", (event) => {
      seen.push(event);
      if (shouldFail && event.type === "subscription.created") {
        shouldFail = false;
        throw new Error("handler failed once");
      }
    });
    try {
      const created = await subscribe(await newPayer());
      await settleOn(
        created.id,
        () =>
          seen.filter((event) => event.subscription.id === created.id).length >=
          1,
        "first delivery",
      );
      await quiesce();
      clock.advance(10 * MINUTE_MS);
      await settleOn(
        created.id,
        () =>
          seen.filter(
            (event) =>
              event.type === "subscription.created" &&
              event.subscription.id === created.id,
          ).length === 2,
        "redelivery",
      );
      const deliveries = seen.filter(
        (event) =>
          event.subscription.id === created.id &&
          event.type === "subscription.created",
      );
      assert.equal(
        deliveries[0].id,
        deliveries[1].id,
        "a redelivery carries the same event id",
      );

      clock.advance(10 * MINUTE_MS);
      await quiesce();
      const after = seen.filter(
        (event) =>
          event.subscription.id === created.id &&
          event.type === "subscription.created",
      );
      assert.equal(after.length, 2, "a handled event is not delivered again");
    } finally {
      SubscriptionEvents.unregister("flaky");
    }
  });
});
