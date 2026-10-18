import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  GetPayment,
  ListPaymentMethods,
  PaymentError,
} from "@antelopejs/interface-payment";
import {
  type CancellationTiming,
  InvalidSubscriptionRequestError,
  InvalidSubscriptionStateError,
  type Subscription,
  SubscriptionError,
  SubscriptionNotFoundError,
  SubscriptionPaymentError,
  type SubscriptionRequest,
  ValidateSubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

import { Now } from "./clock";
import { Finalize } from "./engine";
import { Runtime } from "./runtime";
import { ToSubscription } from "./view";
import { InitialRecord } from "./initial";
import { Decide, type Transition } from "./transitions";
import { RaiseEvent, RegisterHandler, UnregisterHandler } from "./events";
import {
  CustomerRecords,
  InsertRecord,
  LoadRecord,
  type SubscriptionRecord,
} from "./records";

const WRITE_ATTEMPTS = 5;
const REMEMBERED_OPERATIONS = 50;
const CREATION_WAIT_MS = 15_000;
const CREATION_POLL_MS = 100;

function providerKey(provider: string | undefined): string {
  return provider ?? "";
}

function subscriptionId(
  idempotencyKey: string,
  provider: string | undefined,
): string {
  const digest = createHash("sha256")
    .update(`${providerKey(provider)}\n${idempotencyKey}`)
    .digest("hex");
  return `sub_${digest.slice(0, 32)}`;
}

async function loadLive(
  id: string,
  provider: string | undefined,
): Promise<SubscriptionRecord> {
  const record = await LoadRecord(id).catch(() => undefined);
  if (
    !record ||
    record.phase !== "live" ||
    record.provider !== providerKey(provider)
  ) {
    throw new SubscriptionNotFoundError(id);
  }
  return record;
}

function wrapProviderFailure(error: unknown): never {
  if (error instanceof PaymentError) {
    throw new SubscriptionError(
      `The payment provider failed: ${error.message}`,
      error.providerCode,
    );
  }
  throw error;
}

async function completeCreation(
  record: SubscriptionRecord,
  provider: string | undefined,
) {
  const { engine } = Runtime();
  const decided = Decide(record, Now());
  const outcome = await engine
    .perform(record, decided)
    .catch(wrapProviderFailure);
  if (outcome.kind === "error") {
    const current = await LoadRecord(record._id);
    if (current)
      await engine.write(current, { leaseOwner: null, leaseUntil: 0 });
    throw new SubscriptionError(
      "The payment provider could not be reached; replay the idempotency key to retry",
    );
  }
  if (outcome.kind === "reconcile") {
    const current = await LoadRecord(record._id);
    if (current)
      await engine.write(current, {
        reconciliationRequired: true,
        nextActionAt: null,
        dueAt: null,
        leaseOwner: null,
        leaseUntil: 0,
      });
    throw new SubscriptionError(
      `Subscription ${record._id} requires reconciliation; charge replay protection unavailable or expired`,
    );
  }
  if (outcome.kind === "failed") {
    await engine.write((await LoadRecord(record._id)) ?? record, {
      phase: "refused",
      refusedPayment: outcome.payment,
      refusal: outcome.reason ?? null,
      leaseOwner: null,
      leaseUntil: 0,
    });
    throw await refusalOf(record, outcome.payment, outcome.reason, provider);
  }
  const live = await engine.commit(record, decided, outcome, {
    patch: { phase: "live" },
    events: [RaiseEvent(record, "subscription.created", Now())],
  });
  await engine.release(live);
  return ToSubscription(live);
}

async function refusalOf(
  record: SubscriptionRecord,
  payment: string | null,
  reason: string | undefined,
  provider: string | undefined,
): Promise<SubscriptionError> {
  if (payment !== null) {
    return new SubscriptionPaymentError(await GetPayment(payment, provider));
  }
  return new InvalidSubscriptionRequestError(
    `The payment provider refused to charge ${record.paymentMethod}: ${reason ?? "no reason given"}`,
  );
}

async function waitForCreation(
  id: string,
): Promise<SubscriptionRecord | undefined> {
  const deadline = Date.now() + CREATION_WAIT_MS;
  let record = await LoadRecord(id);
  while (
    record?.phase === "creating" &&
    record.leaseUntil > Now() &&
    Date.now() < deadline
  ) {
    await delay(CREATION_POLL_MS);
    record = await LoadRecord(id);
  }
  return record;
}

async function resumeCreation(
  record: SubscriptionRecord,
  provider: string | undefined,
) {
  const { engine, settings } = Runtime();
  const claimed = await engine.write(record, {
    leaseOwner: engine.instanceId,
    leaseUntil: Now() + settings.leaseMs,
  });
  if (!claimed) return replayCreation(record._id, provider);
  return completeCreation(claimed, provider);
}

async function replayCreation(
  id: string,
  provider: string | undefined,
): Promise<Subscription> {
  const record = await waitForCreation(id);
  if (!record)
    throw new SubscriptionError(`Subscription ${id} vanished during creation`);
  if (record.phase === "live") return ToSubscription(record);
  if (record.phase === "refused") {
    throw await refusalOf(
      record,
      record.refusedPayment,
      record.refusal ?? undefined,
      provider,
    );
  }
  if (record.leaseUntil > Now()) {
    throw new SubscriptionError(
      `Subscription ${id} is still being created; replay the key later`,
    );
  }
  return resumeCreation(record, provider);
}

async function CreateSubscription(
  request: SubscriptionRequest,
  idempotencyKey: string,
  provider?: string,
): Promise<Subscription> {
  const { engine, settings, schedule } = Runtime();
  ValidateSubscriptionRequest(request);
  const id = subscriptionId(idempotencyKey, provider);
  if (await LoadRecord(id)) return replayCreation(id, provider);
  ValidateSubscriptionRequest(request, Now());
  const record = InitialRecord(request, {
    id,
    provider: providerKey(provider),
    now: Now(),
    instanceId: engine.instanceId,
    settings,
  });
  record.providerReference =
    (await schedule
      .register(ToSubscription(record), provider)
      .catch(wrapProviderFailure)) ?? null;
  if (!(await InsertRecord(record))) return replayCreation(id, provider);
  engine.notify(record);
  if (record.phase === "live") {
    engine.processInBackground(id);
    return ToSubscription(record);
  }
  return completeCreation(record, provider);
}

async function GetSubscription(
  id: string,
  provider?: string,
): Promise<Subscription> {
  return ToSubscription(await loadLive(id, provider));
}

async function ListSubscriptions(
  customer: string,
  provider?: string,
): Promise<Subscription[]> {
  return (await CustomerRecords(customer, providerKey(provider))).map(
    ToSubscription,
  );
}

type Change = (
  record: SubscriptionRecord,
  now: number,
) => Promise<Transition> | Transition;

async function changeLive(
  id: string,
  idempotencyKey: string,
  provider: string | undefined,
  change: Change,
): Promise<Subscription> {
  const { engine } = Runtime();
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const record = await loadLive(id, provider);
    if (record.operationKeys.includes(idempotencyKey))
      return ToSubscription(record);
    const now = Now();
    const transition = await change(record, now);
    const operationKeys = [...record.operationKeys, idempotencyKey].slice(
      -REMEMBERED_OPERATIONS,
    );
    const written = await engine.write(record, {
      ...Finalize(record, transition, now),
      operationKeys,
    });
    if (!written) continue;
    if (transition.events.length > 0) engine.processInBackground(id);
    return ToSubscription(written);
  }
  throw new SubscriptionError(
    `Subscription ${id} kept changing underneath the request; retry it`,
  );
}

function assertNotEnded(record: SubscriptionRecord): void {
  if (record.status === "canceled") {
    throw new InvalidSubscriptionStateError(
      `Subscription ${record._id} has ended`,
      record.status,
    );
  }
}

const CANCELLATIONS: Record<CancellationTiming, Change> = {
  now: (record, now) => {
    const patch = {
      status: "canceled" as const,
      endedAt: now,
      endReason: "requested" as const,
      reconciliationRequired:
        record.reconciliationRequired ||
        (record.pendingPayment === null && record.attemptMethod !== null),
      nextActionAt: record.pendingPayment === null ? null : record.nextActionAt,
    };
    const ended = { ...record, ...patch };
    return { patch, events: [RaiseEvent(ended, "subscription.canceled", now)] };
  },
  period_end: () => ({ patch: { cancelAtPeriodEnd: true }, events: [] }),
};

async function CancelSubscription(
  id: string,
  idempotencyKey: string,
  timing: CancellationTiming,
  provider?: string,
): Promise<Subscription> {
  const cancel = CANCELLATIONS[timing];
  if (!cancel)
    throw new InvalidSubscriptionRequestError(
      `Unknown cancellation timing: ${timing}`,
    );
  const canceled = await changeLive(
    id,
    idempotencyKey,
    provider,
    (record, now) => {
      assertNotEnded(record);
      return cancel(record, now);
    },
  );
  if (canceled.status === "canceled")
    await Runtime().engine.releaseScheduleFor(id);
  return canceled;
}

async function UpdateSubscriptionPaymentMethod(
  id: string,
  paymentMethod: string,
  idempotencyKey: string,
  provider?: string,
): Promise<Subscription> {
  return changeLive(id, idempotencyKey, provider, async (record) => {
    assertNotEnded(record);
    const saved = await ListPaymentMethods(record.customer, provider).catch(
      wrapProviderFailure,
    );
    if (!saved.some((method) => method.id === paymentMethod)) {
      throw new InvalidSubscriptionRequestError(
        `Payment method ${paymentMethod} is not saved against customer ${record.customer}`,
      );
    }
    return { patch: { paymentMethod }, events: [] };
  });
}

export const Implementation = {
  CreateSubscription,
  GetSubscription,
  ListSubscriptions,
  CancelSubscription,
  UpdateSubscriptionPaymentMethod,
  SubscriptionEvents: {
    register: RegisterHandler,
    unregister: UnregisterHandler,
  },
};
