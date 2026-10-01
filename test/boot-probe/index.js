const payment = require("@antelopejs/interface-payment");
const { setTimeout: delay } = require("node:timers/promises");
const subscriptions = require("@antelopejs/interface-subscriptions");

const TRIAL_MS = 1000;
const POLL_MS = 100;
const POLLS = 100;
const AMOUNT = { value: 1900, currency: "EUR" };

async function savedMethod(customer) {
  await payment.CreatePayment(
    {
      amount: AMOUNT,
      reference: "boot-probe-save",
      customer,
      paymentMethod: "tok_succeeds",
      savePaymentMethod: true,
      returnUrl: "https://merchant.invalid/return",
    },
    `boot-probe-save-${customer}`,
  );
  const [method] = await payment.ListPaymentMethods(customer);
  return method.id;
}

async function run() {
  const customer = await payment.CreateCustomer({}, `boot-probe-${Date.now()}`);
  const created = await subscriptions.CreateSubscription(
    {
      reference: "boot-probe",
      customer: customer.id,
      paymentMethod: await savedMethod(customer.id),
      amount: AMOUNT,
      interval: "month",
      trialEnd: Date.now() + TRIAL_MS,
    },
    `boot-probe-${customer.id}`,
  );
  process.stdout.write(`SUBSCRIBED ${created.status}\n`);
  for (let poll = 0; poll < POLLS; poll += 1) {
    const current = await subscriptions.GetSubscription(created.id);
    if (current.status === "active" && current.latestPayment) {
      process.stdout.write("RENEWED\n");
      return;
    }
    await delay(POLL_MS);
  }
  process.stdout.write("NOT RENEWED\n");
}

module.exports = {
  construct() {},
  start() {
    run().catch((error) =>
      process.stdout.write(`PROBE FAILED ${error.message}\n`),
    );
  },
};
