import type { SubscriptionRequest } from "@antelopejs/interface-subscriptions";

import { RaiseEvent } from "./events";
import { NewRevision } from "./records";
import type { Settings } from "./config";
import type { SubscriptionRecord } from "./records";

const BEFORE_FIRST_PERIOD = -1;
const NO_LEASE = 0;
const ORDERS_PER_MILLISECOND = 1000;

let lastOrder = 0;

function creationOrder(now: number): number {
  lastOrder = Math.max(now * ORDERS_PER_MILLISECOND, lastOrder + 1);
  return lastOrder;
}

function base(
  id: string,
  request: SubscriptionRequest,
  provider: string,
  now: number,
): SubscriptionRecord {
  return {
    _id: id,
    revision: NewRevision(),
    phase: "live",
    provider,
    reference: request.reference,
    customer: request.customer,
    paymentMethod: request.paymentMethod,
    amount: { value: request.amount.value, currency: request.amount.currency },
    interval: request.interval,
    intervalCount: request.intervalCount ?? 1,
    description: request.description ?? null,
    metadata: request.metadata ? { ...request.metadata } : null,
    status: "active",
    anchor: now,
    periodIndex: BEFORE_FIRST_PERIOD,
    currentPeriodStart: now,
    currentPeriodEnd: now,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    endedAt: null,
    endReason: null,
    latestPayment: null,
    attempt: 0,
    pendingPayment: null,
    refusedPayment: null,
    refusal: null,
    attemptMethod: null,
    attemptStartedAt: null,
    attemptReplayUntil: null,
    reconciliationRequired: false,
    providerReference: null,
    nextActionAt: now,
    dueAt: null,
    leaseOwner: null,
    leaseUntil: NO_LEASE,
    outbox: [],
    operationKeys: [],
    createdAt: now,
    createdOrder: creationOrder(now),
  };
}

function deferred(
  record: SubscriptionRecord,
  startsAt: number,
  isTrial: boolean,
): SubscriptionRecord {
  const live: SubscriptionRecord = {
    ...record,
    status: isTrial ? "trialing" : "active",
    anchor: startsAt,
    currentPeriodEnd: startsAt,
    trialEnd: isTrial ? startsAt : null,
    nextActionAt: startsAt,
    dueAt: record.createdAt,
  };
  return {
    ...live,
    outbox: [RaiseEvent(live, "subscription.created", record.createdAt)],
  };
}

export interface Creation {
  id: string;
  provider: string;
  now: number;
  instanceId: string;
  settings: Settings;
}

export function InitialRecord(
  request: SubscriptionRequest,
  creation: Creation,
): SubscriptionRecord {
  const { id, provider, now, instanceId, settings } = creation;
  const record = base(id, request, provider, now);
  if (request.trialEnd !== undefined)
    return deferred(record, request.trialEnd, true);
  if (request.billingAnchor !== undefined)
    return deferred(record, request.billingAnchor, false);
  return {
    ...record,
    phase: "creating",
    leaseOwner: instanceId,
    leaseUntil: now + settings.leaseMs,
  };
}
