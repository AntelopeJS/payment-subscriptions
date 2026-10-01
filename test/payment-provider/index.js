const payment = require("@antelopejs/interface-payment");
const { ImplementInterface } = require("@antelopejs/interface-core");

const TOKENS = Object.freeze({
  succeeds: "tok_succeeds",
  declinesOffSession: "tok_declines_off_session",
  settlesLater: "tok_settles_later",
  failsLater: "tok_fails_later",
});

const ACCOUNTS = ["default", "secondary"];
const READS_BEFORE_SETTLING = 2;
const ZERO = 0;

const OFF_SESSION_OUTCOMES = {
  [TOKENS.succeeds]: "succeeded",
  [TOKENS.declinesOffSession]: "failed",
  [TOKENS.settlesLater]: "pending",
  [TOKENS.failsLater]: "pending",
};

const SETTLED_OUTCOMES = {
  [TOKENS.settlesLater]: "succeeded",
  [TOKENS.failsLater]: "failed",
};

const DECLINE = Object.freeze({
  code: "declined",
  message: "The test provider declined this off-session charge",
  providerCode: "test_declined",
});

function emptyAccount() {
  return {
    customers: new Map(),
    methods: new Map(),
    payments: new Map(),
    replies: new Map(),
    sequence: 0,
  };
}

const state = { accounts: new Map(), ledger: [], isUnreachable: false };

function reset() {
  state.accounts = new Map(ACCOUNTS.map((name) => [name, emptyAccount()]));
  state.ledger = [];
  state.isUnreachable = false;
}
reset();

function account(provider) {
  const found = state.accounts.get(provider ?? "default");
  if (!found) throw new payment.PaymentError(`No such account: ${provider}`);
  return found;
}

function mint(store, prefix) {
  store.sequence += 1;
  return `${prefix}_${store.sequence}`;
}

function behaviourOf(store, method) {
  if (Object.values(TOKENS).includes(method)) return method;
  const saved = store.methods.get(method);
  if (!saved) throw new payment.CustomerNotFoundError(method, "payment method");
  return saved.token;
}

function assertConsistent(request) {
  if (request.savePaymentMethod && request.offSession) {
    throw new payment.PaymentError(
      "savePaymentMethod cannot be combined with offSession",
    );
  }
  if (request.offSession && !request.paymentMethod) {
    throw new payment.PaymentError(
      "An off-session payment needs a saved paymentMethod",
    );
  }
  if (request.savePaymentMethod && !request.customer) {
    throw new payment.PaymentError("savePaymentMethod requires a customer");
  }
}

function outcomeFor(token, request) {
  return request.offSession ? OFF_SESSION_OUTCOMES[token] : "succeeded";
}

const OPTIONAL_FIELDS = ["customer", "paymentMethod"];

function buildPayment(store, request, token, status) {
  const zero = { value: ZERO, currency: request.amount.currency };
  const record = {
    id: mint(store, "pay"),
    amount: { ...request.amount },
    amountCaptured: status === "succeeded" ? { ...request.amount } : zero,
    amountRefunded: zero,
    status,
    reference: request.reference,
    createdAt: Date.now(),
    token,
    reads: 0,
  };
  for (const field of OPTIONAL_FIELDS) {
    if (request[field]) record[field] = request[field];
  }
  if (request.metadata) record.metadata = { ...request.metadata };
  if (status === "failed") record.failure = { ...DECLINE };
  return record;
}

function publicView(record) {
  const view = { ...record };
  delete view.token;
  delete view.reads;
  return view;
}

function saveMethod(store, customer, token) {
  const id = mint(store, "pm");
  store.methods.set(id, {
    id,
    customer,
    token,
    createdAt: Date.now() + store.sequence,
  });
}

function charge(store, request, token) {
  const record = buildPayment(
    store,
    request,
    token,
    outcomeFor(token, request),
  );
  store.payments.set(record.id, record);
  if (request.savePaymentMethod && record.status === "succeeded") {
    saveMethod(store, request.customer, token);
  }
  return record;
}

function assertReachable() {
  if (state.isUnreachable) {
    throw new payment.PaymentError(
      "The test provider is unreachable",
      "test_unreachable",
    );
  }
}

async function CreatePayment(request, idempotencyKey, provider) {
  assertConsistent(request);
  const store = account(provider);
  if (state.isUnreachable) {
    state.ledger.push({
      request,
      idempotencyKey,
      provider,
      replayed: false,
      unreachable: true,
    });
  }
  assertReachable();
  const replayed = store.replies.get(idempotencyKey);
  state.ledger.push({
    request,
    idempotencyKey,
    provider,
    replayed: Boolean(replayed),
  });
  if (replayed) return publicView(store.payments.get(replayed));
  if (request.customer && !store.customers.has(request.customer)) {
    throw new payment.CustomerNotFoundError(request.customer);
  }
  const record = charge(
    store,
    request,
    behaviourOf(store, request.paymentMethod),
  );
  store.replies.set(idempotencyKey, record.id);
  return publicView(record);
}

function settleOnRead(record) {
  record.reads += 1;
  if (record.status !== "pending" || record.reads < READS_BEFORE_SETTLING)
    return;
  record.status = SETTLED_OUTCOMES[record.token];
  if (record.status === "succeeded")
    record.amountCaptured = { ...record.amount };
  if (record.status === "failed") record.failure = { ...DECLINE };
}

async function GetPayment(id, provider) {
  assertReachable();
  const record = account(provider).payments.get(id);
  if (!record) throw new payment.PaymentNotFoundError(id);
  settleOnRead(record);
  return publicView(record);
}

async function CreateCustomer(request, idempotencyKey, provider) {
  const store = account(provider);
  const replayed = store.replies.get(idempotencyKey);
  if (replayed) return { id: replayed };
  const id = mint(store, "cus");
  store.customers.set(id, { id, ...request });
  store.replies.set(idempotencyKey, id);
  return { id, ...request };
}

async function GetCustomer(id, provider) {
  const customer = account(provider).customers.get(id);
  if (!customer) throw new payment.CustomerNotFoundError(id);
  return customer;
}

async function DeleteCustomer(id, _idempotencyKey, provider) {
  const store = account(provider);
  if (!store.customers.delete(id)) throw new payment.CustomerNotFoundError(id);
  for (const [methodId, method] of store.methods) {
    if (method.customer === id) store.methods.delete(methodId);
  }
}

async function ListPaymentMethods(customer, provider) {
  const store = account(provider);
  if (!store.customers.has(customer))
    throw new payment.CustomerNotFoundError(customer);
  return [...store.methods.values()]
    .filter((method) => method.customer === customer)
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((method) => ({
      id: method.id,
      type: "card",
      customer,
      createdAt: method.createdAt,
    }));
}

async function DetachPaymentMethod(id, _idempotencyKey, provider) {
  if (!account(provider).methods.delete(id)) {
    throw new payment.CustomerNotFoundError(id, "payment method");
  }
}

function unsupported(operation) {
  return async () => {
    throw new payment.UnsupportedOperationError(operation);
  };
}

const UNSUPPORTED = [
  "CreateCheckoutSession",
  "GetCheckoutSession",
  "CapturePayment",
  "CancelPayment",
  "RefundPayment",
  "GetRefund",
  "VerifyWebhook",
];

const implementation = {
  CreatePayment,
  GetPayment,
  CreateCustomer,
  GetCustomer,
  DeleteCustomer,
  ListPaymentMethods,
  DetachPaymentMethod,
  ...Object.fromEntries(UNSUPPORTED.map((name) => [name, unsupported(name)])),
};

function construct() {
  ImplementInterface(payment, implementation);
}

const testControl = {
  TOKENS,
  reset,
  setUnreachable: (isUnreachable) => {
    state.isUnreachable = isUnreachable;
  },
  ledger: () => state.ledger,
  chargesFor: (subscriptionId) =>
    state.ledger.filter(
      (entry) =>
        entry.request.metadata?.antelopeSubscription === subscriptionId,
    ),
  paymentStatus: (id, provider) => account(provider).payments.get(id)?.status,
};

module.exports = { construct, testControl };
