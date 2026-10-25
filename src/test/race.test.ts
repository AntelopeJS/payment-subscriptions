import assert from "node:assert/strict";
import {
  GetSubscription,
  type Subscription,
} from "@antelopejs/interface-subscriptions";

import { Engine } from "../engine";
import { Runtime } from "../runtime";
import { Decide } from "../transitions";
import { LoadRecord, MutateRecord } from "../records";
import {
  MINUTE_MS,
  SUITE_TIMEOUT,
  chargesMade,
  newPayer,
  provider,
  subscribe,
  useManualClock,
  withTriggerStopped,
} from "./support";

const START = Date.UTC(2027, 8, 1, 6);
const MONTH_LATER = Date.UTC(2027, 9, 1, 6);
const RACING_SUBSCRIPTIONS = 25;

function secondInstance(): Engine {
  const { settings, schedule } = Runtime();
  return new Engine(settings, schedule);
}

function attemptsFor(id: string, period: number): number {
  return provider
    .chargesFor(id)
    .filter((entry) => entry.idempotencyKey.endsWith(`:${period}:0`)).length;
}

describe("[fallback] several instances", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  it("charges a renewal once when two instances race on it", async () => {
    const created: Subscription[] = [];
    for (let index = 0; index < RACING_SUBSCRIPTIONS; index += 1) {
      created.push(await subscribe(await newPayer()));
    }
    const first = Runtime().engine;
    const second = secondInstance();
    const lostBefore = first.stats.claimsLost;

    clock.advanceTo(MONTH_LATER);
    await Promise.all(
      created.flatMap(({ id }) => [first.process(id), second.process(id)]),
    );

    for (const { id } of created) {
      assert.equal(
        (await GetSubscription(id)).currentPeriodStart,
        MONTH_LATER,
        `${id} renewed`,
      );
      assert.equal(
        chargesMade(id).length,
        2,
        `${id} charged once for the renewal`,
      );
      assert.equal(
        attemptsFor(id, 1),
        1,
        `${id}: the losing instance never reached the provider`,
      );
    }
    const lost = first.stats.claimsLost - lostBefore + second.stats.claimsLost;
    assert.ok(
      lost > 0,
      "the instances must actually have contended for the same renewals",
    );
  });

  it("replays the original charge when an instance takes over an expired claim", async () => {
    const created = await subscribe(await newPayer());

    await withTriggerStopped(async () => {
      clock.advanceTo(MONTH_LATER);
      const due = (await LoadRecord(created.id))!;
      const crashed = (await MutateRecord(due, {
        leaseOwner: "an-instance-that-dies-mid-charge",
        leaseUntil: MONTH_LATER + Runtime().settings.leaseMs,
      }))!;
      const crashedCharge = await Runtime().engine.perform(
        crashed,
        Decide(crashed, MONTH_LATER),
      );

      const survivor = secondInstance();
      await survivor.process(created.id);
      assert.equal(
        (await GetSubscription(created.id)).currentPeriodStart,
        START,
        "nobody may take a claim over before it expires",
      );

      clock.advance(Runtime().settings.leaseMs + MINUTE_MS);
      await survivor.process(created.id);
      const renewed = await GetSubscription(created.id);

      assert.equal(renewed.currentPeriodStart, MONTH_LATER);
      assert.equal(
        renewed.latestPayment,
        crashedCharge.payment,
        "the takeover found the original charge",
      );
      assert.equal(
        attemptsFor(created.id, 1),
        2,
        "both instances asked the provider",
      );
      assert.equal(
        chargesMade(created.id).length,
        2,
        "but the payer was charged once for the renewal",
      );
    });
  });
});

describe("[fallback] instances that fall behind", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  it("ignores an outcome that arrives after another instance has moved the renewal on", async () => {
    const created = await subscribe(await newPayer());
    await Runtime().engine.drain();

    await withTriggerStopped(async () => {
      clock.advanceTo(MONTH_LATER);
      const slow = secondInstance();
      const due = (await LoadRecord(created.id))!;
      const decided = Decide(due, MONTH_LATER);
      provider.setUnreachable(true);
      const unreachable = await slow.perform(due, decided);
      provider.setUnreachable(false);

      await Runtime().engine.process(created.id);
      await slow.commit(due, decided, unreachable);
      clock.advance(Runtime().settings.errorBackoffMs + MINUTE_MS);
      await Runtime().engine.sweep();

      const after = await GetSubscription(created.id);
      assert.equal(
        after.currentPeriodStart,
        MONTH_LATER,
        "renewed once, not twice",
      );
      assert.equal(
        chargesMade(created.id).length,
        2,
        "the next period is not charged early",
      );
    });
  });

  it("renews from the database alone, with no trigger and nothing in memory", async () => {
    const created = await subscribe(await newPayer());
    await Runtime().engine.drain();

    await withTriggerStopped(async () => {
      clock.advanceTo(MONTH_LATER);
      const fresh = secondInstance();
      await fresh.sweep();

      const renewed = await GetSubscription(created.id);
      assert.equal(renewed.currentPeriodStart, MONTH_LATER);
      assert.equal(renewed.status, "active");
      assert.ok(
        fresh.stats.claimed >= 1,
        "the fresh engine claimed the renewal itself",
      );
      assert.equal(chargesMade(created.id).length, 2);
    });
  });
});
