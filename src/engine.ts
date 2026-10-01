import { randomUUID } from "node:crypto";
import { Logging } from "@antelopejs/interface-core/logging";
import { GetPayment, PaymentError } from "@antelopejs/interface-payment";

import { Now } from "./clock";
import { Deliver } from "./events";
import { ToSubscription } from "./view";
import type { Settings } from "./config";
import type { ProviderSchedule } from "./schedule";
import {
  DueRecordIds,
  LoadRecord,
  MutateRecord,
  type RecordPatch,
  type SubscriptionRecord,
} from "./records";
import {
  Apply,
  ChargeKey,
  Decide,
  type Decision,
  type Outcome,
  RESULT_OF_PAYMENT,
  type Transition,
} from "./transitions";

const WRITE_ATTEMPTS = 5;
const NO_LEASE = 0;

export type WriteListener = (record: SubscriptionRecord) => void;

export interface EngineStats {
  claimed: number;
  claimsLost: number;
  charges: number;
}

function providerOf(record: SubscriptionRecord): string | undefined {
  return record.provider === "" ? undefined : record.provider;
}

export function Finalize(
  record: SubscriptionRecord,
  transition: Transition,
  now: number,
): RecordPatch {
  const outbox = [...record.outbox, ...transition.events];
  const nextActionAt =
    transition.patch.nextActionAt === undefined
      ? record.nextActionAt
      : transition.patch.nextActionAt;
  return {
    ...transition.patch,
    outbox,
    dueAt: outbox.length > 0 ? now : nextActionAt,
  };
}

function Combine(
  record: SubscriptionRecord,
  transition: Transition,
  extra: Partial<Transition>,
  now: number,
): Transition {
  const patch = { ...transition.patch, ...extra.patch };
  const after = { ...record, ...patch };
  const leading = (extra.events ?? []).map((event) => ({
    ...event,
    createdAt: now,
    subscription: ToSubscription(after),
  }));
  return { patch, events: [...leading, ...transition.events] };
}

export class Engine {
  readonly instanceId = randomUUID();
  readonly stats: EngineStats = { claimed: 0, claimsLost: 0, charges: 0 };
  private listener: WriteListener = () => undefined;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly settings: Settings,
    private readonly schedule: ProviderSchedule,
  ) {}

  onWrite(listener: WriteListener): void {
    this.listener = listener;
  }

  notify(record: SubscriptionRecord): void {
    this.listener(record);
  }

  async sweep(): Promise<void> {
    const ids = await DueRecordIds(Now(), this.settings.batchSize);
    for (const id of ids) {
      await this.process(id);
    }
  }

  async process(id: string): Promise<void> {
    try {
      const claimed = await this.claim(id);
      if (!claimed) return;
      const acted = await this.act(claimed);
      await this.release(acted);
    } catch (error) {
      Logging.Error(`payment-subscriptions: processing ${id} failed`, error);
    }
  }

  processInBackground(id: string): void {
    const work = this.process(id).finally(() => this.inFlight.delete(work));
    this.inFlight.add(work);
  }

  async drain(): Promise<void> {
    await Promise.all(this.inFlight);
  }

  private async claim(id: string): Promise<SubscriptionRecord | undefined> {
    const now = Now();
    const record = await LoadRecord(id);
    if (!record || record.phase !== "live") return undefined;
    if (record.dueAt === null || record.dueAt > now) return undefined;
    if (record.leaseOwner !== null && record.leaseUntil > now) return undefined;
    const claimed = await MutateRecord(record, {
      leaseOwner: this.instanceId,
      leaseUntil: now + this.settings.leaseMs,
    });
    this.stats[claimed ? "claimed" : "claimsLost"] += 1;
    return claimed;
  }

  private async act(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    const now = Now();
    if (record.nextActionAt === null || record.nextActionAt > now)
      return record;
    const decided = Decide(record, now);
    const outcome = await this.perform(record, decided);
    const committed = await this.commit(record, decided, outcome);
    if (record.status !== "canceled" && committed.status === "canceled") {
      await this.releaseScheduleFor(record._id);
    }
    return committed;
  }

  async perform(
    record: SubscriptionRecord,
    decided: Decision,
  ): Promise<Outcome> {
    if (decided.kind === "end") return { kind: "end", payment: null };
    try {
      const payment =
        decided.kind === "settle"
          ? await GetPayment(record.pendingPayment!, providerOf(record))
          : await this.charge(record, decided);
      return { kind: RESULT_OF_PAYMENT[payment.status], payment: payment.id };
    } catch (error) {
      if (!(error instanceof PaymentError)) throw error;
      Logging.Warn(
        `payment-subscriptions: provider unreachable for ${record._id}`,
        error.message,
      );
      return { kind: "error", payment: null };
    }
  }

  private charge(record: SubscriptionRecord, decided: Decision) {
    this.stats.charges += 1;
    return this.schedule.charge({
      subscription: ToSubscription(record),
      provider: providerOf(record),
      providerReference: record.providerReference ?? undefined,
      idempotencyKey: ChargeKey(record, decided),
    });
  }

  async commit(
    record: SubscriptionRecord,
    decided: Decision,
    outcome: Outcome,
    extra: Partial<Transition> = {},
  ): Promise<SubscriptionRecord> {
    let current: SubscriptionRecord | undefined = record;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS && current; attempt += 1) {
      const now = Now();
      const transition = Apply(current, decided, outcome, now, this.settings);
      if (!transition) return current;
      const written = await this.write(
        current,
        Finalize(current, Combine(current, transition, extra, now), now),
      );
      if (written) return written;
      current = await LoadRecord(record._id);
    }
    return current ?? record;
  }

  async write(
    record: SubscriptionRecord,
    patch: RecordPatch,
  ): Promise<SubscriptionRecord | undefined> {
    const written = await MutateRecord(record, patch);
    if (written) this.listener(written);
    return written;
  }

  async release(record: SubscriptionRecord): Promise<void> {
    const delivered = new Set(await Deliver(record.outbox));
    let current: SubscriptionRecord | undefined = record;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS && current; attempt += 1) {
      const written = await this.write(
        current,
        this.releasePatch(current, delivered),
      );
      if (written) return;
      current = await LoadRecord(record._id);
    }
  }

  private releasePatch(
    record: SubscriptionRecord,
    delivered: Set<string>,
  ): RecordPatch {
    const outbox = record.outbox.filter((event) => !delivered.has(event.id));
    const patch: RecordPatch = {
      outbox,
      dueAt:
        outbox.length > 0
          ? Now() + this.settings.errorBackoffMs
          : record.nextActionAt,
    };
    if (record.leaseOwner === this.instanceId) {
      patch.leaseOwner = null;
      patch.leaseUntil = NO_LEASE;
    }
    return patch;
  }

  async releaseScheduleFor(id: string): Promise<void> {
    const record = await LoadRecord(id);
    if (!record) return;
    await this.releaseSchedule(record).catch((error: unknown) =>
      Logging.Warn(
        `payment-subscriptions: releasing ${id} with the provider failed`,
        error,
      ),
    );
  }

  private async releaseSchedule(record: SubscriptionRecord): Promise<void> {
    await this.schedule.release(
      ToSubscription(record),
      record.providerReference ?? undefined,
      providerOf(record),
    );
  }
}
