import {
  InvalidSubscriptionRequestError,
  SUBSCRIPTION_INTERVALS,
  type SubscriptionRequest,
} from "@antelopejs/interface-subscriptions";

type Rule = (request: SubscriptionRequest, now: number) => string | undefined;

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function futureTime(value: number | undefined, now: number): boolean {
  return value === undefined || (Number.isFinite(value) && value > now);
}

const RULES: Rule[] = [
  (request) =>
    request.reference ? undefined : "reference must be a non-empty string",
  (request) => (request.customer ? undefined : "customer is required"),
  (request) =>
    request.paymentMethod ? undefined : "paymentMethod is required",
  (request) =>
    positiveInteger(request.amount?.value)
      ? undefined
      : "amount must be a positive integer of minor units",
  (request) =>
    /^[A-Z]{3}$/.test(request.amount?.currency ?? "")
      ? undefined
      : "amount.currency must be an uppercase ISO-4217 code",
  (request) =>
    SUBSCRIPTION_INTERVALS.includes(request.interval)
      ? undefined
      : `interval must be one of ${SUBSCRIPTION_INTERVALS.join(", ")}`,
  (request) =>
    request.intervalCount === undefined ||
    positiveInteger(request.intervalCount)
      ? undefined
      : "intervalCount must be a positive integer",
  (request) =>
    request.trialEnd !== undefined && request.billingAnchor !== undefined
      ? "trialEnd and billingAnchor are mutually exclusive"
      : undefined,
  (request, now) =>
    futureTime(request.trialEnd, now)
      ? undefined
      : "trialEnd must be in the future",
  (request, now) =>
    futureTime(request.billingAnchor, now)
      ? undefined
      : "billingAnchor must be in the future",
];

export function ValidateRequest(
  request: SubscriptionRequest,
  now: number,
): void {
  const problem = RULES.map((rule) => rule(request, now)).find(Boolean);
  if (problem) throw new InvalidSubscriptionRequestError(problem);
}
