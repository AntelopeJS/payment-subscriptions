import type {
  SubscriptionEvent,
  SubscriptionEventHandler,
  SubscriptionEventType,
} from "@antelopejs/interface-subscriptions";

import { ToSubscription } from "./view";
import type { StoredEvent, SubscriptionRecord } from "./records";

const handlers = new Map<string, SubscriptionEventHandler>();

export function RegisterHandler(
  id: string,
  handler: SubscriptionEventHandler,
): void {
  handlers.set(id, handler);
}

export function UnregisterHandler(id: string): void {
  handlers.delete(id);
}

/**
 * Builds the event for a transition. The identifier is derived from the
 * transition itself, so recomputing a transition after a write conflict
 * yields the same event rather than a second one.
 */
export function RaiseEvent(
  record: SubscriptionRecord,
  type: SubscriptionEventType,
  createdAt: number,
  payment: string | null = null,
): StoredEvent {
  return {
    id:
      payment === null
        ? `${record._id}:${type}`
        : `${record._id}:${type}:${payment}`,
    type,
    createdAt,
    subscription: ToSubscription(record),
    payment,
  };
}

async function deliverOne(event: StoredEvent): Promise<boolean> {
  const delivered: SubscriptionEvent = {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    subscription: event.subscription,
  };
  if (event.payment !== null) delivered.payment = event.payment;
  const outcomes = await Promise.allSettled(
    [...handlers.values()].map(async (handler) => handler(delivered)),
  );
  return outcomes.every((outcome) => outcome.status === "fulfilled");
}

/**
 * Hands each event to every registered handler, in order.
 *
 * @returns the identifiers of the events every handler accepted. The rest stay
 *   in the outbox and are delivered again.
 */
export async function Deliver(events: StoredEvent[]): Promise<string[]> {
  const delivered: string[] = [];
  for (const event of events) {
    if (!(await deliverOne(event))) break;
    delivered.push(event.id);
  }
  return delivered;
}
