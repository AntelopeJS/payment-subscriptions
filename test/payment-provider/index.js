const payment = require("@antelopejs/interface-payment");
const { ImplementInterface } = require("@antelopejs/interface-core");

/**
 * @typedef {import("@antelopejs/interface-payment").Customer} Customer
 * @typedef {import("@antelopejs/interface-payment").CustomerRequest} CustomerRequest
 * @typedef {import("@antelopejs/interface-payment").Payment} Payment
 * @typedef {import("@antelopejs/interface-payment").PaymentMethod} PaymentMethod
 * @typedef {import("@antelopejs/interface-payment").PaymentRequest} PaymentRequest
 * @typedef {import("@antelopejs/interface-payment").PaymentStatus} PaymentStatus
 * @typedef {import("./index.d.ts").LedgerEntry} LedgerEntry
 * @typedef {import("./index.d.ts").TestControl} TestControl
 */

/** @typedef {"tok_succeeds" | "tok_declines_off_session" | "tok_settles_later" | "tok_fails_later"} Token */

const TOKENS = Object.freeze({
  succeeds: "tok_succeeds",
  declinesOffSession: "tok_declines_off_session",
  settlesLater: "tok_settles_later",
  failsLater: "tok_fails_later",
});

const ACCOUNTS = ["default", "secondary"];
const READS_BEFORE_SETTLING = 2;
const ZERO = 0;

/** @type {Record<Token, PaymentStatus>} */
const OFF_SESSION_OUTCOMES = {
  [TOKENS.succeeds]: "succeeded",
  [TOKENS.declinesOffSession]: "failed",
  [TOKENS.settlesLater]: "pending",
  [TOKENS.failsLater]: "pending",
};

/** @type {Partial<Record<Token, PaymentStatus>>} */
const SETTLED_OUTCOMES = {
  [TOKENS.settlesLater]: "succeeded",
  [TOKENS.failsLater]: "failed",
};

const DECLINE = Object.freeze({
  code: "declined",
  message: "The test provider declined this off-session charge",
  providerCode: "test_declined",
});

/**
 * @typedef {Payment & { token: Token, reads: number, request?: PaymentRequest }} PaymentRecord
 * @typedef {{ id: string, customer: string, token: Token, createdAt: number }} SavedMethod
 * @typedef {{
 *   customers: Map<string, Customer>,
 *   methods: Map<string, SavedMethod>,
 *   payments: Map<string, PaymentRecord>,
 *   replies: Map<string, string>,
 *   sequence: number,
 * }} Account
 */

/** @returns {Account} */
function emptyAccount() {
  return {
    customers: new Map(),
    methods: new Map(),
    payments: new Map(),
    replies: new Map(),
    sequence: 0,
  };
}

/** @type {{ accounts: Map<string, Account>, ledger: LedgerEntry[], isUnreachable: boolean, losesResponses: boolean }} */
const state = {
  accounts: new Map(),
  ledger: [],
  isUnreachable: false,
  losesResponses: false,
};

function reset() {
  state.accounts = new Map(ACCOUNTS.map((name) => [name, emptyAccount()]));
  state.ledger = [];
  state.isUnreachable = false;
  state.losesResponses = false;
}
reset();

/**
 * @param {string | undefined} provider
 * @returns {Account}
 */
function account(provider) {
  const found = state.accounts.get(provider ?? "default");
  if (!found) throw new payment.PaymentError(`No such account: ${provider}`);
  return found;
}

/**
 * @param {Account} store
 * @param {string} prefix
 * @returns {string}
 */
function mint(store, prefix) {
  store.sequence += 1;
  return `${prefix}_${store.sequence}`;
}

/**
 * @param {Account} store
 * @param {string | undefined} method
 * @returns {Token}
 */
function behaviourOf(store, method) {
  const known = Object.values(TOKENS).find((token) => token === method);
  if (known) return known;
  const saved = store.methods.get(method);
  if (!saved) throw new payment.CustomerNotFoundError(method, "payment method");
  return saved.token;
}

/** @param {PaymentRequest} request */
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

/**
 * @param {Token} token
 * @param {PaymentRequest} request
 * @returns {PaymentStatus}
 */
function outcomeFor(token, request) {
  return request.offSession ? OFF_SESSION_OUTCOMES[token] : "succeeded";
}

/** @type {readonly ("customer" | "paymentMethod")[]} */
const OPTIONAL_FIELDS = ["customer", "paymentMethod"];

/**
 * @param {Account} store
 * @param {PaymentRequest} request
 * @param {Token} token
 * @param {PaymentStatus} status
 * @returns {PaymentRecord}
 */
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

/**
 * @param {PaymentRecord} record
 * @returns {Payment}
 */
function publicView(record) {
  const view = { ...record };
  delete view.token;
  delete view.reads;
  delete view.request;
  return view;
}

/**
 * @param {Account} store
 * @param {string | undefined} customer
 * @param {Token} token
 */
function saveMethod(store, customer, token) {
  const id = mint(store, "pm");
  store.methods.set(id, {
    id,
    customer,
    token,
    createdAt: Date.now() + store.sequence,
  });
}

/**
 * @param {Account} store
 * @param {PaymentRequest} request
 * @param {Token} token
 * @returns {PaymentRecord}
 */
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

/** @type {readonly ("paymentMethod" | "customer")[]} */
const COMPARED_FIELDS = ["paymentMethod", "customer"];

/**
 * @param {PaymentRecord} original
 * @param {PaymentRequest} request
 * @returns {Payment}
 */
function replay(original, request) {
  const differs =
    COMPARED_FIELDS.some(
      (field) => original.request[field] !== request[field],
    ) || original.amount.value !== request.amount.value;
  if (differs) {
    throw new payment.PaymentError(
      "Keys for idempotent requests can only be used with the same parameters they were first used with",
      "idempotency_error",
    );
  }
  return publicView(original);
}

/**
 * @param {PaymentRecord} record
 * @returns {Payment}
 */
function loseResponse(record) {
  if (!state.losesResponses) return publicView(record);
  throw new payment.PaymentError(
    `The response to ${record.id} was lost`,
    "test_response_lost",
  );
}

/** @type {typeof payment.CreatePayment} */
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
  if (replayed) return replay(store.payments.get(replayed), request);
  if (request.customer && !store.customers.has(request.customer)) {
    throw new payment.CustomerNotFoundError(request.customer);
  }
  const record = charge(
    store,
    request,
    behaviourOf(store, request.paymentMethod),
  );
  record.request = request;
  store.replies.set(idempotencyKey, record.id);
  return loseResponse(record);
}

/** @param {PaymentRecord} record */
function settleOnRead(record) {
  record.reads += 1;
  if (record.status !== "pending" || record.reads < READS_BEFORE_SETTLING)
    return;
  record.status = SETTLED_OUTCOMES[record.token];
  if (record.status === "succeeded")
    record.amountCaptured = { ...record.amount };
  if (record.status === "failed") record.failure = { ...DECLINE };
}

/** @type {typeof payment.GetPayment} */
async function GetPayment(id, provider) {
  assertReachable();
  const record = account(provider).payments.get(id);
  if (!record) throw new payment.PaymentNotFoundError(id);
  settleOnRead(record);
  return publicView(record);
}

/** @type {typeof payment.CreateCustomer} */
async function CreateCustomer(request, idempotencyKey, provider) {
  const store = account(provider);
  const replayed = store.replies.get(idempotencyKey);
  if (replayed) return { id: replayed };
  const id = mint(store, "cus");
  store.customers.set(id, { id, ...request });
  store.replies.set(idempotencyKey, id);
  return { id, ...request };
}

/** @type {typeof payment.GetCustomer} */
async function GetCustomer(id, provider) {
  const customer = account(provider).customers.get(id);
  if (!customer) throw new payment.CustomerNotFoundError(id);
  return customer;
}

/** @type {typeof payment.DeleteCustomer} */
async function DeleteCustomer(id, _idempotencyKey, provider) {
  const store = account(provider);
  if (!store.customers.delete(id)) throw new payment.CustomerNotFoundError(id);
  for (const [methodId, method] of store.methods) {
    if (method.customer === id) store.methods.delete(methodId);
  }
}

/** @type {typeof payment.ListPaymentMethods} */
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

/** @type {typeof payment.DetachPaymentMethod} */
async function DetachPaymentMethod(id, _idempotencyKey, provider) {
  if (!account(provider).methods.delete(id)) {
    throw new payment.CustomerNotFoundError(id, "payment method");
  }
}

/**
 * @param {string} operation
 * @returns {() => Promise<never>}
 */
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

/** @type {TestControl} */
const testControl = {
  TOKENS,
  reset,
  /** @param {boolean} isUnreachable */
  setUnreachable: (isUnreachable) => {
    state.isUnreachable = isUnreachable;
  },
  /** @param {boolean} losesResponses */
  setLosesResponses: (losesResponses) => {
    state.losesResponses = losesResponses;
  },
  ledger: () => state.ledger,
  /** @param {string} subscriptionId */
  chargesFor: (subscriptionId) =>
    state.ledger.filter(
      (entry) =>
        entry.request.metadata?.antelopeSubscription === subscriptionId,
    ),
  /**
   * @param {string} id
   * @param {string} [provider]
   */
  paymentStatus: (id, provider) => account(provider).payments.get(id)?.status,
};

module.exports = { construct, testControl };
