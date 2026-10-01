import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { CLOCK_UNDER_TEST } from "./support";

const ROOT = path.resolve(__dirname, "../..");
const BOOT_TIMEOUT_MS = 60_000;
const MILESTONES = ["LAUNCHED", "RENEWED"];
const CORE_PACKAGE = "@antelopejs/core";

/**
 * Finds the AntelopeJS core this suite is running under — the `ajs` that
 * started it — so the child launches the same runtime.
 */
function corePackageRoot(): string {
  let folder = path.dirname(realpathSync(process.argv[1]));
  while (folder !== path.dirname(folder)) {
    const manifest = path.join(folder, "package.json");
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, "utf8")).name === CORE_PACKAGE
    ) {
      return folder;
    }
    folder = path.dirname(folder);
  }
  throw new Error(`Cannot find ${CORE_PACKAGE} above ${process.argv[1]}`);
}

function moduleEntry(source: string, config: Record<string, unknown> = {}) {
  return { source: { type: "local", path: path.join(ROOT, source) }, config };
}

function projectModules() {
  const modules: Record<string, unknown> = {
    subscriptions: moduleEntry(".", { pollIntervalMs: 100 }),
    payments: moduleEntry("test/payment-provider"),
    mongodb: moduleEntry("node_modules/@antelopejs/mongodb", {
      url: process.env.ANTELOPE_SUBSCRIPTIONS_TEST_MONGO_URL,
      database: `boot_${CLOCK_UNDER_TEST}`,
    }),
    probe: moduleEntry("test/boot-probe"),
  };
  if (CLOCK_UNDER_TEST === "redis") {
    modules.redis = moduleEntry("node_modules/@antelopejs/redis", {
      url: process.env.ANTELOPE_SUBSCRIPTIONS_TEST_REDIS_URL,
    });
  }
  return modules;
}

function writeProject(folder: string): void {
  const config = {
    name: "payment-subscriptions-boot",
    cacheFolder: ".antelope/cache",
    modules: projectModules(),
  };
  writeFileSync(
    path.join(folder, "antelope.config.ts"),
    `export default ${JSON.stringify(config, null, 2)};\n`,
  );
}

function launch(folder: string): ChildProcess {
  const script = `require(${JSON.stringify(corePackageRoot())}).launch(${JSON.stringify(folder)}).then(() => process.stdout.write("LAUNCHED\\n"), (error) => { process.stdout.write("LAUNCH FAILED " + error + "\\n"); process.exit(1); });`;
  return spawn(process.execPath, ["-e", script], {
    cwd: folder,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Resolves with everything the child printed, once every milestone is in it or time is up. */
function milestones(child: ChildProcess): Promise<string> {
  let output = "";
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(output), BOOT_TIMEOUT_MS);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (MILESTONES.every((line) => output.includes(`${line}\n`))) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

describe("[fallback] booting outside the test harness", function () {
  this.timeout(BOOT_TIMEOUT_MS * 2);

  it(`launches and renews, with the ${CLOCK_UNDER_TEST} clock, instead of hanging`, async () => {
    const folder = mkdtempSync(
      path.join(tmpdir(), "payment-subscriptions-boot-"),
    );
    writeProject(folder);
    const child = launch(folder);
    try {
      const output = await milestones(child);
      for (const line of MILESTONES) {
        assert.ok(
          output.includes(`${line}\n`),
          `never printed ${line}; the child said:\n${output.slice(-4000)}`,
        );
      }
    } finally {
      child.kill("SIGKILL");
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
