import type { PaymentError } from "@antelopejs/interface-payment";

/**
 * Whether `error` is a `PaymentError`, including one built by another copy of
 * the payment interface package, which `instanceof` rejects. Every
 * `PaymentError` carries an own `providerCode` property, set even when undefined.
 */
export function IsPaymentError(error: unknown): error is PaymentError {
  if (!(error instanceof Error) || !("providerCode" in error)) return false;
  return (
    error.providerCode === undefined || typeof error.providerCode === "string"
  );
}
