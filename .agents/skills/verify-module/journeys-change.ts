import { equal, has, type Journey } from "@antelopejs/tooling-configs/verify";

import {
  SUCCEEDS,
  answer,
  call,
  create,
  failure,
  prepare,
  sleep,
  startStack,
  stored,
  type Sub,
} from "./stack.ts";

export const changeJourneys = {
    "cancel-now": {
      title: "cancelling now ends the subscription at once with reason requested and keeps it from being charged again",
      entryPoint: "`CancelSubscription(id, key, \"now\")`",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const { sub } = await create(context, stack, { name: "create", prepared: prepared, key: "cancel-now-create" });
        const canceled = await call(context, stack, "cancel now", "CancelSubscription", [sub.id, "cancel-now-1", "now"]);
        const after = answer<Sub>(canceled).value;
        context.expect(canceled.folder, [
          equal("the call succeeded", answer(canceled).ok, true),
          equal("the status is canceled", after?.status, "canceled"),
          equal("the reason is requested", after?.endReason, "requested"),
          equal("it ended just now", after?.endedAt !== undefined && Math.abs(Date.now() - after.endedAt) < 60_000, true),
          equal("the paid charge is unchanged", after?.latestPayment, sub.latestPayment),
        ]);
        const doc = await stored(context, "MongoDB record after cancel", sub.id);
        context.expect(doc.folder, [equal("the record is canceled with its reason", [doc.record?.status, doc.record?.endReason], ["canceled", "requested"])]);
        await sleep(600);
        const later = await call(context, stack, "GetSubscription after waiting", "GetSubscription", [sub.id]);
        context.expect(later.folder, [equal("still canceled and not charged again", [answer<Sub>(later).value?.status, answer<Sub>(later).value?.latestPayment], ["canceled", sub.latestPayment])]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "cancel-at-period-end": {
      title: "cancelling at period end keeps the subscription active and flags it, in the answer and in MongoDB",
      entryPoint: "`CancelSubscription(id, key, \"period_end\")`",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const { sub } = await create(context, stack, { name: "create", prepared: prepared, key: "period-end-create" });
        const flagged = await call(context, stack, "cancel at period end", "CancelSubscription", [sub.id, "period-end-1", "period_end"]);
        const after = answer<Sub>(flagged).value;
        context.expect(flagged.folder, [
          equal("the call succeeded", answer(flagged).ok, true),
          equal("the subscription is still active", after?.status, "active"),
          equal("it is flagged to end", after?.cancelAtPeriodEnd, true),
          equal("it has not ended", after?.endedAt, undefined),
        ]);
        const doc = await stored(context, "MongoDB record after the flag", sub.id);
        context.expect(doc.folder, [equal("the record is active and flagged", [doc.record?.status, doc.record?.cancelAtPeriodEnd], ["active", true])]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "cancel-errors": {
      title: "cancelling an unknown subscription, with an unknown timing, or twice is rejected with a typed error; replaying a key is not",
      entryPoint: "`CancelSubscription` with bad input",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const { sub } = await create(context, stack, { name: "create", prepared: prepared, key: "cancel-errors-create" });
        const unknown = await call(context, stack, "cancel an unknown id", "CancelSubscription", ["sub_missing", "k-unknown", "now"]);
        context.expect(unknown.folder, [has("SubscriptionNotFoundError", failure(unknown), /^SubscriptionNotFoundError/)]);
        const timing = await call(context, stack, "cancel with an unknown timing", "CancelSubscription", [sub.id, "k-timing", "later"]);
        context.expect(timing.folder, [has("InvalidSubscriptionRequestError names the timing", failure(timing), /^InvalidSubscriptionRequestError: Unknown cancellation timing: later/)]);
        const first = await call(context, stack, "cancel now", "CancelSubscription", [sub.id, "k-first", "now"]);
        context.expect(first.folder, [equal("the first cancel succeeded", answer<Sub>(first).value?.status, "canceled")], { critical: true });
        const replay = await call(context, stack, "replay the same key", "CancelSubscription", [sub.id, "k-first", "now"]);
        context.expect(replay.folder, [equal("the replay answers the canceled subscription", [answer(replay).ok, answer<Sub>(replay).value?.status], [true, "canceled"])]);
        const twice = await call(context, stack, "cancel again with a new key", "CancelSubscription", [sub.id, "k-second", "now"]);
        context.expect(twice.folder, [has("InvalidSubscriptionStateError says it has ended", failure(twice), /^InvalidSubscriptionStateError: Subscription sub_\w+ has ended/)]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "change-method": {
      title: "changing the payment method stores the new method on the subscription and charges it from then on",
      entryPoint: "`UpdateSubscriptionPaymentMethod(id, method, key)`",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const second = await prepare(context, stack, "tok_settles_later", prepared.customer);
        context.expect(stack.app.folder, [equal("the customer has two different methods", second.method === prepared.method, false)]);
        const { sub } = await create(context, stack, { name: "create", prepared: prepared, key: "method-create" });
        const changed = await call(context, stack, "change the method", "UpdateSubscriptionPaymentMethod", [sub.id, second.method, "method-1"]);
        context.expect(changed.folder, [equal("the new method is on the subscription", [answer(changed).ok, answer<Sub>(changed).value?.paymentMethod], [true, second.method])]);
        const doc = await stored(context, "MongoDB record after the change", sub.id);
        context.expect(doc.folder, [equal("the record holds the new method", doc.record?.paymentMethod, second.method)]);
        const replay = await call(context, stack, "replay the same key", "UpdateSubscriptionPaymentMethod", [sub.id, prepared.method, "method-1"]);
        context.expect(replay.folder, [equal("a replayed key changes nothing", answer<Sub>(replay).value?.paymentMethod, second.method)]);
        await context.stop("SIGINT", stack.app);
      },
    },
    "change-method-errors": {
      title: "a method not saved for the customer, an unknown subscription or an ended subscription is rejected and the stored method stays",
      entryPoint: "`UpdateSubscriptionPaymentMethod` with bad input",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const other = await prepare(context, stack, SUCCEEDS);
        const { sub } = await create(context, stack, { name: "create", prepared: prepared, key: "method-errors-create" });
        const foreign = await call(context, stack, "change to another customer's method", "UpdateSubscriptionPaymentMethod", [sub.id, other.method, "m-foreign"]);
        context.expect(foreign.folder, [has("InvalidSubscriptionRequestError names the method", failure(foreign), /^InvalidSubscriptionRequestError: Payment method \w+ is not saved against customer/)]);
        const unknown = await call(context, stack, "change an unknown subscription", "UpdateSubscriptionPaymentMethod", ["sub_missing", prepared.method, "m-unknown"]);
        context.expect(unknown.folder, [has("SubscriptionNotFoundError", failure(unknown), /^SubscriptionNotFoundError/)]);
        const doc = await stored(context, "MongoDB record", sub.id);
        context.expect(doc.folder, [equal("the stored method is unchanged", doc.record?.paymentMethod, prepared.method)]);
        const ended = await call(context, stack, "cancel now", "CancelSubscription", [sub.id, "m-cancel", "now"]);
        context.expect(ended.folder, [equal("canceled", answer<Sub>(ended).value?.status, "canceled")], { critical: true });
        const late = await call(context, stack, "change after the end", "UpdateSubscriptionPaymentMethod", [sub.id, prepared.method, "m-late"]);
        context.expect(late.folder, [has("InvalidSubscriptionStateError", failure(late), /^InvalidSubscriptionStateError: Subscription sub_\w+ has ended/)]);
        await context.stop("SIGINT", stack.app);
      },
    },
} satisfies Record<string, Journey>;
