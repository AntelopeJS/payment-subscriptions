import assert from "node:assert/strict";

import { ResolveSchedule } from "../schedule";

describe("ResolveSchedule", () => {
  it("resolves the payment-interface schedule by its name", () => {
    assert.doesNotThrow(() => ResolveSchedule("payment-interface"));
  });

  it("refuses a name that only Object.prototype answers", () => {
    assert.throws(
      () => ResolveSchedule("constructor"),
      /Unknown providerSchedule "constructor"; known: payment-interface/,
    );
  });

  it("refuses an unknown name and lists the known ones", () => {
    assert.throws(
      () => ResolveSchedule("cron"),
      /Unknown providerSchedule "cron"; known: payment-interface/,
    );
  });
});
