import type { Snapshot, SubscriptionRecord } from "./records";

function present<K extends string, V>(
  key: K,
  value: V | null,
): Partial<Record<K, V>> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

export function ToSubscription(record: SubscriptionRecord): Snapshot {
  return {
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
    ...present("trialEnd", record.trialEnd),
    ...present("endedAt", record.endedAt),
    ...present("endReason", record.endReason),
    ...present("latestPayment", record.latestPayment),
    ...present(
      "metadata",
      record.metadata === null ? null : { ...record.metadata },
    ),
  };
}
