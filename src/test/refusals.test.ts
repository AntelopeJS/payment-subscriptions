import assert from "node:assert/strict";
import { DetachPaymentMethod } from "@antelopejs/interface-payment";
import {
  CancelSubscription,
  CreateSubscription,
  GetSubscription,
  InvalidSubscriptionRequestError,
  UpdateSubscriptionPaymentMethod,
} from "@antelopejs/interface-subscriptions";

import { Engine } from "../engine";
import { Runtime } from "../runtime";
import { LoadRecord } from "../records";
import { Decide } from "../transitions";
import type { ProviderSchedule } from "../schedule";
import {
  DAY_MS,
  MINUTE_MS,
  SUITE_TIMEOUT,
  TOKENS,
  chargesMade,
  key,
  newPayer,
  provider,
  quiesce,
  recordEvents,
  saveMethod,
  settleOn,
  subscribe,
  useManualClock,
  withTriggerStopped,
} from "./support";

const START = Date.UTC(2028, 4, 15, 10);
const MONTH_LATER = Date.UTC(2028, 5, 15, 10);
const RETRY_OFFSETS = [0, DAY_MS, 4 * DAY_MS, 11 * DAY_MS];

describe("[fallback] a provider that refuses the charge outright", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);
  const received = recordEvents();

  it("treats a removed payment method as a declined renewal, not an outage", async () => {
    const payer = await newPayer();
    const created = await subscribe(payer);
    await DetachPaymentMethod(payer.paymentMethod, key());

    clock.advanceTo(MONTH_LATER);
    const failed = await settleOn(
      created.id,
      (s) => s.status === "past_due",
      "refused renewal",
    );
    assert.equal(failed.currentPeriodStart, MONTH_LATER);
    assert.equal(failed.latestPayment, created.latestPayment);
    const failure = received.find(
      (event) =>
        event.subscription.id === created.id &&
        event.type === "subscription.payment_failed",
    );
    assert.ok(failure, "the refusal is reported");
    assert.equal(failure.payment, undefined, "no charge was made to point at");
  });

  it("ends it under the retry policy, reporting each refusal once", async () => {
    const payer = await newPayer();
    const created = await subscribe(payer);
    await DetachPaymentMethod(payer.paymentMethod, key());

    for (const offset of RETRY_OFFSETS) {
      clock.advanceTo(MONTH_LATER + offset);
      await quiesce();
    }
    const ended = await GetSubscription(created.id);
    assert.equal(ended.status, "canceled");
    assert.equal(ended.endReason, "payment_failed");
    const failures = received.filter(
      (event) =>
        event.subscription.id === created.id &&
        event.type === "subscription.payment_failed",
    );
    assert.equal(failures.length, RETRY_OFFSETS.length);
    assert.equal(
      new Set(failures.map((event) => event.id)).size,
      failures.length,
    );
  });

  it("refuses a subscription on a removed method, and refuses its replay the same way", async () => {
    const payer = await newPayer();
    await DetachPaymentMethod(payer.paymentMethod, key());
    const request = {
      reference: `refused-${payer.customer}`,
      customer: payer.customer,
      paymentMethod: payer.paymentMethod,
      amount: { value: 1900, currency: "EUR" },
      interval: "month" as const,
    };
    const idempotencyKey = key();

    await assert.rejects(
      CreateSubscription(request, idempotencyKey),
      InvalidSubscriptionRequestError,
    );
    await assert.rejects(
      CreateSubscription(request, idempotencyKey),
      InvalidSubscriptionRequestError,
    );
  });
});

describe("[fallback] a charge in doubt", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  afterEach(() => {
    provider.setUnreachable(false);
    provider.setLosesResponses(false);
  });

  it("is not retried once the subscription has been cancelled", async () => {
    const created = await subscribe(await newPayer());
    await Runtime().engine.drain();

    await withTriggerStopped(async () => {
      clock.advanceTo(MONTH_LATER);
      const { engine } = Runtime();
      const due = (await LoadRecord(created.id))!;
      const decided = Decide(due, MONTH_LATER);
      provider.setUnreachable(true);
      const unreachable = await engine.perform(due, decided);
      provider.setUnreachable(false);

      await CancelSubscription(created.id, key(), "now");
      await engine.commit(due, decided, unreachable);
      clock.advance(Runtime().settings.errorBackoffMs + MINUTE_MS);
      await quiesce();

      assert.equal((await GetSubscription(created.id)).status, "canceled");
      assert.equal(
        chargesMade(created.id).length,
        1,
        "nothing is charged after the cancellation",
      );
    });
  });

  it("is retried with the method it was made with, even after the method changes", async () => {
    const payer = await newPayer();
    const created = await subscribe(payer);
    const original = payer.paymentMethod;

    provider.setLosesResponses(true);
    clock.advanceTo(MONTH_LATER);
    await quiesce();
    provider.setLosesResponses(false);
    assert.equal(
      (await GetSubscription(created.id)).currentPeriodEnd,
      MONTH_LATER,
    );

    const replacement = await saveMethod(payer.customer, TOKENS.succeeds);
    await UpdateSubscriptionPaymentMethod(created.id, replacement, key());
    clock.advance(Runtime().settings.errorBackoffMs + MINUTE_MS);
    const renewed = await settleOn(
      created.id,
      (s) => s.currentPeriodStart === MONTH_LATER,
      "in-doubt retry",
    );

    const charges = chargesMade(created.id);
    assert.equal(charges.length, 2, "the lost charge is found, not repeated");
    assert.equal(charges[1].request.paymentMethod, original);
    assert.equal(renewed.paymentMethod, replacement);

    clock.advanceTo(renewed.currentPeriodEnd);
    await settleOn(
      created.id,
      () => chargesMade(created.id).length === 3,
      "next renewal",
    );
    assert.equal(chargesMade(created.id)[2].request.paymentMethod, replacement);
  });
});

describe("[fallback] a subscription that keeps failing to process", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  it("does not hold up the renewals queued behind it", async () => {
    const stuck = await subscribe(await newPayer());
    clock.advance(DAY_MS);
    const healthy = await subscribe(await newPayer());
    await Runtime().engine.drain();

    const { settings, schedule } = Runtime();
    const broken: ProviderSchedule = {
      register: (subscription, account) =>
        schedule.register(subscription, account),
      charge: (charge) => {
        if (charge.subscription.id === stuck.id) throw new TypeError("broken");
        return schedule.charge(charge);
      },
      release: (subscription, reference, account) =>
        schedule.release(subscription, reference, account),
    };

    await withTriggerStopped(async () => {
      const engine = new Engine({ ...settings, batchSize: 1 }, broken);
      clock.advanceTo(healthy.currentPeriodEnd);
      for (const _sweep of [1, 2, 3]) await engine.sweep();

      assert.equal(
        (await GetSubscription(healthy.id)).currentPeriodStart,
        healthy.currentPeriodEnd,
      );
      assert.equal(
        (await GetSubscription(stuck.id)).currentPeriodStart,
        stuck.currentPeriodStart,
      );
    });
  });
});
