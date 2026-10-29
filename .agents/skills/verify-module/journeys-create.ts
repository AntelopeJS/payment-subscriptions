import { equal, exitIs, has, type Journey } from "@antelopejs/tooling-configs/verify";

import {
  AMOUNT,
  DAY_MS,
  DECLINES,
  SUCCEEDS,
  answer,
  call,
  collection,
  create,
  failure,
  mongosh,
  prepare,
  request,
  startStack,
  stored,
  storedCount,
  type Overrides,
  type Sub,
} from "./stack.ts";

export const createJourneys = {
    "create-and-read": {
      title: "a created subscription is charged once, read back through the interface and found as one record in MongoDB",
      entryPoint: "`CreateSubscription`, `GetSubscription` and `ListSubscriptions` of the subscriptions interface",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const { sub, folder } = await create(context, stack, { name: "CreateSubscription", prepared: prepared, key: "create-1" });
        const days = (sub.currentPeriodEnd - sub.currentPeriodStart) / DAY_MS;
        context.expect(folder, [
          has("the id is a subscription id", sub.id, /^sub_[0-9a-f]+$/),
          equal("the status is active", sub.status, "active"),
          equal("the interval is month", [sub.interval, sub.intervalCount], ["month", 1]),
          equal("the amount is unchanged", sub.amount, AMOUNT),
          equal("the customer and method are unchanged", [sub.customer, sub.paymentMethod], [prepared.customer, prepared.method]),
          equal("one month long", days >= 28 && days <= 31, true),
          equal("the first period was charged", sub.latestPayment !== undefined, true),
          equal("not set to cancel", sub.cancelAtPeriodEnd, false),
        ]);
        const got = await call(context, stack, "GetSubscription", "GetSubscription", [sub.id]);
        context.expect(got.folder, [equal("GetSubscription answers the same subscription", [answer<Sub>(got).value?.id, answer<Sub>(got).value?.status], [sub.id, "active"])]);
        const list = await call(context, stack, "ListSubscriptions", "ListSubscriptions", [prepared.customer]);
        context.expect(list.folder, [equal("the customer has exactly this subscription", (answer<Sub[]>(list).value ?? []).map((entry) => entry.id), [sub.id])]);
        const doc = await stored(context, "MongoDB record", sub.id);
        context.expect(doc.folder, [
          equal("the record is live and active", [doc.record?.phase, doc.record?.status], ["live", "active"]),
          equal("the record holds customer, method and amount", [doc.record?.customer, doc.record?.paymentMethod, doc.record?.amount], [prepared.customer, prepared.method, AMOUNT]),
          equal("the record holds the charge", doc.record?.latestPayment, sub.latestPayment),
        ]);
        const total = await storedCount(context, "MongoDB record count");
        context.expect(total.folder, [equal("exactly one record", total.count, "1")]);
        const stopped = await context.stop("SIGINT", stack.app);
        context.expect(stopped.folder, [exitIs(stopped, 130), has("the polling clock is chosen without Redis", stopped.stdout, /renewal clock is polling/)]);
      },
    },
    "idempotent-create": {
      title: "creating twice with one idempotency key yields one subscription and one record; another key yields another",
      entryPoint: "`CreateSubscription(request, idempotencyKey)` called twice",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const first = await create(context, stack, { name: "first create", prepared: prepared, key: "dup-key" });
        const again = await create(context, stack, { name: "second create with the same key", prepared: prepared, key: "dup-key" });
        context.expect(again.folder, [equal("the same key answers the same subscription", [again.sub.id, again.sub.latestPayment], [first.sub.id, first.sub.latestPayment])]);
        const one = await storedCount(context, "MongoDB record count after the replay");
        context.expect(one.folder, [equal("one record", one.count, "1")]);
        const other = await create(context, stack, { name: "create with another key", prepared: prepared, key: "other-key", overrides: { reference: "verify-second" } });
        context.expect(other.folder, [equal("another key makes another subscription", other.sub.id === first.sub.id, false)]);
        const two = await storedCount(context, "MongoDB record count after the second key");
        context.expect(two.folder, [equal("two records", two.count, "2")]);
        const list = await call(context, stack, "ListSubscriptions", "ListSubscriptions", [prepared.customer]);
        context.expect(list.folder, [equal("the customer lists both", (answer<Sub[]>(list).value ?? []).map((entry) => entry.id).sort(), [first.sub.id, other.sub.id].sort())]);
        const indexes = await mongosh(context, "MongoDB indexes of the collection", `JSON.stringify(${collection()}.getIndexes().map((index) => Object.keys(index.key).join(",")))`);
        context.expect(indexes.folder, [has("the customer lookup is indexed", indexes.stdout, /_instance,customer"/), has("the due-date poll is indexed", indexes.stdout, /_instance,dueAt"/)]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "empty-and-unknown": {
      title: "a customer without subscriptions lists none, and an unknown subscription id is a SubscriptionNotFoundError",
      entryPoint: "`ListSubscriptions` and `GetSubscription` on an empty database",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const list = await call(context, stack, "ListSubscriptions of an unknown customer", "ListSubscriptions", ["cus_nobody"]);
        context.expect(list.folder, [equal("the list is empty", answer<Sub[]>(list).value, [])]);
        const missing = await call(context, stack, "GetSubscription of an unknown id", "GetSubscription", ["sub_missing"]);
        context.expect(missing.folder, [equal("the call was rejected", answer(missing).ok, false), has("the rejection is a SubscriptionNotFoundError", failure(missing), /^SubscriptionNotFoundError: No such subscription: sub_missing/)]);
        const total = await storedCount(context, "MongoDB record count");
        context.expect(total.folder, [equal("nothing is stored", total.count, "0")]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "validation-errors": {
      title: "an invalid request is rejected with InvalidSubscriptionRequestError naming the rule, charges nothing and stores nothing",
      entryPoint: "`CreateSubscription` with an invalid request",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const cases: [string, Overrides, RegExp][] = [
          ["an unknown interval", { interval: "hour" }, /interval must be one of day, week, month, year/],
          ["a zero amount", { amount: { value: 0, currency: "EUR" } }, /amount must be a positive integer of minor units/],
          ["a lowercase currency", { amount: { value: 100, currency: "eur" } }, /amount\.currency must be an uppercase ISO-4217 code/],
          ["a fractional interval count", { intervalCount: 1.5 }, /intervalCount must be a positive integer/],
          ["a trial in the past", { trialEnd: Date.now() - DAY_MS }, /trialEnd must be a finite timestamp in the future/],
          ["a trial and an anchor together", { trialEnd: Date.now() + DAY_MS, billingAnchor: Date.now() + DAY_MS }, /mutually exclusive/],
          ["an empty reference", { reference: "" }, /reference must be a non-empty string/],
        ];
        for (const [label, overrides, message] of cases) {
          const rejected = await call(context, stack, `create with ${label}`, "CreateSubscription", [request(prepared, overrides), `invalid-${label}`]);
          context.expect(rejected.folder, [equal(`${label} was rejected`, answer(rejected).ok, false), has(`${label} names its rule`, failure(rejected), message)]);
        }
        const total = await storedCount(context, "MongoDB record count");
        context.expect(total.folder, [equal("nothing is stored", total.count, "0")]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "trial-and-anchor": {
      title: "a trial or a billing anchor defers the first charge: the subscription starts trialing or active, unpaid, with its first period ending at the start",
      entryPoint: "`CreateSubscription` with `trialEnd` or `billingAnchor`",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const trialEnd = Date.now() + 60 * 60 * 1000;
        const trial = await create(context, stack, { name: "create with a trial", prepared: prepared, key: "trial-key", overrides: { trialEnd } });
        context.expect(trial.folder, [
          equal("the subscription is trialing", trial.sub.status, "trialing"),
          equal("the trial end is kept", trial.sub.trialEnd, trialEnd),
          equal("the first period ends when the trial does", trial.sub.currentPeriodEnd, trialEnd),
          equal("nothing was charged", trial.sub.latestPayment, undefined),
        ]);
        const anchor = Date.now() + 2 * 60 * 60 * 1000;
        const anchored = await create(context, stack, { name: "create with an anchor", prepared: prepared, key: "anchor-key", overrides: { reference: "verify-anchor", billingAnchor: anchor } });
        context.expect(anchored.folder, [
          equal("an anchored subscription is active", anchored.sub.status, "active"),
          equal("it has no trial", anchored.sub.trialEnd, undefined),
          equal("the first period ends at the anchor", anchored.sub.currentPeriodEnd, anchor),
          equal("nothing was charged", anchored.sub.latestPayment, undefined),
        ]);
        const doc = await stored(context, "MongoDB trial record", trial.sub.id);
        context.expect(doc.folder, [equal("the record is trialing with the same end", [doc.record?.status, doc.record?.trialEnd, doc.record?.latestPayment], ["trialing", trialEnd, null])]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "declined-initial": {
      title: "a first charge the provider declines raises SubscriptionPaymentError and leaves no active subscription",
      entryPoint: "`CreateSubscription` on a method the provider declines off-session",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, DECLINES);
        const declined = await call(context, stack, "create on a declining method", "CreateSubscription", [request(prepared), "declined-key"]);
        context.expect(declined.folder, [equal("the call was rejected", answer(declined).ok, false), has("the rejection is a SubscriptionPaymentError", failure(declined), /^SubscriptionPaymentError: The first period could not be charged/)]);
        const list = await call(context, stack, "ListSubscriptions", "ListSubscriptions", [prepared.customer]);
        context.expect(list.folder, [equal("the customer has no subscription", answer<Sub[]>(list).value, [])]);
        const replay = await call(context, stack, "replay the declined key", "CreateSubscription", [request(prepared), "declined-key"]);
        context.expect(replay.folder, [has("the replay is refused the same way", failure(replay), /^SubscriptionPaymentError/)]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "period-length": {
      title: "intervals and interval counts set the period length: 3 days, 2 weeks, 1 month, 1 year",
      entryPoint: "`CreateSubscription` with `interval` and `intervalCount`",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const lengths: [string, string, number, (days: number) => boolean][] = [
          ["day", "3 days", 3, (days) => days === 3],
          ["week", "2 weeks", 2, (days) => days === 14],
          ["month", "1 month", 1, (days) => days >= 28 && days <= 31],
          ["year", "1 year", 1, (days) => days === 365 || days === 366],
        ];
        for (const [interval, label, intervalCount, fits] of lengths) {
          const { sub, folder } = await create(context, stack, { name: `create every ${label}`, prepared: prepared, key: `period-${interval}`, overrides: { interval, intervalCount: interval === "day" ? 3 : intervalCount, reference: `verify-${interval}` } });
          const days = (sub.currentPeriodEnd - sub.currentPeriodStart) / DAY_MS;
          context.expect(folder, [equal(`${label} long`, fits(days), true), equal("the count is kept", sub.intervalCount, interval === "day" ? 3 : intervalCount)]);
        }
        await context.stop("SIGINT", stack.app);
      },
    },
} satisfies Record<string, Journey>;
