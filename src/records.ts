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

/**
 * Where a record is in its own creation. Only `live` records are
 * subscriptions; the others exist so that a replayed idempotency key finds
 * the original attempt.
 */
type Phase = "creating" | "live" | "refused";

/** The fallback has no provider-side record, so it never sets `vendorData`. */
export type Snapshot = Omit<Subscription, "vendorData">;

/** An event waiting to be delivered, stored with the transition that raised it. */
export interface StoredEvent {
  id: string;
  type: SubscriptionEventType;
  createdAt: number;
  subscription: Snapshot;
  payment: string | null;
}

/**
 * One subscription, as the database holds it. The database is the only
 * source of truth: everything the renewal clock needs is here, and a Redis
 * trigger only ever says "look at this record now".
 *
 * Absent values are `null` rather than missing, because an atomic patch
 * cannot carry `undefined`.
 */
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

/**
 * Inserts a record under an identifier derived from the caller's idempotency
 * key, so that two racing creations with one key cannot both insert.
 *
 * @returns false if a record with that identifier already exists
 */
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

/**
 * Applies `patch` only if the record still carries the revision it was read
 * at, installing a fresh revision with it.
 *
 * This is the one way the module changes a stored subscription, and what
 * makes a renewal claim exclusive: of two instances that read the same
 * revision, exactly one sees `applied`.
 *
 * @returns the record as written, or undefined if it was not written —
 *   whether because the revision moved or because the outcome is unknown
 */
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

/**
 * Identifiers of live records with something to do by `now`, soonest first.
 */
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
