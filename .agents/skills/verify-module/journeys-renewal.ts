import { equal, exitIs, has, type Journey } from "@antelopejs/tooling-configs/verify";

import {
  DECLINES,
  SANDBOX_KEYS,
  SUCCEEDS,
  answer,
  call,
  create,
  eventsOf,
  launch,
  prepare,
  prepareStack,
  sleep,
  startStack,
  stored,
  waitFor,
  type Sub,
} from "./stack.ts";

export const renewalJourneys = {
    "trial-renewal": {
      title: "when the trial ends the clock charges the saved method: the subscription turns active, is paid, and the charge is announced",
      entryPoint: "the renewal clock of `ajs project dev`, after `CreateSubscription` with a short `trialEnd`",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const { sub } = await create(context, stack, { name: "create with a 2 s trial", prepared: prepared, key: "trial-renewal-create", overrides: { trialEnd: Date.now() + 2000 } });
        context.expect(stack.app.folder, [equal("it starts trialing", sub.status, "trialing")]);
        const active = await waitFor(context, stack, "wait for active", sub.id, "active");
        context.expect(stack.app.folder, [
          equal("the trial turned active", active?.status, "active"),
          equal("the charge is recorded", active?.latestPayment !== undefined, true),
          equal("the first period starts at the trial end", active?.currentPeriodStart, sub.trialEnd),
        ]);
        const doc = await stored(context, "MongoDB record after the charge", sub.id);
        context.expect(doc.folder, [equal("the record is active and paid", [doc.record?.status, doc.record?.latestPayment], ["active", active?.latestPayment ?? null])]);
        const seen = await eventsOf(context, stack, "events");
        context.expect(seen.folder, [equal("the charge was announced", seen.events.map((event) => event.type).includes("subscription.payment_succeeded"), true)]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "failed-renewal-ends": {
      title: "a declined renewal makes the subscription past_due, is retried on the configured delays, then ends with reason payment_failed",
      entryPoint: "the renewal clock with `retryDelaysMs: [500, 500]` and a method the provider declines off-session",
      async run(context) {
        const stack = await startStack(context, "ajs project dev", { config: { retryDelaysMs: [500, 500] } });
        const prepared = await prepare(context, stack, DECLINES);
        const { sub } = await create(context, stack, { name: "create with a 1.5 s trial", prepared: prepared, key: "failed-create", overrides: { trialEnd: Date.now() + 1500 } });
        const late = await waitFor(context, stack, "wait for past_due", sub.id, "past_due");
        context.expect(stack.app.folder, [equal("the first decline makes it past_due", late?.status, "past_due")]);
        const ended = await waitFor(context, stack, "wait for canceled", sub.id, "canceled");
        context.expect(stack.app.folder, [equal("after the retries it ends", [ended?.status, ended?.endReason], ["canceled", "payment_failed"])]);
        const doc = await stored(context, "MongoDB record after the end", sub.id);
        context.expect(doc.folder, [equal("the record is canceled for payment_failed", [doc.record?.status, doc.record?.endReason], ["canceled", "payment_failed"])]);
        const seen = await eventsOf(context, stack, "events");
        const types = seen.events.map((event) => event.type);
        context.expect(seen.folder, [
          equal("a payment_failed event for the first charge and each retry", types.filter((type) => type === "subscription.payment_failed").length, 3),
          equal("the subscription ending was announced last", types[types.length - 1], "subscription.canceled"),
        ]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "survives-restart": {
      title: "a subscription created before a restart is still there afterwards and is charged when its trial ends after the restart",
      entryPoint: "Ctrl+C on `ajs project dev`, then `ajs project dev` again",
      async run(context) {
        const prepared = await prepareStack(context);
        const first = await launch(context, "first ajs project dev", prepared);
        const customer = await prepare(context, first, SUCCEEDS);
        const { sub } = await create(context, first, { name: "create with a 10 s trial", prepared: customer, key: "restart-create", overrides: { trialEnd: Date.now() + 10_000 } });
        const stopped = await context.stop("SIGINT", first.app);
        context.expect(stopped.folder, [exitIs(stopped, 130)]);
        const down = await stored(context, "MongoDB record while the module is down", sub.id);
        context.expect(down.folder, [equal("the record waits in MongoDB", [down.record?.status, down.record?.latestPayment], ["trialing", null])], { critical: true });
        const second = await launch(context, "second ajs project dev", prepared);
        const again = await prepare(context, second, SUCCEEDS);
        context.expect(second.app.folder, [equal("the in-memory test provider was refilled with the same ids", [again.customer, again.method], [customer.customer, customer.method])], { critical: true });
        const got = await call(context, second, "GetSubscription after restart", "GetSubscription", [sub.id]);
        context.expect(got.folder, [equal("the same subscription is read back", [answer<Sub>(got).value?.id, answer<Sub>(got).value?.customer], [sub.id, customer.customer])]);
        const active = await waitFor(context, second, "wait for active after restart", sub.id, "active");
        context.expect(second.app.folder, [equal("the new process charged it", [active?.status, active?.latestPayment !== undefined], ["active", true])]);
        const seen = await eventsOf(context, second, "events after restart");
        context.expect(seen.folder, [equal("the new process announced the charge", seen.events.map((event) => event.type).includes("subscription.payment_succeeded"), true)]);
        await context.stop("SIGINT", second.app);
      },
    },
    "redis-clock": {
      title: "with a Redis scheduler wired, each renewal is one task in Redis at its due time, and cancelling removes it",
      entryPoint: "`ajs project dev` with `@antelopejs/redis` wired next to the module",
      async run(context) {
        const stack = await startStack(context, "ajs project dev", { redis: true });
        const prepared = await prepare(context, stack, SUCCEEDS);
        const trialEnd = Date.now() + 60 * 60 * 1000;
        const { sub } = await create(context, stack, { name: "create with a 1 h trial", prepared: prepared, key: "redis-create", overrides: { trialEnd } });
        await sleep(500);
        const queued = await context.native("redis-cli ZRANGE", "redis", ["redis-cli", "ZRANGE", "SchedulerUtil.Tasks", "0", "-1", "WITHSCORES"]);
        const [member, score] = queued.stdout.trim().split("\n");
        context.expect(queued.folder, [
          equal("one task, for this subscription", member, `payment-subscriptions:${sub.id}`),
          equal("due at the trial end", Math.abs(Number(score) - trialEnd) < 5000, true),
        ]);
        const canceled = await call(context, stack, "cancel now", "CancelSubscription", [sub.id, "redis-cancel", "now"]);
        context.expect(canceled.folder, [equal("canceled", answer<Sub>(canceled).value?.status, "canceled")], { critical: true });
        await sleep(500);
        const emptied = await context.native("redis-cli ZRANGE after cancel", "redis", ["redis-cli", "ZRANGE", "SchedulerUtil.Tasks", "0", "-1"]);
        context.expect(emptied.folder, [equal("the task is removed", emptied.stdout.trim(), "")]);
        const stopped = await context.stop("SIGINT", stack.app);
        context.expect(stopped.folder, [has("the Redis clock is chosen", stopped.stdout, /renewal clock is redis/)]);
      },
    },
    "event-delivery": {
      title: "creating and cancelling announce subscription.created, payment_succeeded and canceled, in order, with the payment id, and the outbox empties",
      entryPoint: "`SubscriptionEvents.register` handler of a consumer module",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const before = await eventsOf(context, stack, "events before anything");
        context.expect(before.folder, [equal("no event yet", before.events, [])], { critical: true });
        const { sub } = await create(context, stack, { name: "create", prepared: prepared, key: "events-create" });
        const canceled = await call(context, stack, "cancel now", "CancelSubscription", [sub.id, "events-cancel", "now"]);
        context.expect(canceled.folder, [equal("canceled", answer<Sub>(canceled).value?.status, "canceled")], { critical: true });
        await sleep(800);
        const seen = await eventsOf(context, stack, "events");
        const types = seen.events.map((event) => event.type);
        const paid = seen.events.find((event) => event.type === "subscription.payment_succeeded");
        context.expect(seen.folder, [
          equal("created, paid, canceled", types, ["subscription.created", "subscription.payment_succeeded", "subscription.canceled"]),
          equal("every event carries its subscription", seen.events.every((event) => event.subscription.id === sub.id), true),
          equal("the payment event names the charge", paid?.payment, sub.latestPayment),
          equal("the event ids are unique", new Set(seen.events.map((event) => event.id)).size, 3),
        ]);
        const doc = await stored(context, "MongoDB record outbox", sub.id);
        context.expect(doc.folder, [equal("every event was delivered: the outbox is empty", doc.record?.outbox, [])]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "retry-policy": {
      title: "retryDelaysMs [] ends a subscription at the first declined renewal, with no past_due period",
      entryPoint: "the renewal clock with `retryDelaysMs: []`",
      async run(context) {
        const stack = await startStack(context, "ajs project dev", { config: { retryDelaysMs: [] } });
        const prepared = await prepare(context, stack, DECLINES);
        const { sub } = await create(context, stack, { name: "create with a 1.5 s trial", prepared: prepared, key: "policy-create", overrides: { trialEnd: Date.now() + 1500 } });
        const ended = await waitFor(context, stack, "wait for canceled", sub.id, "canceled");
        context.expect(stack.app.folder, [equal("the first decline ends it", [ended?.status, ended?.endReason], ["canceled", "payment_failed"])]);
        const seen = await eventsOf(context, stack, "events");
        const types = seen.events.map((event) => event.type);
        context.expect(seen.folder, [equal("one decline, then the end", types.filter((type) => type !== "subscription.created"), ["subscription.payment_failed", "subscription.canceled"])]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "provider-sandbox": {
      title: "a real Stripe sandbox charge: not verified without the sandbox keys",
      entryPoint: "`@antelopejs/stripe` in test mode wired next to the module",
      run(context) {
        const missing = SANDBOX_KEYS.filter((key) => !process.env[key]);
        if (missing.length > 0) context.notVerified(`Stripe sandbox keys missing from the environment: ${missing.join(", ")}; every other journey ran against the in-repo test provider`);
        return context.notVerified("a Stripe-backed fixture is not written yet: add @antelopejs/stripe as a devDependency and a sandbox journey");
      },
    },
} satisfies Record<string, Journey>;
