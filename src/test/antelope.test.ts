import { RedisMemoryServer } from "redis-memory-server";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import {
  type AntelopeModuleConfig,
  defineConfig,
} from "@antelopejs/interface-core/config";

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

const EXIT_GRACE_MS = 2_000;

let mongod: MongoMemoryServer | undefined;

function exitOnceSchedulerTimerIsAllThatIsLeft(): void {
  if (CLOCK !== "redis") return;
  setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
}
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
      exitOnceSchedulerTimerIsAllThatIsLeft();
    },
  },
});
