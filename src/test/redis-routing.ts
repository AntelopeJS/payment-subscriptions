import { Logging } from "@antelopejs/interface-core/logging";
import { RunWithResponsibleModule } from "@antelopejs/interface-core";

import { Runtime } from "../runtime";
import { start, stop } from "../index";
import { HANDLER_NAME, RedisTrigger, type Trigger } from "../triggers";

type SchedulerModule = typeof import("@antelopejs/interface-redis-scheduler");

const SCHEDULER_PACKAGE = "@antelopejs/interface-redis-scheduler";
const TEST_OWNER = "payment-subscriptions-suite";

function unroutedScheduler(): SchedulerModule {
  const loaded = require.cache[require.resolve(SCHEDULER_PACKAGE)];
  if (!loaded) throw new Error(`${SCHEDULER_PACKAGE} is not loaded`);
  return loaded.exports as SchedulerModule;
}

export function useRedisTriggerOutsideRouting(): void {
  let trigger: Trigger | undefined;
  before(async () => {
    await stop();
    const { engine, settings } = Runtime();
    const scheduler = unroutedScheduler();
    RunWithResponsibleModule(TEST_OWNER, () =>
      scheduler.setHandler(HANDLER_NAME, (id) => engine.process(id)),
    );
    trigger = RedisTrigger(engine, settings, scheduler);
    engine.onWrite((record) => trigger?.schedule(record));
    trigger.start();
    Logging.Info(
      "payment-subscriptions suite: Redis trigger registered outside the runtime's routing",
    );
  });
  after(async () => {
    await trigger?.stop();
    await start();
  });
}
