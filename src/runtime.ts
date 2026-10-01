import type { Engine } from "./engine";
import type { Settings } from "./config";
import type { ProviderSchedule } from "./schedule";

export interface RuntimeState {
  engine: Engine;
  settings: Settings;
  schedule: ProviderSchedule;
}

let state: RuntimeState | undefined;

export function SetRuntime(next: RuntimeState | undefined): void {
  state = next;
}

export function Runtime(): RuntimeState {
  if (!state) throw new Error("payment-subscriptions has not been constructed");
  return state;
}
