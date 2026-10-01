import { CreatePayment, type Payment } from "@antelopejs/interface-payment";
import { SUBSCRIPTION_METADATA_KEY } from "@antelopejs/interface-subscriptions";

import type { Snapshot } from "./records";

/** One charge the renewal clock has decided to make. */
interface ScheduledCharge {
  subscription: Snapshot;
  /** The payment-interface account, or undefined for the default one. */
  provider: string | undefined;
  /** What the provider recorded at registration, if anything. */
  providerReference: string | undefined;
  idempotencyKey: string;
}

/**
 * The seam between the module's clock and what the provider can hold.
 *
 * This module always owns the clock. Some providers that leave the merchant to
 * fire each charge will still store the schedule and handle the
 * authentication chain between charges — Mangopay's Recurring PayIn
 * Registration is the case in point. A schedule for such a provider registers
 * the subscription there, charges against that registration, and releases it
 * when the subscription ends. The default records nothing and charges a plain
 * off-session payment.
 *
 * None of these may throw for a decline: a declined charge resolves with a
 * `failed` payment, exactly as the payment interface's `CreatePayment` does.
 */
export interface ProviderSchedule {
  /** Records the schedule with the provider. Returns its reference, if any. */
  register(
    subscription: Snapshot,
    provider: string | undefined,
  ): Promise<string | undefined>;
  /** Charges one period. */
  charge(charge: ScheduledCharge): Promise<Payment>;
  /** Tells the provider the schedule has ended. */
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
