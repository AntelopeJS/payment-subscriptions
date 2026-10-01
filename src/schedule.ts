import { CreatePayment, type Payment } from "@antelopejs/interface-payment";
import { SUBSCRIPTION_METADATA_KEY } from "@antelopejs/interface-subscriptions";

import type { Snapshot } from "./records";

interface ScheduledCharge {
  subscription: Snapshot;
  provider: string | undefined;
  providerReference: string | undefined;
  idempotencyKey: string;
}

export interface ProviderSchedule {
  register(
    subscription: Snapshot,
    provider: string | undefined,
  ): Promise<string | undefined>;
  charge(charge: ScheduledCharge): Promise<Payment>;
  release(
    subscription: Snapshot,
    providerReference: string | undefined,
    provider: string | undefined,
  ): Promise<void>;
}

function chargeOffSession(charge: ScheduledCharge): Promise<Payment> {
  const { subscription } = charge;
  return CreatePayment(
    {
      amount: subscription.amount,
      reference: subscription.reference,
      customer: subscription.customer,
      paymentMethod: subscription.paymentMethod,
      offSession: true,
      metadata: {
        ...subscription.metadata,
        [SUBSCRIPTION_METADATA_KEY]: subscription.id,
      },
    },
    charge.idempotencyKey,
    charge.provider,
  );
}

const PAYMENT_INTERFACE_SCHEDULE: ProviderSchedule = Object.freeze({
  register: () => Promise.resolve(undefined),
  charge: chargeOffSession,
  release: () => Promise.resolve(),
});

const SCHEDULES: Record<string, ProviderSchedule> = {
  "payment-interface": PAYMENT_INTERFACE_SCHEDULE,
};

export function ResolveSchedule(name: string): ProviderSchedule {
  const schedule = SCHEDULES[name];
  if (!schedule) {
    throw new Error(
      `Unknown providerSchedule "${name}"; known: ${Object.keys(SCHEDULES).join(", ")}`,
    );
  }
  return schedule;
}
