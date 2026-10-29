import { realpathSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";

import {
  equal,
  type App,
  type CommandResult,
  type HttpResult,
  type JourneyContext,
} from "@antelopejs/tooling-configs/verify";

export const DATABASE = "verify";
export const COLLECTION = "payment-subscriptions__subscriptions";
export const AMOUNT = { value: 1900, currency: "EUR" };
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WAIT_MS = 3000;
export const WAIT_ROUNDS = 4;
export const SUCCEEDS = "tok_succeeds";
export const DECLINES = "tok_declines_off_session";
export const SANDBOX_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];

/** The consumer module of the fixture: the interfaces' callers, reachable over HTTP, plus a recorder of every subscription event. */
const BRIDGE_SOURCE = String.raw`"use strict";
const http = require("node:http");
const events = [];
let server;
async function route(url, body) {
  if (url.pathname === "/call") {
    let target = require(body.interface);
    for (const key of body.path) target = target[key];
    return await target(...(body.args || []));
  }
  if (url.pathname === "/prepare") {
    const payment = require("@antelopejs/interface-payment");
    const customer = body.customer ? { id: body.customer } : await payment.CreateCustomer({}, "verify-" + Date.now() + "-" + Math.random());
    const before = body.customer ? await payment.ListPaymentMethods(customer.id) : [];
    await payment.CreatePayment(
      { amount: { value: 1900, currency: "EUR" }, reference: "verify-save", customer: customer.id, paymentMethod: body.token, savePaymentMethod: true, returnUrl: "https://merchant.invalid/return" },
      "save-" + customer.id + "-" + Math.random(),
    );
    const methods = await payment.ListPaymentMethods(customer.id);
    const added = methods.find((method) => !before.some((known) => known.id === method.id)) || methods[methods.length - 1];
    return { customer: customer.id, method: added.id };
  }
  if (url.pathname === "/wait") {
    const subscriptions = require("@antelopejs/interface-subscriptions");
    const deadline = Date.now() + (body.timeoutMs || 10000);
    for (;;) {
      const found = await subscriptions.GetSubscription(body.id);
      if (found.status === body.status || Date.now() > deadline) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (url.pathname === "/events") return events;
  throw new Error("no route " + url.pathname);
}
exports.construct = function construct() {};
exports.start = async function start() {
  require("@antelopejs/interface-subscriptions").SubscriptionEvents.register("verify-bridge", (event) => {
    events.push(event);
  });
  server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    try {
      const value = await route(new URL(request.url, "http://bridge"), text ? JSON.parse(text) : {});
      response.end(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
    } catch (error) {
      response.end(JSON.stringify({ ok: false, error: { name: error.name, message: error.message, code: error.code } }));
    }
  });
  await new Promise((resolve) => server.listen(Number(process.env.VERIFY_BRIDGE_PORT), "127.0.0.1", resolve));
};
exports.stop = function stop() {
  if (server) server.close();
};
exports.destroy = function destroy() {};
`;

export interface ProjectModule {
  source: { type: "local"; path: string };
  config?: ModuleConfig;
}

export type ModuleConfig = NonNullable<NonNullable<Parameters<JourneyContext["fixture"]>[0]>["moduleConfig"]>;

export interface Answer<Value = never> {
  ok?: boolean;
  value?: Value;
  error?: { name: string; message: string; code?: string };
}

export function answer<Value = never>(result: HttpResult): Answer<Value> {
  // SAFETY: the bridge module of the fixture always answers `{ ok, value }` or `{ ok, error }` JSON.
  return result.json as Answer<Value>;
}

export interface Sub {
  id: string;
  reference: string;
  customer: string;
  paymentMethod: string;
  amount: { value: number; currency: string };
  interval: string;
  intervalCount: number;
  status: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  trialEnd?: number;
  cancelAtPeriodEnd: boolean;
  endedAt?: number;
  endReason?: string;
  latestPayment?: string;
}

export interface Stored {
  _id: string;
  phase: string;
  status: string;
  customer: string;
  paymentMethod: string;
  amount: { value: number; currency: string };
  endReason: string | null;
  cancelAtPeriodEnd: boolean;
  attempt: number;
  latestPayment: string | null;
  trialEnd: number | null;
  outbox: unknown[];
}

export interface SubEvent {
  id: string;
  type: string;
  createdAt: number;
  payment?: string;
  subscription: Sub;
}

export interface Prepared {
  customer: string;
  method: string;
}

export interface Stack {
  project: string;
  port: number;
  app: App;
  url: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a TCP server that listens on a port reports an AddressInfo, not a pipe path.
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export function mongoUrl(context: JourneyContext): string {
  const mongo = context.service("mongo");
  return `mongodb://${mongo.host}:${mongo.port}`;
}

/** Runs mongosh inside the run's own MongoDB container: the second view every journey reads state through. */
export function mongosh(context: JourneyContext, name: string, script: string): Promise<CommandResult> {
  return context.native(name, "mongo", ["mongosh", "--quiet", "--eval", script]);
}

export function collection(): string {
  return `db.getSiblingDB('${DATABASE}').getCollection('${COLLECTION}')`;
}

export async function stored(context: JourneyContext, name: string, id: string): Promise<{ folder: string; record: Stored | undefined }> {
  const read = await mongosh(context, name, `JSON.stringify(${collection()}.findOne({ _id: '${id}' }))`);
  const text = read.stdout.trim();
  // SAFETY: mongosh printed the JSON of the stored record, or `null` when there is none.
  return { folder: read.folder, record: text === "null" || text === "" ? undefined : (JSON.parse(text) as Stored) };
}

export async function storedCount(context: JourneyContext, name: string): Promise<{ folder: string; count: string }> {
  const read = await mongosh(context, name, `${collection()}.countDocuments({})`);
  return { folder: read.folder, count: read.stdout.trim() };
}

export function repoModule(context: JourneyContext, name: string): string {
  return realpathSync(join(context.repo, "node_modules", name));
}

/** Writes the fixture project: this module, the in-repo test payment provider, MongoDB, optionally Redis, and the bridge. */
export async function prepareStack(context: JourneyContext, options: { config?: ModuleConfig; redis?: boolean } = {}): Promise<{ project: string; port: number }> {
  const config: ModuleConfig = { pollIntervalMs: 100, ...options.config };
  const project = context.fixture({ moduleConfig: config });
  const bridge = join(project, "bridge");
  context.edit("bridge package", join(bridge, "package.json"), `${JSON.stringify({ name: "verify-bridge", version: "1.0.0", main: "index.js" })}\n`);
  context.edit("bridge source", join(bridge, "index.js"), BRIDGE_SOURCE);
  const links = ["interface-core", "interface-payment", "interface-subscriptions"]
    .map((interfaceName) => `ln -sfn ${repoModule(context, `@antelopejs/${interfaceName}`)} ${join(bridge, "node_modules/@antelopejs", interfaceName)}`)
    .join(" && ");
  await context.command("link the interfaces into the bridge", "sh", ["-c", `mkdir -p ${join(bridge, "node_modules/@antelopejs")} && ${links}`]);
  const modules: Record<string, ProjectModule> = {};
  modules.subscriptions = { source: { type: "local", path: context.repo }, config };
  modules.payments = { source: { type: "local", path: join(context.repo, "test/payment-provider") } };
  modules.mongodb = { source: { type: "local", path: repoModule(context, "@antelopejs/mongodb") }, config: { url: mongoUrl(context), database: DATABASE } };
  modules["verify-driver"] = { source: { type: "local", path: "./driver" } };
  modules["verify-bridge"] = { source: { type: "local", path: "./bridge" } };
  if (options.redis) {
    const redis = context.service("redis");
    modules.redis = { source: { type: "local", path: repoModule(context, "@antelopejs/redis") }, config: { url: `redis://${redis.host}:${redis.port}` } };
  }
  context.edit("project config", join(project, "antelope.config.ts"), `export default ${JSON.stringify({ name: "verify-subscriptions", modules }, null, 2)};\n`);
  return { project, port: await freePort() };
}

export async function launch(context: JourneyContext, name: string, prepared: { project: string; port: number }): Promise<Stack> {
  const app = await context.dev(name, prepared.project, { env: { VERIFY_BRIDGE_PORT: String(prepared.port) } });
  return { ...prepared, app, url: `http://127.0.0.1:${prepared.port}` };
}

export async function startStack(context: JourneyContext, name: string, options: { config?: ModuleConfig; redis?: boolean } = {}): Promise<Stack> {
  return launch(context, name, await prepareStack(context, options));
}

export function post(context: JourneyContext, stack: Stack, name: string, route: string, body: string): Promise<HttpResult> {
  return context.http(name, `${stack.url}${route}`, { method: "POST", body });
}

export async function prepare(context: JourneyContext, stack: Stack, token: string, customer?: string): Promise<Prepared> {
  const result = await post(context, stack, `prepare a customer with ${token}`, "/prepare", JSON.stringify(customer === undefined ? { token } : { token, customer }));
  const prepared = answer<Prepared>(result);
  context.expect(result.folder, [equal("a customer with a saved method exists", prepared.ok, true)], { critical: true });
  return prepared.value ?? { customer: "", method: "" };
}

export function call(context: JourneyContext, stack: Stack, name: string, fn: string, args: unknown[]): Promise<HttpResult> {
  return post(context, stack, name, "/call", JSON.stringify({ interface: "@antelopejs/interface-subscriptions", path: [fn], args }));
}

export interface Overrides {
  reference?: string;
  interval?: string;
  intervalCount?: number;
  trialEnd?: number;
  billingAnchor?: number;
  amount?: { value: number; currency: string };
}

export function request(prepared: Prepared, overrides: Overrides = {}) {
  return { reference: "verify-order", customer: prepared.customer, paymentMethod: prepared.method, amount: AMOUNT, interval: "month", ...overrides };
}

export interface Created {
  sub: Sub;
  folder: string;
}

export interface CreateSpec {
  name: string;
  prepared: Prepared;
  key: string;
  overrides?: Overrides;
}

export async function create(context: JourneyContext, stack: Stack, { name, prepared, key, overrides }: CreateSpec): Promise<Created> {
  const created = await call(context, stack, name, "CreateSubscription", [request(prepared, overrides), key]);
  const found = answer<Sub>(created);
  context.expect(created.folder, [equal("the subscription was created", found.ok, true)], { critical: true });
  // SAFETY: a created subscription is always answered with its value.
  return { sub: found.value as Sub, folder: created.folder };
}

export function failure(result: HttpResult): string {
  const error = answer(result).error;
  return `${error?.name ?? "no error"}: ${error?.message ?? ""}`;
}

export async function waitFor(context: JourneyContext, stack: Stack, name: string, id: string, status: string): Promise<Sub | undefined> {
  let latest: Sub | undefined;
  for (let attempt = 0; attempt < WAIT_ROUNDS; attempt += 1) {
    const result = await post(context, stack, `${name} (${attempt + 1})`, "/wait", JSON.stringify({ id, status, timeoutMs: WAIT_MS }));
    latest = answer<Sub>(result).value;
    if (latest?.status === status) break;
  }
  return latest;
}

export async function eventsOf(context: JourneyContext, stack: Stack, name: string): Promise<{ folder: string; events: SubEvent[] }> {
  const result = await context.http(name, `${stack.url}/events`);
  return { folder: result.folder, events: answer<SubEvent[]>(result).value ?? [] };
}

