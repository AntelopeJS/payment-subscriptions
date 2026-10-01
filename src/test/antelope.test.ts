import { RedisMemoryServer } from "redis-memory-server";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import {
  type AntelopeModuleConfig,
  defineConfig,
} from "@antelopejs/interface-core/config";

/**
 * Two runs of one suite, one per renewal clock. `pnpm test` runs both.
 *
 * - polling: no Redis module is loaded at all, so the module must notice that
 *   and poll the database instead of waiting on a Redis client nobody will
 *   provide.
 * - redis: the real `@antelopejs/redis` module against a real Redis server,
 *   with the database sweep stretched to an hour so that anything renewed on
 *   time was renewed by Redis.
 *
 * Both run a real MongoDB through the real `@antelopejs/mongodb` module, since
 * the claim that keeps a renewal from being charged twice is the database's
 * conditional write and nothing else.
 */
const CLOCK =
  process.env.ANTELOPE_SUBSCRIPTIONS_TEST_CLOCK === "redis"
    ? "redis"
    : "polling";
const MONGO_VERSION = "8.0.8";
const TEST_POLL_MS = 100;
const HOUR_MS = 60 * 60 * 1000;

const PAYMENT_ENV = {
  ANTELOPE_PAYMENT_TEST_METHOD: "tok_succeeds",
  ANTELOPE_SUBSCRIPTIONS_TEST_METHOD_DECLINES_LATER: "tok_declines_off_session",
  ANTELOPE_SUBSCRIPTIONS_TEST_EVENTS: "1",
  ANTELOPE_PAYMENT_TEST_CURRENCY: "EUR",
};

let mongod: MongoMemoryServer | undefined;
let redis: RedisMemoryServer | undefined;

async function redisModules(): Promise<Record<string, AntelopeModuleConfig>> {
  if (CLOCK !== "redis") return {};
  redis = new RedisMemoryServer();
  const url = `redis://${await redis.getHost()}:${await redis.getPort()}`;
  process.env.ANTELOPE_SUBSCRIPTIONS_TEST_REDIS_URL = url;
  return {
    redis: {
      source: {
        type: "local" as const,
        path: "node_modules/@antelopejs/redis",
      },
      config: { url },
    },
  };
}

export default defineConfig({
  name: "payment-subscriptions-test",
  cacheFolder: ".antelope/cache",
  modules: {
    local: { source: { type: "local", path: "." } },
    payments: { source: { type: "local", path: "test/payment-provider" } },
    mongodb: {
      source: { type: "local", path: "node_modules/@antelopejs/mongodb" },
    },
  },
  test: {
    folder: "dist/test",
    async setup() {
      Object.assign(process.env, PAYMENT_ENV, {
        ANTELOPE_SUBSCRIPTIONS_TEST_CLOCK: CLOCK,
      });
      mongod = await MongoMemoryServer.create({
        binary: { version: MONGO_VERSION },
      });
      process.env.ANTELOPE_SUBSCRIPTIONS_TEST_MONGO_URL = mongod.getUri();
      return {
        modules: {
          mongodb: {
            config: {
              url: mongod.getUri(),
              database: `subscriptions_${CLOCK}`,
            },
          },
          local: {
            config: {
              pollIntervalMs: TEST_POLL_MS,
              sweepIntervalMs: CLOCK === "redis" ? HOUR_MS : TEST_POLL_MS,
            },
          },
          ...(await redisModules()),
        },
      };
    },
    async cleanup() {
      await redis?.stop();
      await mongod?.stop();
    },
  },
});
