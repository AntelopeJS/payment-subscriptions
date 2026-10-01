import assert from "node:assert/strict";
import {
  CancelSubscription,
  GetSubscription,
  UpdateSubscriptionPaymentMethod,
} from "@antelopejs/interface-subscriptions";

import {
  DAY_MS,
  HOUR_MS,
  SUITE_TIMEOUT,
  TOKENS,
  chargesMade,
  eventTypes,
  key,
  newPayer,
  quiesce,
  recordEvents,
  saveMethod,
  settleOn,
  subscribe,
  useManualClock,
} from "./support";

const JAN_31 = Date.UTC(2027, 0, 31, 12);
const FEB_28 = Date.UTC(2027, 1, 28, 12);
const MAR_31 = Date.UTC(2027, 2, 31, 12);
const APR_30 = Date.UTC(2027, 3, 30, 12);
const TRIAL_DAYS = 14;

describe("[fallback] renewing on the clock", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(JAN_31);
  const received = recordEvents();

  it("renews each month from the anchor, so a short month does not drift the cycle", async () => {
    const created = await subscribe(await newPayer());
    assert.equal(created.currentPeriodStart, JAN_31);
    assert.equal(created.currentPeriodEnd, FEB_28);

    clock.advanceTo(FEB_28);
    const second = await settleOn(
      created.id,
      (s) => s.currentPeriodStart === FEB_28,
      "second period",
    );
    assert.equal(
      second.currentPeriodEnd,
      MAR_31,
      "back to the 31st after February",
    );
    assert.notEqual(second.latestPayment, created.latestPayment);

    clock.advanceTo(MAR_31);
    const third = await settleOn(
      created.id,
      (s) => s.currentPeriodStart === MAR_31,
      "third period",
    );
    assert.equal(third.currentPeriodEnd, APR_30);
    assert.equal(third.status, "active");

    const charges = chargesMade(created.id);
    assert.equal(charges.length, 3, "one charge per period");
    assert.equal(
      new Set(charges.map((charge) => charge.idempotencyKey)).size,
      3,
    );
    assert.ok(charges.every((charge) => charge.request.offSession));
  });

  it("does not charge before the period ends", async () => {
    const created = await subscribe(await newPayer());
    clock.advanceTo(FEB_28 - 1);
    await quiesce();

    assert.equal(
      chargesMade(created.id).length,
      1,
      "only the first period is charged",
    );
    assert.equal((await GetSubscription(created.id)).currentPeriodEnd, FEB_28);
  });

  it("charges nothing during a trial, then charges when it ends", async () => {
    const trialEnd = JAN_31 + TRIAL_DAYS * DAY_MS;
    const created = await subscribe(await newPayer(), { trialEnd });

    clock.advanceTo(trialEnd - HOUR_MS);
    await quiesce();
    assert.equal((await GetSubscription(created.id)).status, "trialing");
    assert.equal(chargesMade(created.id).length, 0);

    clock.advanceTo(trialEnd);
    const paid = await settleOn(
      created.id,
      (s) => s.status === "active",
      "trial end",
    );
    assert.equal(paid.currentPeriodStart, trialEnd);
    assert.equal(paid.trialEnd, trialEnd, "the trial stays on record");
    assert.equal(chargesMade(created.id).length, 1);
    assert.deepEqual(eventTypes(received, created.id), [
      "subscription.created",
      "subscription.payment_succeeded",
    ]);
  });

  it("charges first at a billing anchor, and counts periods from it", async () => {
    const anchor = JAN_31 + 3 * DAY_MS;
    const created = await subscribe(await newPayer(), {
      billingAnchor: anchor,
    });
    assert.equal(chargesMade(created.id).length, 0);

    clock.advanceTo(anchor);
    const paid = await settleOn(
      created.id,
      (s) => s.latestPayment !== undefined,
      "anchor",
    );
    assert.equal(paid.currentPeriodStart, anchor);
    assert.equal(paid.currentPeriodEnd, Date.UTC(2027, 2, 3, 12));
  });
});

describe("[fallback] a renewal that fails", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(JAN_31);
  const received = recordEvents();

  async function failingSubscription() {
    const payer = await newPayer();
    const created = await subscribe(payer);
    const declining = await saveMethod(
      payer.customer,
      TOKENS.declinesOffSession,
    );
    await UpdateSubscriptionPaymentMethod(created.id, declining, key());
    return { payer, created };
  }

  it("goes past_due, keeps the new period, and says so", async () => {
    const { created } = await failingSubscription();

    clock.advanceTo(FEB_28);
    const failed = await settleOn(
      created.id,
      (s) => s.status === "past_due",
      "failed renewal",
    );

    assert.equal(
      failed.currentPeriodStart,
      FEB_28,
      "the unpaid period is the current one",
    );
    assert.equal(failed.currentPeriodEnd, MAR_31);
    assert.notEqual(failed.latestPayment, created.latestPayment);
    assert.deepEqual(eventTypes(received, created.id).slice(-1), [
      "subscription.payment_failed",
    ]);
    const failure = received.find(
      (event) =>
        event.type === "subscription.payment_failed" &&
        event.subscription.id === created.id,
    );
    assert.equal(failure?.payment, failed.latestPayment);
  });

  it("retries after a day, and recovers once a working method is in place", async () => {
    const { payer, created } = await failingSubscription();
    clock.advanceTo(FEB_28);
    await settleOn(
      created.id,
      (s) => s.status === "past_due",
      "failed renewal",
    );

    clock.advanceTo(FEB_28 + DAY_MS);
    await settleOn(
      created.id,
      () => chargesMade(created.id).length === 3,
      "first retry",
    );
    assert.equal((await GetSubscription(created.id)).status, "past_due");

    const working = await saveMethod(payer.customer, TOKENS.succeeds);
    await UpdateSubscriptionPaymentMethod(created.id, working, key());
    clock.advanceTo(FEB_28 + 4 * DAY_MS);
    const recovered = await settleOn(
      created.id,
      (s) => s.status === "active",
      "second retry",
    );

    assert.equal(
      recovered.currentPeriodStart,
      FEB_28,
      "recovering does not move the cycle",
    );
    assert.equal(recovered.currentPeriodEnd, MAR_31);
    assert.equal(chargesMade(created.id).length, 4);
    assert.equal(
      eventTypes(received, created.id).at(-1),
      "subscription.payment_succeeded",
    );
  });

  it("ends the subscription when the last retry fails", async () => {
    const { created } = await failingSubscription();
    const attempts = [
      FEB_28,
      FEB_28 + DAY_MS,
      FEB_28 + 4 * DAY_MS,
      FEB_28 + 11 * DAY_MS,
    ];

    for (const [index, at] of attempts.entries()) {
      clock.advanceTo(at);
      await settleOn(
        created.id,
        () => chargesMade(created.id).length === index + 2,
        `attempt ${index + 1}`,
      );
    }
    const ended = await settleOn(
      created.id,
      (s) => s.status === "canceled",
      "gave up",
    );

    assert.equal(ended.endReason, "payment_failed");
    assert.equal(ended.endedAt, FEB_28 + 11 * DAY_MS);
    const keys = chargesMade(created.id)
      .slice(1)
      .map((charge) => charge.idempotencyKey);
    assert.equal(
      new Set(keys).size,
      4,
      "each retry is a new attempt, not a replay of the decline",
    );
    assert.deepEqual(eventTypes(received, created.id).slice(-2), [
      "subscription.payment_failed",
      "subscription.canceled",
    ]);

    clock.advanceTo(APR_30);
    await quiesce();
    assert.equal(
      chargesMade(created.id).length,
      5,
      "an ended subscription is never charged again",
    );
  });
});

describe("[fallback] cancelling", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(JAN_31);
  const received = recordEvents();

  it("never charges again once cancelled now", async () => {
    const created = await subscribe(await newPayer());
    clock.advanceTo(JAN_31 + DAY_MS);
    const canceled = await CancelSubscription(created.id, key(), "now");
    assert.equal(canceled.endedAt, JAN_31 + DAY_MS);

    clock.advanceTo(MAR_31);
    await quiesce();
    assert.equal(chargesMade(created.id).length, 1);
    assert.equal((await GetSubscription(created.id)).status, "canceled");
  });

  it("runs out the paid period and ends at its end, without charging", async () => {
    const created = await subscribe(await newPayer());
    await CancelSubscription(created.id, key(), "period_end");

    clock.advanceTo(FEB_28 - 1);
    await quiesce();
    assert.equal((await GetSubscription(created.id)).status, "active");

    clock.advanceTo(FEB_28);
    const ended = await settleOn(
      created.id,
      (s) => s.status === "canceled",
      "period end",
    );
    assert.equal(ended.endedAt, FEB_28);
    assert.equal(ended.endReason, "requested");
    assert.equal(
      chargesMade(created.id).length,
      1,
      "the period end is not charged",
    );
    assert.equal(
      eventTypes(received, created.id).at(-1),
      "subscription.canceled",
    );
  });

  it("ends a trial set to end at period end without ever charging", async () => {
    const trialEnd = JAN_31 + TRIAL_DAYS * DAY_MS;
    const created = await subscribe(await newPayer(), { trialEnd });
    await CancelSubscription(created.id, key(), "period_end");

    clock.advanceTo(trialEnd);
    const ended = await settleOn(
      created.id,
      (s) => s.status === "canceled",
      "trial end",
    );
    assert.equal(ended.endedAt, trialEnd);
    assert.equal(chargesMade(created.id).length, 0);
  });
});
