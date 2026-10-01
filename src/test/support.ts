import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CreateCustomer,
  CreatePayment,
  ListPaymentMethods,
  type PaymentRequest,
} from "@antelopejs/interface-payment";
import {
  CreateSubscription,
  GetSubscription,
  type Subscription,
  type SubscriptionEvent,
  SubscriptionEvents,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import { Runtime } from "../runtime";
import { start, stop } from "../index";
import { type Clock, SYSTEM_CLOCK, UseClock } from "../clock";

const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const SUITE_TIMEOUT = 30_000;
const SETTLE_TIMEOUT = 10_000;
const SETTLE_POLL = 25;
const PERIOD_VALUE = 1900;

export const CLOCK_UNDER_TEST =
  process.env.ANTELOPE_SUBSCRIPTIONS_TEST_CLOCK ?? "polling";

/** One entry per CreatePayment call the test provider received, replays included. */
export interface LedgerEntry {
  request: PaymentRequest;
  idempotencyKey: string;
  provider: string | undefined;
  replayed: boolean;
  unreachable?: boolean;
}

interface ProviderControl {
  TOKENS: Record<
    "succeeds" | "declinesOffSession" | "settlesLater" | "failsLater",
    string
  >;
  setUnreachable(isUnreachable: boolean): void;
  ledger(): LedgerEntry[];
  chargesFor(subscriptionId: string): LedgerEntry[];
  paymentStatus(id: string, provider?: string): string | undefined;
}

/**
 * The test payment provider, as loaded by the runtime. Test files share the
 * module instances the runtime loaded, so this is the provider's live state.
 */
// oxlint-disable-next-line typescript/no-require-imports -- the provider is plain CommonJS outside src
export const provider: ProviderControl =
  require("../../test/payment-provider").testControl;
export const TOKENS = provider.TOKENS;

/** Charges that reached the provider and were not replays of an earlier key. */
export function chargesMade(subscriptionId: string): LedgerEntry[] {
  return provider
    .chargesFor(subscriptionId)
    .filter((entry) => !entry.replayed && !entry.unreachable);
}

/** A clock the suite moves by hand. */
export class ManualClock implements Clock {
  constructor(public time: number) {}

  now(): number {
    return this.time;
  }

  advanceTo(time: number): void {
    assert.ok(time >= this.time, "the clock only moves forward");
    this.time = time;
  }

  advance(ms: number): void {
    this.time += ms;
  }
}

/**
 * Installs a manual clock for the enclosing `describe`, starting at a fixed
 * instant, and puts the system clock back afterwards.
 */
export function useManualClock(start: number): ManualClock {
  const clock = new ManualClock(start);
  beforeEach(() => {
    clock.time = start;
    UseClock(clock);
  });
  afterEach(() => UseClock(SYSTEM_CLOCK));
  return clock;
}

/**
 * Sweeps until the subscription satisfies `predicate`. A sweep is the same
 * call both clocks make; calling it here makes the renewal under test happen
 * now, whichever clock is running, instead of whenever the trigger next fires.
 */
export async function settleOn(
  id: string,
  predicate: (subscription: Subscription) => boolean,
  label: string,
  account?: string,
): Promise<Subscription> {
  const deadline = Date.now() + SETTLE_TIMEOUT;
  let subscription = await GetSubscription(id, account);
  while (!predicate(subscription) && Date.now() < deadline) {
    await Runtime().engine.sweep();
    await delay(SETTLE_POLL);
    subscription = await GetSubscription(id, account);
  }
  assert.ok(
    predicate(subscription),
    `${label}: got ${JSON.stringify(subscription)}`,
  );
  return subscription;
}

/** Sweeps until nothing is due, so a test can assert that nothing happened. */
export async function quiesce(): Promise<void> {
  await Runtime().engine.drain();
  await Runtime().engine.sweep();
  await Runtime().engine.drain();
}

/**
 * Runs `work` with the module's own clock stopped — no polling, no Redis
 * handler — so that whatever renews a subscription meanwhile is what the test
 * did, and nothing else.
 */
export async function withTriggerStopped(
  work: () => Promise<void>,
): Promise<void> {
  await stop();
  try {
    await work();
  } finally {
    await start();
  }
}

export function key(): string {
  return `fallback-suite-${randomUUID()}`;
}

export interface Payer {
  customer: string;
  paymentMethod: string;
}

/** Saves a method from `token` the way the contract allows: on-session. */
export async function saveMethod(
  customer: string,
  token: string,
  account?: string,
): Promise<string> {
  const before = new Set(
    (await ListPaymentMethods(customer, account)).map((method) => method.id),
  );
  await CreatePayment(
    {
      amount: { value: PERIOD_VALUE, currency: "EUR" },
      reference: `save-${randomUUID()}`,
      customer,
      paymentMethod: token,
      savePaymentMethod: true,
      returnUrl: "https://merchant.invalid/return",
    },
    key(),
    account,
  );
  const saved = (await ListPaymentMethods(customer, account)).find(
    (method) => !before.has(method.id),
  );
  assert.ok(saved, "the saving payment must save a method");
  return saved.id;
}

export async function newPayer(
  token: string = TOKENS.succeeds,
  account?: string,
): Promise<Payer> {
  const customer = await CreateCustomer(
    { name: "Fallback Payer" },
    key(),
    account,
  );
  return {
    customer: customer.id,
    paymentMethod: await saveMethod(customer.id, token, account),
  };
}

function monthly(
  payer: Payer,
  overrides: Partial<SubscriptionRequest> = {},
): SubscriptionRequest {
  return {
    reference: `fallback-${randomUUID()}`,
    customer: payer.customer,
    paymentMethod: payer.paymentMethod,
    amount: { value: PERIOD_VALUE, currency: "EUR" },
    interval: "month",
    ...overrides,
  };
}

export async function subscribe(
  payer: Payer,
  overrides: Partial<SubscriptionRequest> = {},
  account?: string,
): Promise<Subscription> {
  return CreateSubscription(monthly(payer, overrides), key(), account);
}

/**
 * Records every event delivered while the enclosing `describe` runs, and
 * unregisters the handler afterwards.
 */
export function recordEvents(): SubscriptionEvent[] {
  const received: SubscriptionEvent[] = [];
  const id = `fallback-suite-${randomUUID()}`;
  before(() =>
    SubscriptionEvents.register(id, (event) => void received.push(event)),
  );
  after(() => SubscriptionEvents.unregister(id));
  return received;
}

export function eventTypes(
  received: SubscriptionEvent[],
  id: string,
): string[] {
  return received
    .filter((event) => event.subscription.id === id)
    .map((event) => event.type);
}
