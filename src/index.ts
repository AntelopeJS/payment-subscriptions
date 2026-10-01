import { Logging } from "@antelopejs/interface-core/logging";
import { ImplementInterface } from "@antelopejs/interface-core";
import * as subscriptions from "@antelopejs/interface-subscriptions";

import { Engine } from "./engine";
import { ResolveSchedule } from "./schedule";
import { Runtime, SetRuntime } from "./runtime";
import { Implementation } from "./implementation";
import { type Config, ResolveSettings } from "./config";
import { ChooseTrigger, type Trigger } from "./triggers";

export type { Config } from "./config";

let trigger: Trigger | undefined;

export function construct(config: Config): void {
  const settings = ResolveSettings(config);
  const schedule = ResolveSchedule(settings.providerSchedule);
  SetRuntime({ engine: new Engine(settings, schedule), settings, schedule });
  ImplementInterface(subscriptions, Implementation);
}

export async function start(): Promise<void> {
  const { engine, settings } = Runtime();
  trigger = await ChooseTrigger(engine, settings);
  engine.onWrite((record) => trigger?.schedule(record));
  trigger.start();
  Logging.Info(`payment-subscriptions: renewal clock is ${trigger.kind}`);
}

export async function stop(): Promise<void> {
  await trigger?.stop();
  trigger = undefined;
  await Runtime().engine.drain();
}

export function destroy(): void {
  SetRuntime(undefined);
}

/** Which clock the module chose at start, or undefined before start. */
export function ActiveClock(): Trigger["kind"] | undefined {
  return trigger?.kind;
}
