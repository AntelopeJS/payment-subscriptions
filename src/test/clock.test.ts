import assert from "node:assert/strict";
import { GetClient } from "@antelopejs/interface-redis";
import { runTasks } from "@antelopejs/interface-redis-scheduler";
import { setTimeout as delay } from "node:timers/promises";
import {
  GetSubscription,
  type Subscription,
} from "@antelopejs/interface-subscriptions";

import { Runtime } from "../runtime";
import { ActiveClock } from "../index";
import {
  CLOCK_UNDER_TEST,
  SUITE_TIMEOUT,
  chargesMade,
  newPayer,
  subscribe,
  useManualClock,
  withTriggerStopped,
} from "./support";

const TRIAL_MS = 1500;
const WAIT_MS = 8_000;
const POLL_MS = 50;
const REDIS_TASKS = "SchedulerUtil.Tasks";
const TASK_PREFIX = "payment-subscriptions:";
const SCHEDULING_SLACK_MS = 50;
const START = Date.UTC(2027, 8, 1, 6);
const MONTH_LATER = Date.UTC(2027, 9, 1, 6);

async function waitFor<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  let value = await read();
  while (!isDone(value) && Date.now() < deadline) {
    await delay(POLL_MS);
    value = await read();
  }
  return value;
}

function isRenewed(subscription: Subscription): boolean {
  return (
    subscription.status === "active" && subscription.latestPayment !== undefined
  );
}

describe("[fallback] the renewal clock without Redis", function () {
  this.timeout(WAIT_MS * 2);

  before(function () {
    if (CLOCK_UNDER_TEST !== "polling") this.skip();
  });

  it("polls the database, because nothing implements Redis", () => {
    assert.equal(ActiveClock(), "polling");
  });

  it("renews on its own when a trial ends, with nobody calling", async () => {
    const created = await subscribe(await newPayer(), {
      trialEnd: Date.now() + TRIAL_MS,
    });

    const renewed = await waitFor(() => GetSubscription(created.id), isRenewed);

    assert.ok(
      isRenewed(renewed),
      `still ${renewed.status} after the trial ended`,
    );
    assert.equal(chargesMade(created.id).length, 1);
  });
});

describe("[fallback] the renewal clock with Redis wired, as published", function () {
  before(function () {
    if (CLOCK_UNDER_TEST !== "redis") this.skip();
  });

  it("uses the published scheduler through normal interface routing", () => {
    assert.equal(ActiveClock(), "redis");
  });
});

describe("[fallback] the Redis trigger through public routing", function () {
  this.timeout(WAIT_MS * 3);

  before(function () {
    if (CLOCK_UNDER_TEST !== "redis") this.skip();
  });

  async function taskScore(id: string): Promise<number | undefined> {
    const score = await (
      await GetClient()
    ).zscore(REDIS_TASKS, `${TASK_PREFIX}${id}`);
    return score === null ? undefined : Number(score);
  }

  it("leaves the database sweep an hour away, so Redis is what fires", () => {
    assert.ok(Runtime().settings.sweepIntervalMs >= 60 * 60 * 1000);
  });

  it("schedules a Redis task for the trial end, and Redis fires the renewal", async () => {
    const trialEnd = Date.now() + TRIAL_MS;
    const created = await subscribe(await newPayer(), { trialEnd });

    const score = await waitFor(
      () => taskScore(created.id),
      (value) => value !== undefined && value >= trialEnd - SCHEDULING_SLACK_MS,
    );
    assert.ok(score !== undefined, "a task must be waiting in Redis");
    assert.ok(
      Math.abs(score - trialEnd) <= SCHEDULING_SLACK_MS,
      `task due at ${score}, trial ends at ${trialEnd}`,
    );

    const renewed = await waitFor(() => GetSubscription(created.id), isRenewed);
    assert.ok(
      isRenewed(renewed),
      `still ${renewed.status}: Redis did not fire`,
    );
    assert.equal(chargesMade(created.id).length, 1);
  });

  it("still renews from the database when Redis has lost the task", async () => {
    const trialEnd = Date.now() + TRIAL_MS;
    const created = await subscribe(await newPayer(), { trialEnd });
    await waitFor(
      () => taskScore(created.id),
      (value) => value !== undefined && value >= trialEnd - SCHEDULING_SLACK_MS,
    );
    await (await GetClient()).zrem(REDIS_TASKS, `${TASK_PREFIX}${created.id}`);

    await delay(TRIAL_MS + 500);
    assert.equal(
      (await GetSubscription(created.id)).status,
      "trialing",
      "nothing fired without the task",
    );

    await Runtime().engine.sweep();
    assert.ok(
      isRenewed(await GetSubscription(created.id)),
      "the database sweep renews it",
    );
  });
});

describe("[fallback] the Redis trigger while the module is stopped", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  before(function () {
    if (CLOCK_UNDER_TEST !== "redis") this.skip();
  });

  it("renews nothing when the scheduler fires a due task after stop", async () => {
    const created = await subscribe(await newPayer());

    await withTriggerStopped(async () => {
      clock.advanceTo(MONTH_LATER);
      await (
        await GetClient()
      ).zadd(REDIS_TASKS, Date.now(), `${TASK_PREFIX}${created.id}`);
      await runTasks();

      assert.equal(
        (await GetSubscription(created.id)).currentPeriodStart,
        START,
        "a stopped module renews nothing",
      );
      assert.equal(chargesMade(created.id).length, 1);
    });
  });
});
