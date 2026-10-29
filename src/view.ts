import type { Subscription } from "@antelopejs/interface-subscriptions";
import type { SubscriptionRecord } from "./records";

export function ToSubscription(record: SubscriptionRecord): Subscription {
  const subscription: Subscription = {
    vendorData: {
      reconciliationRequired: record.reconciliationRequired ?? false,
      attemptStartedAt: record.attemptStartedAt ?? null,
      attemptReplayUntil: record.attemptReplayUntil ?? null,
      phase: record.phase,
    },
    id: record._id,
    reference: record.reference,
    customer: record.customer,
    paymentMethod: record.paymentMethod,
    amount: { ...record.amount },
    interval: record.interval,
    intervalCount: record.intervalCount,
    status: record.status,
    currentPeriodStart: record.currentPeriodStart,
    currentPeriodEnd: record.currentPeriodEnd,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    createdAt: record.createdAt,
  };
  if (record.trialEnd !== null) subscription.trialEnd = record.trialEnd;
  if (record.endedAt !== null) subscription.endedAt = record.endedAt;
  if (record.endReason !== null) subscription.endReason = record.endReason;
  if (record.latestPayment !== null)
    subscription.latestPayment = record.latestPayment;
  if (record.metadata !== null) subscription.metadata = { ...record.metadata };
  return subscription;
}
