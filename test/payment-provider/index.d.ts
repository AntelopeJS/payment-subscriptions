import type { PaymentRequest } from "@antelopejs/interface-payment";

/** One call the in-memory provider received, in the order it arrived. */
export interface LedgerEntry {
  request: PaymentRequest;
  idempotencyKey: string;
  provider: string | undefined;
  replayed: boolean;
  unreachable?: boolean;
}

/** What the suite reads and drives on the in-memory provider. */
export interface TestControl {
  TOKENS: {
    readonly succeeds: "tok_succeeds";
    readonly declinesOffSession: "tok_declines_off_session";
    readonly settlesLater: "tok_settles_later";
    readonly failsLater: "tok_fails_later";
  };
  reset(): void;
  setUnreachable(isUnreachable: boolean): void;
  setLosesResponses(losesResponses: boolean): void;
  ledger(): LedgerEntry[];
  chargesFor(subscriptionId: string): LedgerEntry[];
  paymentStatus(id: string, provider?: string): string | undefined;
}

export declare function construct(): void;
export declare const testControl: TestControl;
