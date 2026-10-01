import assert from "node:assert/strict";
import {
  CancelSubscription,
  GetSubscription,
  UpdateSubscriptionPaymentMethod,
} from "@antelopejs/interface-subscriptions";

import { Engine } from "../engine";
import { Runtime } from "../runtime";
import { LoadRecord } from "../records";
import { Decide } from "../transitions";
import type { ProviderSchedule } from "../schedule";
import {
  DAY_MS,
  HOUR_MS,
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
  subscribe,
  useManualClock,
  withTriggerStopped,
} from "./support";

const START = Date.UTC(2028, 1, 10, 8);
const MONTH_LATER = Date.UTC(2028, 2, 10, 8);

describe("[fallback] cancelling while money is moving", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);
  const received = recordEvents();

  it("records and reports a charge that lands after a cancellation", async () => {
    const created = await subscribe(await newPayer());
    await Runtime().engine.drain();

    await withTriggerStopped(async () => {
      clock.advanceTo(MONTH_LATER);
      const { engine } = Runtime();
      const due = (await LoadRecord(created.id))!;
      const decided = Decide(due, MONTH_LATER);
      const outcome = await engine.perform(due, decided);

      await CancelSubscription(created.id, key(), "now");
      await engine.commit(due, decided, outcome);
      await quiesce();

      const ended = await GetSubscription(created.id);
      assert.equal(ended.status, "canceled", "the cancellation stands");
      assert.equal(
        ended.latestPayment,
        outcome.payment,
        "the charge is on record",
      );
      assert.equal(
        ended.currentPeriodStart,
        START,
        "an ended subscription does not renew",
      );
      assert.ok(
        eventTypes(received, created.id).includes(
          "subscription.payment_succeeded",
        ),
        "the charge is reported, so the merchant can refund it",
      );
    });
  });

  it("follows a charge that was still settling when it was cancelled", async () => {
    const payer = await newPayer();
    const created = await subscribe(payer);
    const settling = await saveMethod(payer.customer, TOKENS.settlesLater);
    await UpdateSubscriptionPaymentMethod(created.id, settling, key());
    clock.advanceTo(MONTH_LATER);
    await quiesce();
    const pending = (await GetSubscription(created.id)).latestPayment!;
    assert.equal(provider.paymentStatus(pending), "pending");

    await CancelSubscription(created.id, key(), "now");
    for (const _read of [1, 2]) {
      clock.advance(HOUR_MS);
      await quiesce();
    }

    assert.equal(provider.paymentStatus(pending), "succeeded");
    assert.equal(
      eventTypes(received, created.id).at(-1),
      "subscription.payment_succeeded",
    );
    assert.equal((await GetSubscription(created.id)).status, "canceled");
    assert.equal(chargesMade(created.id).length, 2);
  });
});

describe("[fallback] the provider schedule seam", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  it("is released when the subscription ends because payment kept failing", async () => {
    const payer = await newPayer();
    const created = await subscribe(payer);
    const declining = await saveMethod(
      payer.customer,
      TOKENS.declinesOffSession,
    );
    await UpdateSubscriptionPaymentMethod(created.id, declining, key());
    await Runtime().engine.drain();

    const released: string[] = [];
    const { settings, schedule } = Runtime();
    const spy: ProviderSchedule = {
      register: (subscription, account) =>
        schedule.register(subscription, account),
      charge: (charge) => schedule.charge(charge),
      release: async (subscription) => void released.push(subscription.id),
    };

    await withTriggerStopped(async () => {
      const engine = new Engine(settings, spy);
      for (const at of [
        MONTH_LATER,
        MONTH_LATER + DAY_MS,
        MONTH_LATER + 4 * DAY_MS,
        MONTH_LATER + 11 * DAY_MS,
      ]) {
        clock.advanceTo(at);
        await engine.process(created.id);
      }
    });

    const ended = await GetSubscription(created.id);
    assert.equal(ended.status, "canceled");
    assert.equal(ended.endReason, "payment_failed");
    assert.deepEqual(released, [created.id]);
  });
});
