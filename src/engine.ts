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

/** Called with every record the engine writes, so a trigger can reschedule it. */
export type WriteListener = (record: SubscriptionRecord) => void;

/** What one engine has seen, for the suite to tell a real race from a quiet one. */
export interface EngineStats {
  claimed: number;
  claimsLost: number;
  charges: number;
}

function providerOf(record: SubscriptionRecord): string | undefined {
  return record.provider === "" ? undefined : record.provider;
}

/**
 * Completes a patch: the outbox gains the transition's events, and `dueAt` —
 * the one field the sweep queries — becomes now while anything is
 * undelivered, and the next action's time otherwise.
 */
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

/**
 * Merges what a caller adds to a transition — the creation event and the
 * `live` phase, for a first charge — with the transition itself. The added
 * events are snapshotted after the patch, and go first.
 */
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

/**
 * Renews subscriptions. One per process in production; the suite builds a
 * second to race the first.
 *
 * Every change goes through a conditional write on the record's revision. A
 * renewal is claimed by writing a lease before anything is charged, so of two
 * engines that find the same renewal due, one charges it and the other finds
 * its claim refused. The charge also carries an idempotency key derived from
 * the subscription, the period and the attempt, so an engine that takes over
 * an expired lease replays the original charge rather than making a second.
 */
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

  /** Tells the trigger about a record written outside the engine. */
  notify(record: SubscriptionRecord): void {
    this.listener(record);
  }

  /** Processes every subscription due by now, up to the batch size. */
  async sweep(): Promise<void> {
    const ids = await DueRecordIds(Now(), this.settings.batchSize);
    for (const id of ids) {
      await this.process(id);
    }
  }

  /**
   * Claims one subscription if it is due and unclaimed, does what is due,
   * delivers its events and releases it. Never throws: a failure leaves the
   * record due, and the next sweep picks it up.
   */
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

  /**
   * Processes a subscription without making the caller wait: delivering the
   * events a call just raised, say. Tracked, so `drain` can wait for it.
   */
  processInBackground(id: string): void {
    const work = this.process(id).finally(() => this.inFlight.delete(work));
    this.inFlight.add(work);
  }

  /** Waits for every background run to finish. */
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

  /** Does what the decision calls for, against the provider. */
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

  /**
   * Writes an outcome. A conflicting write means someone else changed the
   * record meanwhile — a cancellation, say — so the record is read again and
   * the outcome applied to what is there now. `Apply` makes that a no-op when
   * the change was this same charge, applied by another engine.
   */
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

  /** Writes a patch, and tells the trigger about the result. */
  async write(
    record: SubscriptionRecord,
    patch: RecordPatch,
  ): Promise<SubscriptionRecord | undefined> {
    const written = await MutateRecord(record, patch);
    if (written) this.listener(written);
    return written;
  }

  /**
   * Delivers whatever is in the outbox, removes what was delivered, and gives
   * up the lease if it is still this engine's.
   */
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

  /** Tells the provider a subscription that has just ended is over. */
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
