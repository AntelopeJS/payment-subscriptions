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

export function RaiseEvent(
  record: SubscriptionRecord,
  type: SubscriptionEventType,
  createdAt: number,
  payment: string | null = null,
  occurrence: string | null = payment,
): StoredEvent {
  return {
    id:
      occurrence === null
        ? `${record._id}:${type}`
        : `${record._id}:${type}:${occurrence}`,
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

export async function Deliver(events: StoredEvent[]): Promise<string[]> {
  const delivered: string[] = [];
  for (const event of events) {
    if (!(await deliverOne(event))) break;
    delivered.push(event.id);
  }
  return delivered;
}
