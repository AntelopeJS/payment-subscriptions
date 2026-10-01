import { randomUUID } from "node:crypto";
import { Schema } from "@antelopejs/interface-database";
import type { Amount } from "@antelopejs/interface-payment";
import type {
  Subscription,
  SubscriptionEndReason,
  SubscriptionEventType,
  SubscriptionInterval,
  SubscriptionStatus,
} from "@antelopejs/interface-subscriptions";

type Phase = "creating" | "live" | "refused";

export type Snapshot = Omit<Subscription, "vendorData">;

export interface StoredEvent {
  id: string;
  type: SubscriptionEventType;
  createdAt: number;
  subscription: Snapshot;
  payment: string | null;
}

export interface SubscriptionRecord {
  _id: string;
  revision: string;
  phase: Phase;
  provider: string;
  reference: string;
  customer: string;
  paymentMethod: string;
  amount: Amount;
  interval: SubscriptionInterval;
  intervalCount: number;
  description: string | null;
  metadata: Record<string, string> | null;
  status: SubscriptionStatus;
  anchor: number;
  periodIndex: number;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  endedAt: number | null;
  endReason: SubscriptionEndReason | null;
  latestPayment: string | null;
  attempt: number;
  pendingPayment: string | null;
  refusedPayment: string | null;
  refusal: string | null;
  attemptMethod: string | null;
  providerReference: string | null;
  nextActionAt: number | null;
  dueAt: number | null;
  leaseOwner: string | null;
  leaseUntil: number;
  outbox: StoredEvent[];
  operationKeys: string[];
  createdAt: number;
  createdOrder: number;
}

export type RecordPatch = Partial<Omit<SubscriptionRecord, "_id" | "revision">>;

interface Tables {
  subscriptions: SubscriptionRecord;
}

const SCHEMA_ID = "payment-subscriptions";
const NOT_DUE = null;

const schema = new Schema<Tables>(SCHEMA_ID, {
  subscriptions: {
    fields: {},
    indexes: { dueAt: {}, customer: {} },
  },
});

function table() {
  return schema.instance().table("subscriptions");
}

export function NewRevision(): string {
  return randomUUID();
}

export async function LoadRecord(
  id: string,
): Promise<SubscriptionRecord | undefined> {
  return (await table().get(id)) ?? undefined;
}

export async function InsertRecord(
  record: SubscriptionRecord,
): Promise<boolean> {
  try {
    await table().insert(record);
    return true;
  } catch (error) {
    if (await LoadRecord(record._id)) return false;
    throw error;
  }
}

export async function MutateRecord(
  record: SubscriptionRecord,
  patch: RecordPatch,
): Promise<SubscriptionRecord | undefined> {
  const nextRevision = NewRevision();
  const outcome = await table().atomicMutation(record._id, {
    type: "update",
    revisionField: "revision",
    expectedRevision: record.revision,
    nextRevision,
    patch,
  });
  if (outcome !== "applied") return undefined;
  return { ...record, ...patch, revision: nextRevision };
}

export async function DueRecordIds(
  now: number,
  limit: number,
): Promise<string[]> {
  const due = await table()
    .filter((record) =>
      record.key("dueAt").ne(NOT_DUE).and(record.key("dueAt").le(now)),
    )
    .orderBy("dueAt", "asc")
    .slice(0, limit);
  return due.map((record) => record._id);
}

export async function CustomerRecords(
  customer: string,
  provider: string,
): Promise<SubscriptionRecord[]> {
  return table()
    .filter((record) =>
      record
        .key("customer")
        .eq(customer)
        .and(record.key("provider").eq(provider))
        .and(record.key("phase").eq("live")),
    )
    .orderBy("createdOrder", "desc");
}
