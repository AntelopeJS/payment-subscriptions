/**
 * Reader's view of BillingLease.tla for /statechart: one region for the
 * stored subscription, one for the provider and one per worker.
 */

/**
 * The fields of the stored record this view reads.
 * @typedef {{ owner: string, period: number, status: string, pinned: boolean, reconcile: boolean, nextAt: number }} Rec
 */

/**
 * The variables of BillingLease.tla this view reads, as /statechart passes
 * them: a function of numbers is an object keyed by each number, a set is
 * an array.
 * @typedef {object} Vars
 * @property {Rec} rec
 * @property {Record<string, { pc: string }>} wk
 * @property {Record<string, number>} paid
 * @property {number[]} recorded
 */

/** @param {Rec} r */
function subscription(r) {
  if (r.reconcile) return "Held for reconciliation";
  if (r.status === "canceled") return "Ended: payment failed";
  const paid = r.period > 0 ? "Renewed" : "Due for renewal";
  const lease = r.owner === "none" ? "" : `, claimed by ${r.owner}`;
  const pin = r.pinned ? ", charge under way" : "";
  const retry = r.status === "past_due" ? ", retry due" : "";
  return `${paid}${retry}${lease}${pin}`;
}

/** @param {Vars} v */
function provider(v) {
  const charges = Object.values(v.paid).reduce((sum, n) => sum + n, 0);
  if (charges === 0) return "No charge";
  return charges === 1 ? "Charged once" : `Charged ${charges} times`;
}

const PLACES = new Map([
  ["idle", "Not running"],
  ["claim", "Read the record"],
  ["pin", "Claimed"],
  ["pinReply", "Pinned the attempt"],
  ["charge", "Charge sent"],
  ["commitLoad", "Has the outcome"],
  ["commitWrite", "Has the outcome"],
  ["release", "Committed"],
  ["releaseWrite", "Committed"],
  ["releaseLoad", "Committed"],
]);

/**
 * One region for the subscription, one for the provider, one per worker.
 * @param {Vars} v
 * @returns {Record<string, string>}
 */
export function state(v) {
  /** @type {Record<string, string>} */
  const regions = { Subscription: subscription(v.rec), Provider: provider(v) };
  for (const [w, c] of Object.entries(v.wk)) regions[`Worker ${w}`] = PLACES.get(c.pc) ?? c.pc;
  return regions;
}

const STEPS = new Map([
  ["Load", "a sweep reads the due record"],
  ["Claim", "the claim write lands"],
  ["Pin", "the attempt is pinned"],
  ["PinReply", "the worker sends the charge"],
  ["Charge", "the provider answers"],
  ["CommitLoad", "the worker reloads to commit"],
  ["CommitWrite", "the commit write lands"],
  ["Release", "the outbox is delivered"],
  ["ReleaseWrite", "the release write lands"],
  ["ReleaseLoad", "the worker reloads to release"],
  ["Crash", "the process dies"],
  ["Tick", "time passes"],
]);

/**
 * The arrow label of one TLC step; `Settled` changes nothing and is hidden.
 * @param {string} action
 */
export function step(action) {
  return action === "Settled" ? null : (STEPS.get(action) ?? null);
}

export const title = "Renewal of one subscription by payment-subscriptions";
