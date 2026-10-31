import type { VerifyConfig } from "@antelopejs/tooling-configs/verify";

import { chargeJourneys } from "./journeys-charge.ts";
import { changeJourneys } from "./journeys-change.ts";
import { createJourneys } from "./journeys-create.ts";
import { renewalJourneys } from "./journeys-renewal.ts";

const DATABASE = "verify";

const config: VerifyConfig = {
  doors: {
    data: {
      globs: ["src/engine.ts", "src/records.ts"],
      funnels: ["src/records.ts"],
      containments: ["create/idempotent-create"],
      why: "every subscription is one record in the database, the only source of truth: a wrong write loses or duplicates a customer's billing state",
    },
    format: {
      globs: ["src/records.ts", "src/initial.ts"],
      funnels: [],
      containments: ["renewal/survives-restart"],
      why: "the stored record shape (schema payment-subscriptions, table subscriptions) is read back by every later release; the journey proves a restart reads what the previous process wrote, not records written by an older release",
    },
    contract: {
      globs: ["package.json"],
      funnels: [],
      containments: [],
      why: "the module config keys, `antelopeJs.implements` and the interface ranges it depends on",
    },
    outbound: {
      globs: ["src/schedule.ts"],
      funnels: ["src/schedule.ts"],
      containments: [],
      why: "every renewal is an off-session CreatePayment on the customer's saved method: money leaves the customer's account",
    },
    exposure: null,
    publish: {
      globs: ["package.json", ".release-it.json", "changelogen.config.json", ".github/workflows/release.yml"],
      funnels: [],
      containments: [],
      why: "the package name and release workflow claim @antelopejs/payment-subscriptions on npm",
    },
  },
  services: {
    mongo: {
      image: "mongo:7",
      port: 27017,
      ready: ["mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"],
      reset: ["mongosh", "--quiet", "--eval", `db.getSiblingDB('${DATABASE}').dropDatabase()`],
    },
    redis: { image: "redis:7-alpine", port: 6379, ready: ["redis-cli", "ping"], reset: ["redis-cli", "FLUSHALL"] },
  },
  moduleConfig() {
    return { pollIntervalMs: 100 };
  },
  journeys: { ...createJourneys, ...changeJourneys, ...chargeJourneys, ...renewalJourneys },
  formal: [
    {
      name: "formal-billing-lease",
      covers: ["src/engine.ts", "src/transitions.ts", "src/records.ts"],
      files: [".agents/skills/formal-billing-lease/**"],
      command: ["node", ".agents/skills/formal-billing-lease/check.mjs", "--full"],
      baseCommand: ["node", ".agents/skills/formal-billing-lease/check.mjs"],
      violation: /^(?:finding|BROKEN|CHANGED|HOLDS) +(\w+)/gm,
      passing: /(?<=^holds +(?:\w+, )*)(\w+)(?=,| \()/gm,
      behaviour: { kind: "emit" },
    },
  ],
};

export default config;
