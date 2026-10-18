import assert from "node:assert/strict";
import {
  CreateSubscription,
  GetSubscription,
  CancelSubscription,
  UpdateSubscriptionPaymentMethod,
} from "@antelopejs/interface-subscriptions";
import { Runtime } from "../runtime";
import { Engine } from "../engine";
import { LoadRecord, MutateRecord } from "../records";
import { Decide } from "../transitions";
import {
  HOUR_MS,
  SUITE_TIMEOUT,
  TOKENS,
  chargesMade,
  key,
  newPayer,
  provider,
  quiesce,
  subscribe,
  useManualClock,
  withTriggerStopped,
} from "./support";

const START = Date.UTC(2029, 0, 1);
const RENEWAL = Date.UTC(2029, 1, 1);

describe("[fallback] bounded charge recovery", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);
  afterEach(() => provider.setLosesResponses(false));

  it("replays a trial creation after its deadline, but rejects a new key", async () => {
    const payer = await newPayer();
    const request = {
      ...payer,
      reference: key(),
      amount: { value: 1900, currency: "EUR" },
      interval: "month" as const,
      trialEnd: START + HOUR_MS,
    };
    const operation = key();
    const created = await CreateSubscription(request, operation);
    clock.advance(2 * HOUR_MS);
    assert.equal((await CreateSubscription(request, operation)).id, created.id);
    await assert.rejects(CreateSubscription(request, key()));
  });

  it("halts an unknown renewal at the exact replay deadline and stays halted after method changes and cancellation", async () => {
    const payer = await newPayer();
    const created = await subscribe(payer);
    await withTriggerStopped(async () => {
      provider.setLosesResponses(true);
      clock.advanceTo(RENEWAL);
      await Runtime().engine.process(created.id);
      provider.setLosesResponses(false);
      clock.advance(Runtime().settings.guaranteedReplayMs);
      await Runtime().engine.process(created.id);
      const halted = await GetSubscription(created.id);
      assert.equal(halted.vendorData?.reconciliationRequired, true);
      assert.equal((await LoadRecord(created.id))!.nextActionAt, null);
      const calls = provider.chargesFor(created.id).length;
      await UpdateSubscriptionPaymentMethod(
        created.id,
        payer.paymentMethod,
        key(),
      );
      await CancelSubscription(created.id, key(), "now");
      clock.advance(HOUR_MS);
      await Runtime().engine.drain();
      await Runtime().engine.process(created.id);
      assert.equal(provider.chargesFor(created.id).length, calls);
      assert.equal(chargesMade(created.id).length, 2);
      assert.equal(
        (await GetSubscription(created.id)).vendorData?.reconciliationRequired,
        true,
      );
    });
  });

  it("does not replay with no configured guarantee, or for legacy attempts without timing", async () => {
    for (const legacy of [false, true]) {
      const created = await subscribe(await newPayer());
      await withTriggerStopped(async () => {
        const { settings, schedule } = Runtime();
        const engine = new Engine(
          {
            ...settings,
            guaranteedReplayMs: legacy ? settings.guaranteedReplayMs : 0,
          },
          schedule,
        );
        clock.advanceTo(RENEWAL);
        provider.setLosesResponses(true);
        await engine.process(created.id);
        provider.setLosesResponses(false);
        if (legacy) {
          const record = (await LoadRecord(created.id))!;
          await MutateRecord(record, {
            attemptStartedAt: null,
            attemptReplayUntil: null,
          });
        }
        clock.advance(settings.errorBackoffMs);
        await engine.process(created.id);
        assert.equal(
          (await GetSubscription(created.id)).vendorData
            ?.reconciliationRequired,
          true,
        );
        assert.equal(provider.chargesFor(created.id).length, 2);
      });
      clock.time = START;
    }
  });
});

describe("[fallback] initial charge recovery", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);
  afterEach(() => provider.setLosesResponses(false));

  it("recovers initial creation within the window, but surfaces an expired creation without charging", async () => {
    for (const expires of [false, true]) {
      const payer = await newPayer();
      const request = {
        ...payer,
        reference: key(),
        amount: { value: 1900, currency: "EUR" },
        interval: "month" as const,
      };
      const operation = key();
      provider.setLosesResponses(true);
      await assert.rejects(CreateSubscription(request, operation));
      provider.setLosesResponses(false);
      if (expires) clock.advance(Runtime().settings.guaranteedReplayMs);
      if (expires) {
        const callsForRequest = () =>
          provider
            .ledger()
            .filter((entry) => entry.request.reference === request.reference)
            .length;
        const calls = callsForRequest();
        await assert.rejects(
          CreateSubscription(request, operation),
          /requires reconciliation/,
        );
        await assert.rejects(
          CreateSubscription(request, operation),
          /requires reconciliation/,
        );
        assert.equal(callsForRequest(), calls);
      } else {
        const recovered = await CreateSubscription(request, operation);
        assert.equal(chargesMade(recovered.id).length, 1);
      }
    }
  });
});

describe("[fallback] durable pending and crashed attempts", function () {
  this.timeout(SUITE_TIMEOUT);
  const clock = useManualClock(START);

  it("reconciles a recovered renewal against its target period without charging again", async () => {
    const created = await subscribe(await newPayer());
    await withTriggerStopped(async () => {
      clock.advanceTo(RENEWAL);
      const { engine } = Runtime();
      const record = (await LoadRecord(created.id))!;
      const decision = Decide(record, RENEWAL);
      const outcome = await engine.perform(record, decision);
      clock.advance(Runtime().settings.guaranteedReplayMs);
      await engine.process(created.id);
      const held = (await LoadRecord(created.id))!;
      assert.equal(held.reconciliationRequired, true);
      await MutateRecord(held, {
        pendingPayment: outcome.payment,
        periodIndex: decision.periodIndex,
        reconciliationRequired: false,
        nextActionAt: clock.time,
        dueAt: clock.time,
        leaseOwner: null,
        leaseUntil: 0,
      });
      const calls = provider.chargesFor(created.id).length;
      await engine.process(created.id);
      const recovered = await GetSubscription(created.id);
      assert.equal(recovered.latestPayment, outcome.payment);
      assert.equal(recovered.currentPeriodStart, RENEWAL);
      assert.equal(recovered.currentPeriodEnd, Date.UTC(2029, 2, 1));
      assert.equal(recovered.vendorData?.reconciliationRequired, false);
      await engine.process(created.id);
      assert.equal(provider.chargesFor(created.id).length, calls);
    });
  });

  it("reads a known pending payment after expiry without submitting another charge", async () => {
    const created = await subscribe(await newPayer(TOKENS.settlesLater));
    const calls = provider.chargesFor(created.id).length;
    clock.advance(2 * HOUR_MS);
    await quiesce();
    clock.advance(HOUR_MS);
    await quiesce();
    assert.equal(provider.chargesFor(created.id).length, calls);
    assert.equal((await GetSubscription(created.id)).status, "active");
    assert.equal(provider.paymentStatus(created.latestPayment!), "succeeded");
  });

  it("halts a crashed, uncommitted charge after expiry without contacting the provider", async () => {
    const created = await subscribe(await newPayer());
    await withTriggerStopped(async () => {
      clock.advanceTo(RENEWAL);
      const { engine } = Runtime();
      const record = (await LoadRecord(created.id))!;
      await engine.perform(record, Decide(record, RENEWAL));
      const calls = provider.chargesFor(created.id).length;
      clock.advance(Runtime().settings.guaranteedReplayMs);
      const { settings, schedule } = Runtime();
      const survivor = new Engine(
        { ...settings, guaranteedReplayMs: 10 * HOUR_MS },
        schedule,
      );
      await survivor.process(created.id);
      assert.equal(provider.chargesFor(created.id).length, calls);
      assert.equal(
        (await GetSubscription(created.id)).vendorData?.reconciliationRequired,
        true,
      );
    });
  });
});
