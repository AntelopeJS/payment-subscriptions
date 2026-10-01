import type { PaymentStatus } from "@antelopejs/interface-payment";

import { RaiseEvent } from "./events";
import type { Settings } from "./config";
import { PeriodBoundary } from "./calendar";
import type { RecordPatch, StoredEvent, SubscriptionRecord } from "./records";

type DecisionKind = "charge" | "settle" | "end";

export interface Decision {
  kind: DecisionKind;
  periodIndex: number;
  attempt: number;
  fingerprint: string;
}

export type OutcomeKind = "succeeded" | "failed" | "pending" | "error" | "end";

export interface Outcome {
  kind: OutcomeKind;
  payment: string | null;
}

export interface Transition {
  patch: RecordPatch;
  events: StoredEvent[];
}

export const RESULT_OF_PAYMENT: Record<PaymentStatus, OutcomeKind> = {
  succeeded: "succeeded",
  failed: "failed",
  canceled: "failed",
  requires_action: "failed",
  pending: "pending",
  authorized: "pending",
};

function Fingerprint(record: SubscriptionRecord): string {
  return `${record.periodIndex}:${record.attempt}:${record.pendingPayment ?? ""}`;
}

function decision(
  record: SubscriptionRecord,
  kind: DecisionKind,
  periodIndex: number,
  attempt: number,
): Decision {
  return { kind, periodIndex, attempt, fingerprint: Fingerprint(record) };
}

export function Decide(record: SubscriptionRecord, now: number): Decision {
  if (record.pendingPayment !== null) {
    return decision(record, "settle", record.periodIndex, record.attempt);
  }
  if (record.cancelAtPeriodEnd && now >= record.currentPeriodEnd) {
    return decision(record, "end", record.periodIndex, record.attempt);
  }
  if (record.status === "past_due") {
    return decision(record, "charge", record.periodIndex, record.attempt);
  }
  return decision(record, "charge", record.periodIndex + 1, 0);
}

export function ChargeKey(
  record: SubscriptionRecord,
  decided: Decision,
): string {
  return `payment-subscriptions:${record._id}:${decided.periodIndex}:${decided.attempt}`;
}

function period(record: SubscriptionRecord, index: number): RecordPatch {
  const boundary = (at: number) =>
    PeriodBoundary(record.anchor, record.interval, record.intervalCount, at);
  return {
    periodIndex: index,
    currentPeriodStart: boundary(index),
    currentPeriodEnd: boundary(index + 1),
  };
}

type Rule = (
  record: SubscriptionRecord,
  decided: Decision,
  outcome: Outcome,
  now: number,
  settings: Settings,
) => Transition;

function withEvents(
  record: SubscriptionRecord,
  patch: RecordPatch,
  now: number,
  types: StoredEvent["type"][],
  payment: string | null,
): Transition {
  const after = { ...record, ...patch };
  return {
    patch,
    events: types.map((type) => RaiseEvent(after, type, now, payment)),
  };
}

const succeeded: Rule = (record, decided, outcome, now) => {
  const paid = period(record, decided.periodIndex);
  const patch: RecordPatch = {
    ...paid,
    status: "active",
    attempt: 0,
    pendingPayment: null,
    latestPayment: outcome.payment,
    nextActionAt: paid.currentPeriodEnd!,
  };
  return withEvents(
    record,
    patch,
    now,
    ["subscription.payment_succeeded"],
    outcome.payment,
  );
};

const failed: Rule = (record, decided, outcome, now, settings) => {
  const base: RecordPatch = {
    ...period(record, decided.periodIndex),
    pendingPayment: null,
    latestPayment: outcome.payment,
  };
  const retryDelay = settings.retryDelaysMs[decided.attempt];
  if (retryDelay === undefined) {
    const ended = {
      ...base,
      status: "canceled" as const,
      endedAt: now,
      endReason: "payment_failed" as const,
      nextActionAt: null,
    };
    return withEvents(
      record,
      ended,
      now,
      ["subscription.payment_failed", "subscription.canceled"],
      outcome.payment,
    );
  }
  const retry = {
    ...base,
    status: "past_due" as const,
    attempt: decided.attempt + 1,
    nextActionAt: now + retryDelay,
  };
  return withEvents(
    record,
    retry,
    now,
    ["subscription.payment_failed"],
    outcome.payment,
  );
};

const pending: Rule = (record, decided, outcome, now, settings) => ({
  patch: {
    ...period(record, decided.periodIndex),
    status: record.status === "trialing" ? "active" : record.status,
    latestPayment: outcome.payment,
    pendingPayment: outcome.payment,
    nextActionAt: now + settings.settlementPollMs,
  },
  events: [],
});

const unreachable: Rule = (_record, _decided, _outcome, now, settings) => ({
  patch: { nextActionAt: now + settings.errorBackoffMs },
  events: [],
});

const end: Rule = (record, _decided, _outcome, now) => {
  const patch: RecordPatch = {
    status: "canceled",
    endedAt: record.currentPeriodEnd,
    endReason: "requested",
    nextActionAt: null,
  };
  return withEvents(record, patch, now, ["subscription.canceled"], null);
};

const RULES: Record<OutcomeKind, Rule> = {
  succeeded,
  failed,
  pending,
  error: unreachable,
  end,
};

type EndedRule = (
  record: SubscriptionRecord,
  outcome: Outcome,
  now: number,
  settings: Settings,
) => Transition | undefined;

const SETTLED_ON_ENDED: RecordPatch = {
  pendingPayment: null,
  nextActionAt: null,
};

const ENDED_RULES: Record<OutcomeKind, EndedRule> = {
  succeeded: (record, outcome, now) =>
    withEvents(
      record,
      { ...SETTLED_ON_ENDED, latestPayment: outcome.payment },
      now,
      ["subscription.payment_succeeded"],
      outcome.payment,
    ),
  failed: (record, outcome) => ({
    patch: { ...SETTLED_ON_ENDED, latestPayment: outcome.payment },
    events: [],
  }),
  pending: (_record, outcome, now, settings) => ({
    patch: {
      latestPayment: outcome.payment,
      pendingPayment: outcome.payment,
      nextActionAt: now + settings.settlementPollMs,
    },
    events: [],
  }),
  error: (_record, _outcome, now, settings) => ({
    patch: { nextActionAt: now + settings.errorBackoffMs },
    events: [],
  }),
  end: () => undefined,
};

export function Apply(
  record: SubscriptionRecord,
  decided: Decision,
  outcome: Outcome,
  now: number,
  settings: Settings,
): Transition | undefined {
  if (Fingerprint(record) !== decided.fingerprint) return undefined;
  if (record.status === "canceled") {
    return ENDED_RULES[outcome.kind](record, outcome, now, settings);
  }
  return RULES[outcome.kind](record, decided, outcome, now, settings);
}
