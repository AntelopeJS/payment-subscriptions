import { equal, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { AMOUNT, SUCCEEDS, answer, create, post, prepare, startStack, type Stack } from "./stack.ts";

const ORDER_METADATA = { order: "A-1" };

interface ChargedPayment {
  amount: { value: number; currency: string };
  reference: string;
  customer: string;
  paymentMethod: string;
  status: string;
  metadata: Record<string, string>;
}

function getPayment(context: JourneyContext, stack: Stack, id: string) {
  return post(context, stack, "GetPayment of the charge", "/call", JSON.stringify({ interface: "@antelopejs/interface-payment", path: ["GetPayment"], args: [id] }));
}

export const chargeJourneys = {
    "charge-request": {
      title: "the charge the module sends to the payment provider names the subscription, the customer's method, the amount and the subscription's metadata",
      entryPoint: "`CreateSubscription`, then `GetPayment` of the interface-payment contract on the charge it made",
      async run(context) {
        const stack = await startStack(context, "ajs project dev");
        const prepared = await prepare(context, stack, SUCCEEDS);
        const { sub } = await create(context, stack, { name: "CreateSubscription with metadata", prepared: prepared, key: "charge-request-create", overrides: { metadata: ORDER_METADATA } });
        context.expect(stack.app.folder, [equal("the first period was charged", sub.latestPayment !== undefined, true)], { critical: true });
        const read = await getPayment(context, stack, sub.latestPayment ?? "");
        const charged = answer<ChargedPayment>(read).value;
        context.expect(read.folder, [
          equal("the provider holds the charge", answer(read).ok, true),
          equal("it succeeded for the subscription's amount", [charged?.status, charged?.amount], ["succeeded", AMOUNT]),
          equal("it charged the customer's saved method", [charged?.customer, charged?.paymentMethod], [prepared.customer, prepared.method]),
          equal("it carries the subscription's reference", charged?.reference, "verify-order"),
          equal("it names the subscription and keeps the subscription's own metadata", charged?.metadata, { ...ORDER_METADATA, antelopeSubscription: sub.id }),
        ]);
        await context.stop("SIGINT", stack.app);
      },
    },
} satisfies Record<string, Journey>;
