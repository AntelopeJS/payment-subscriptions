import { Logging } from "@antelopejs/interface-core/logging";
import { GetInterfaceInstances } from "@antelopejs/interface-core";

import type { Engine } from "./engine";
import { RealDelayUntil } from "./clock";
import type { Settings } from "./config";
import type { SubscriptionRecord } from "./records";

type SchedulerModule = typeof import("@antelopejs/interface-redis-scheduler");

const REDIS_INTERFACE = "@antelopejs/interface-redis";
const SCHEDULER_INTERFACE = "@antelopejs/interface-redis-scheduler";
export const HANDLER_NAME = "payment-subscriptions";
const LISTENER_STOP_TIMEOUT_MS = 2_000;

export interface Trigger {
  readonly kind: "polling" | "redis";
  start(): void;
  stop(): Promise<void>;
  schedule(record: SubscriptionRecord): void;
}

class Sweeper {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly engine: Engine,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.engine
      .sweep()
      .catch((error: unknown) =>
        Logging.Error("payment-subscriptions: sweep failed", error),
      )
      .finally(() => {
        this.running = undefined;
      });
  }
}

function pollingTrigger(engine: Engine, settings: Settings): Trigger {
  const sweeper = new Sweeper(engine, settings.pollIntervalMs);
  return {
    kind: "polling",
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
    schedule: () => undefined,
  };
}

function report(action: string) {
  return (error: unknown) =>
    Logging.Warn(
      `payment-subscriptions: Redis scheduler ${action} failed`,
      error,
    );
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    work,
    new Promise<void>((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

export function RedisTrigger(
  engine: Engine,
  settings: Settings,
  scheduler: SchedulerModule,
): Trigger {
  const sweeper = new Sweeper(engine, settings.sweepIntervalMs);
  return {
    kind: "redis",
    start: () => {
      scheduler.enableListener().catch(report("listener"));
      sweeper.start();
    },
    stop: async () => {
      await sweeper.stop();
      await withTimeout(
        scheduler.disableListener().catch(report("shutdown")),
        LISTENER_STOP_TIMEOUT_MS,
      );
    },
    schedule: (record) => {
      const task =
        record.dueAt === null
          ? scheduler.removeTask(HANDLER_NAME, record._id)
          : scheduler.addTask(
              HANDLER_NAME,
              Date.now() + RealDelayUntil(record.dueAt),
              record._id,
            );
      task.catch(report("scheduling"));
    },
  };
}

function isWired(interfaceId: string): boolean {
  return GetInterfaceInstances(interfaceId).length > 0;
}

export async function ChooseTrigger(
  engine: Engine,
  settings: Settings,
): Promise<Trigger> {
  if (!isWired(SCHEDULER_INTERFACE) || !isWired(REDIS_INTERFACE)) {
    return pollingTrigger(engine, settings);
  }
  const scheduler: SchedulerModule =
    await import("@antelopejs/interface-redis-scheduler");
  try {
    scheduler.setHandler(HANDLER_NAME, (id) => engine.process(id));
  } catch (error) {
    Logging.Warn(
      "payment-subscriptions: the Redis scheduler refused the renewal handler; polling the database instead",
      error,
    );
    return pollingTrigger(engine, settings);
  }
  return RedisTrigger(engine, settings, scheduler);
}
