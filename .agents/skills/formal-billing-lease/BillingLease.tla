---------------------------- MODULE BillingLease ----------------------------
(***************************************************************************)
(* The renewal loop of @antelopejs/payment-subscriptions (src/engine.ts,   *)
(* src/transitions.ts, src/records.ts) for one live subscription: workers  *)
(* run Engine.process (claim, act, release) on it, the database applies    *)
(* each write as a compare-and-set on `revision` (records.ts:108-122), and *)
(* the payment provider deduplicates charges by idempotency key.          *)
(*                                                                         *)
(* A worker is one process() call of one engine instance. Each database    *)
(* round trip is one step: the database applies the command and the        *)
(* worker handles the answer, then runs on synchronously to its next await.*)
(* The provider receiving a charge and the worker reading the answer are   *)
(* one step. Time moves in ticks; Now() reads `now`.                       *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
  Workers,       \* process() calls that may run, each of its own engine instance
  Periods,       \* renewals the model follows: the record starts in period 0
  PeriodLen,     \* ticks per billing period
  Lease,         \* leaseMs (config.ts:31, 67)
  Replay,        \* guaranteedReplayMs (config.ts:12, 64)
  Backoff,       \* errorBackoffMs (config.ts:49, 70)
  RetryDelay,    \* every entry of retryDelaysMs (config.ts:38, 68)
  Retries,       \* length of retryDelaysMs
  Results,       \* what a new charge can do at the provider
  MaxCrashes,    \* process crashes the model allows in one behaviour
  MaxTime        \* the last tick

Null == -1
NoWorker == "none"
Keys == (1..Periods) \X (0..Retries)

VARIABLES
  now,       \* Now() (clock.ts:9-11), in ticks
  rec,       \* the stored subscription record
  wk,        \* each worker's place in process() and what it holds
  keys,      \* the provider: the tick it first saw each key it still keeps
  keyOut,    \* the provider: the answer it replays for each key it keeps
  paid,      \* per period: successful charges the provider made
  recorded,  \* periods whose success a commit wrote to the record
  crashes    \* process crashes so far

vars == <<now, rec, wk, keys, keyOut, paid, recorded, crashes>>

(* The fields of SubscriptionRecord the loop reads or writes             *)
(* (records.ts:24-64). `pinned` stands for attemptMethod # null,         *)
(* `replayUntil` for attemptReplayUntil, `outbox` for a non-empty outbox. *)
Record(rev, owner, leaseUntil, dueAt, nextAt, period, attempt, status,
       pinned, replayUntil, reconcile, outbox) ==
  [rev |-> rev, owner |-> owner, leaseUntil |-> leaseUntil, dueAt |-> dueAt,
   nextAt |-> nextAt, period |-> period, attempt |-> attempt, status |-> status,
   pinned |-> pinned, replayUntil |-> replayUntil, reconcile |-> reconcile,
   outbox |-> outbox]

NoRecord == Record(0, NoWorker, 0, Null, Null, 0, 0, "active", FALSE, Null, FALSE, FALSE)

Idle == [pc |-> "idle", snap |-> NoRecord, at |-> 0, sent |-> 0, key |-> <<0, 0>>,
         fp |-> <<0, 0>>, out |-> "none", tries |-> 0]

Statuses == {"active", "past_due", "canceled"}
Outs == {"none", "succeeded", "failed", "error", "reconcile"}
PCs == {"idle", "claim", "pin", "pinReply", "charge", "commitLoad",
        "commitWrite", "release", "releaseWrite", "releaseLoad"}

Claimable(r) ==                                                \* engine.ts:169-171
  /\ r.dueAt # Null /\ r.dueAt <= now
  /\ r.owner = NoWorker \/ r.leaseUntil <= now

(* The key the record's next charge carries: Decide (transitions.ts:58-72) *)
(* and ChargeKey (transitions.ts:74-79).                                  *)
NextKey(r) ==
  IF r.status = "past_due" THEN <<r.period, r.attempt>> ELSE <<r.period + 1, 0>>

(* The record holds its last modeled period: the model renews no further. *)
Done(r) == r.status = "active" /\ r.period = Periods

PeriodEnd(p) == IF p = Periods THEN Null ELSE (p + 1) * PeriodLen

Init ==
  /\ now = 0
  /\ rec = Record(0, NoWorker, 0, 0, 0, 0, 0, "active", FALSE, Null, FALSE, FALSE)
  /\ wk = [w \in Workers |-> Idle]
  /\ keys = <<>> /\ keyOut = <<>>
  /\ paid = [p \in 1..Periods |-> 0]
  /\ recorded = {}
  /\ crashes = 0

TypeOK ==
  /\ now \in 0..MaxTime
  /\ rec.status \in Statuses /\ rec.period \in 0..Periods /\ rec.attempt \in 0..Retries
  /\ \A w \in Workers : wk[w].pc \in PCs /\ wk[w].out \in Outs
  /\ DOMAIN keys \subseteq Keys /\ DOMAIN keyOut = DOMAIN keys
  /\ recorded \subseteq 1..Periods

Write(patch) == [patch EXCEPT !.rev = rec.rev + 1]

SetW(w, f) == wk' = [wk EXCEPT ![w] = f]

(* ------------------------------ claim ---------------------------------- *)

(* claim reads Now() and the record (engine.ts:167-168). A record it      *)
(* cannot claim ends the process at once, which changes nothing, so the   *)
(* step is enabled only for a record it can claim (lines 169-171).        *)
Load(w) ==
  /\ wk[w].pc = "idle"
  /\ Claimable(rec)
  /\ SetW(w, [Idle EXCEPT !.pc = "claim", !.snap = rec, !.at = now])
  /\ UNCHANGED <<now, rec, keys, keyOut, paid, recorded, crashes>>

(* After the claim, act runs on synchronously: a record not yet due for  *)
(* an action goes to release (engine.ts:183-185); otherwise Decide and    *)
(* perform: a flagged record, or a resumed attempt past its replay        *)
(* deadline, is reconciled (lines 222-228); a fresh attempt pins the      *)
(* method first (line 229, 195-208); a resumed one charges at once.       *)
AfterClaim(w, r) ==
  LET key == NextKey(r)
      fp == <<r.period, r.attempt>>
      fresh == ~r.pinned
  IN IF r.nextAt = Null \/ r.nextAt > now
     THEN [Idle EXCEPT !.pc = "release", !.snap = r]
     ELSE IF r.reconcile \/ (~fresh /\ (r.replayUntil = Null \/ now >= r.replayUntil))
     THEN [Idle EXCEPT !.pc = "commitLoad", !.snap = r, !.key = key, !.fp = fp,
                       !.out = "reconcile"]
     ELSE [Idle EXCEPT !.pc = IF fresh THEN "pin" ELSE "charge", !.snap = r,
                       !.key = key, !.fp = fp, !.sent = now]

(* The claim write: a compare-and-set that takes the lease and moves     *)
(* dueAt to its end (engine.ts:172-177).                                  *)
Claim(w) ==
  LET c == wk[w] IN
  /\ c.pc = "claim"
  /\ IF c.snap.rev = rec.rev
     THEN LET r == Write([rec EXCEPT !.owner = w, !.leaseUntil = c.at + Lease,
                                     !.dueAt = c.at + Lease]) IN
          /\ rec' = r
          /\ SetW(w, AfterClaim(w, r))
     ELSE /\ SetW(w, Idle)
          /\ UNCHANGED rec
  /\ UNCHANGED <<now, keys, keyOut, paid, recorded, crashes>>

(* ------------------------------ charge --------------------------------- *)

(* pinAttemptMethod writes the method and the replay deadline Now() +    *)
(* guaranteedReplayMs (engine.ts:202-207). A lost compare-and-set throws  *)
(* (lines 230-231): process() logs it and ends without a release          *)
(* (lines 153-155), so the lease stays until it expires.                  *)
Pin(w) ==
  LET c == wk[w] IN
  /\ c.pc = "pin"
  /\ IF c.snap.rev = rec.rev
     THEN LET r == Write([rec EXCEPT !.pinned = TRUE, !.replayUntil = now + Replay]) IN
          /\ rec' = r
          /\ SetW(w, [c EXCEPT !.pc = "pinReply", !.snap = r])
     ELSE /\ SetW(w, Idle)
          /\ UNCHANGED rec
  /\ UNCHANGED <<now, keys, keyOut, paid, recorded, crashes>>

(* The pin's answer: with a replay guarantee, the deadline is checked     *)
(* again before the charge is sent (engine.ts:233-241).                   *)
PinReply(w) ==
  LET c == wk[w] IN
  /\ c.pc = "pinReply"
  /\ SetW(w, IF Replay > 0 /\ now >= c.snap.replayUntil
             THEN [c EXCEPT !.pc = "commitLoad", !.out = "reconcile"]
             ELSE [c EXCEPT !.pc = "charge", !.sent = now])
  /\ UNCHANGED <<now, rec, keys, keyOut, paid, recorded, crashes>>

(* The provider still answers a key for a request sent before the first  *)
(* receipt of that key plus guaranteedReplayMs: the operator sets that   *)
(* value below the provider's retention by a margin covering latency and *)
(* stalls (docs/2.renewal-clock.md:63-68), so a request sent in time      *)
(* arrives in time. A request sent later finds the key forgotten.        *)
Kept(k, sent) ==
  /\ k \in DOMAIN keys
  /\ sent < keys[k] + Replay

Remember(k, o) ==
  /\ keys' = [x \in DOMAIN keys \cup {k} |-> IF x = k THEN now ELSE keys[x]]
  /\ keyOut' = [x \in DOMAIN keyOut \cup {k} |-> IF x = k THEN o ELSE keyOut[x]]

(* An error that is not a refusal: reconcile once the replay deadline of  *)
(* the record the worker charged has passed, else retry (engine.ts:249-263). *)
ErrorOut(c) ==
  IF c.snap.replayUntil = Null \/ now >= c.snap.replayUntil THEN "reconcile" ELSE "error"

(* The provider gets the charge with key payment-subscriptions:<id>:     *)
(* <period>:<attempt> (engine.ts:266-277), sent at `sent`. A key it still *)
(* keeps answers the first charge again. Otherwise the charge succeeds,   *)
(* is declined, succeeds but its answer is lost on the way back, or never *)
(* reaches the provider.                                                  *)
Charge(w) ==
  LET c == wk[w]
      k == c.key
  IN
  /\ c.pc = "charge"
  /\ IF Kept(k, c.sent)
     THEN /\ SetW(w, [c EXCEPT !.pc = "commitLoad", !.out = keyOut[k]])
          /\ UNCHANGED <<keys, keyOut, paid>>
     ELSE \E result \in Results :
          CASE result = "succeeded" ->
                 /\ Remember(k, "succeeded")
                 /\ paid' = [paid EXCEPT ![k[1]] = @ + 1]
                 /\ SetW(w, [c EXCEPT !.pc = "commitLoad", !.out = "succeeded"])
            [] result = "declined" ->
                 /\ Remember(k, "failed")
                 /\ UNCHANGED paid
                 /\ SetW(w, [c EXCEPT !.pc = "commitLoad", !.out = "failed"])
            [] result = "lost" ->
                 /\ Remember(k, "succeeded")
                 /\ paid' = [paid EXCEPT ![k[1]] = @ + 1]
                 /\ SetW(w, [c EXCEPT !.pc = "commitLoad", !.out = ErrorOut(c)])
            [] result = "unreachable" ->
                 /\ UNCHANGED <<keys, keyOut, paid>>
                 /\ SetW(w, [c EXCEPT !.pc = "commitLoad", !.out = ErrorOut(c)])
  /\ UNCHANGED <<now, rec, recorded, crashes>>

(* ------------------------------ commit --------------------------------- *)

(* Apply on a live record (transitions.ts:125-225): what each outcome    *)
(* writes, and whether it raises events.                                 *)
LiveApply(r, c) ==
  CASE c.out = "succeeded" ->
         [r EXCEPT !.period = c.key[1], !.status = "active", !.attempt = 0,
                   !.pinned = FALSE, !.replayUntil = Null, !.reconcile = FALSE,
                   !.nextAt = PeriodEnd(c.key[1]), !.outbox = TRUE]
    [] c.out = "failed" /\ c.key[2] < Retries ->
         [r EXCEPT !.period = c.key[1], !.status = "past_due", !.attempt = c.key[2] + 1,
                   !.pinned = FALSE, !.replayUntil = Null, !.reconcile = FALSE,
                   !.nextAt = now + RetryDelay, !.outbox = TRUE]
    [] c.out = "failed" ->
         [r EXCEPT !.period = c.key[1], !.status = "canceled",
                   !.pinned = FALSE, !.replayUntil = Null, !.reconcile = FALSE,
                   !.nextAt = Null, !.outbox = TRUE]
    [] c.out = "error" -> [r EXCEPT !.nextAt = now + Backoff]
    [] c.out = "reconcile" -> [r EXCEPT !.reconcile = TRUE, !.nextAt = Null]

(* Apply on a canceled record (transitions.ts:243-283).                  *)
EndedApply(r, c) ==
  CASE c.out = "succeeded" ->
         [r EXCEPT !.pinned = FALSE, !.replayUntil = Null, !.reconcile = FALSE,
                   !.nextAt = Null, !.outbox = TRUE]
    [] c.out = "failed" ->
         [r EXCEPT !.pinned = FALSE, !.replayUntil = Null, !.reconcile = FALSE,
                   !.nextAt = Null]
    [] c.out = "error" -> [r EXCEPT !.reconcile = r.reconcile \/ r.pinned, !.nextAt = Null]
    [] c.out = "reconcile" -> [r EXCEPT !.reconcile = TRUE, !.nextAt = Null]

(* Finalize: dueAt is now while events wait in the outbox, else the next *)
(* action (engine.ts:80-95).                                              *)
Finalized(r) == [r EXCEPT !.dueAt = IF r.outbox THEN now ELSE r.nextAt]

(* commit reloads the record and applies the outcome only while its      *)
(* fingerprint is the one the decision saw; otherwise it returns the      *)
(* record unwritten (engine.ts:290-294, transitions.ts:292). The write is *)
(* sent with the Now() of this step.                                      *)
CommitLoad(w) ==
  LET c == wk[w] IN
  /\ c.pc = "commitLoad"
  /\ SetW(w, IF <<rec.period, rec.attempt>> # c.fp
             THEN [c EXCEPT !.pc = "release", !.snap = rec]
             ELSE LET applied == IF rec.status = "canceled" THEN EndedApply(rec, c)
                                 ELSE LiveApply(rec, c)
                  IN [c EXCEPT !.pc = "commitWrite", !.snap = Finalized(applied),
                               !.at = rec.rev])
  /\ UNCHANGED <<now, rec, keys, keyOut, paid, recorded, crashes>>

(* The commit write (engine.ts:295-300). A lost compare-and-set reloads  *)
(* and tries again; the fifth loss throws (lines 291, 302-304).           *)
CommitWrite(w) ==
  LET c == wk[w] IN
  /\ c.pc = "commitWrite"
  /\ IF c.at = rec.rev
     THEN LET r == Write(c.snap) IN
          /\ rec' = r
          /\ recorded' = IF c.out = "succeeded" THEN recorded \cup {c.key[1]} ELSE recorded
          /\ SetW(w, [c EXCEPT !.pc = "release", !.snap = r])
     ELSE /\ SetW(w, IF c.tries + 1 < 5 THEN [c EXCEPT !.pc = "commitLoad", !.tries = @ + 1]
                     ELSE Idle)
          /\ UNCHANGED <<rec, recorded>>
  /\ UNCHANGED <<now, keys, keyOut, paid, crashes>>

(* ------------------------------ release -------------------------------- *)

(* The outbox is delivered (engine.ts:317); the release patch empties it, *)
(* sets dueAt to the next action, and drops the lease when this worker    *)
(* owns it (lines 329-346).                                               *)
ReleasePatch(w, r) ==
  [r EXCEPT !.outbox = FALSE, !.dueAt = r.nextAt,
            !.owner = IF r.owner = w THEN NoWorker ELSE r.owner,
            !.leaseUntil = IF r.owner = w THEN 0 ELSE r.leaseUntil]

Release(w) ==
  LET c == wk[w] IN
  /\ c.pc = "release"
  /\ SetW(w, [c EXCEPT !.pc = "releaseWrite", !.tries = 0])
  /\ UNCHANGED <<now, rec, keys, keyOut, paid, recorded, crashes>>

(* The release write: a lost compare-and-set reloads and tries again, up *)
(* to five writes (engine.ts:319-326).                                    *)
ReleaseWrite(w) ==
  LET c == wk[w] IN
  /\ c.pc = "releaseWrite"
  /\ IF c.snap.rev = rec.rev
     THEN /\ rec' = Write(ReleasePatch(w, c.snap))
          /\ SetW(w, Idle)
     ELSE /\ SetW(w, IF c.tries + 1 < 5 THEN [c EXCEPT !.pc = "releaseLoad", !.tries = @ + 1]
                     ELSE Idle)
          /\ UNCHANGED rec
  /\ UNCHANGED <<now, keys, keyOut, paid, recorded, crashes>>

ReleaseLoad(w) ==
  LET c == wk[w] IN
  /\ c.pc = "releaseLoad"
  /\ SetW(w, [c EXCEPT !.pc = "releaseWrite", !.snap = rec])
  /\ UNCHANGED <<now, rec, keys, keyOut, paid, recorded, crashes>>

(* ------------------------------ environment ---------------------------- *)

(* The process dies (a restart, a deploy): whatever it held is gone, and *)
(* its lease stays until it expires.                                      *)
Crash(w) ==
  /\ wk[w].pc # "idle"
  /\ crashes < MaxCrashes
  /\ crashes' = crashes + 1
  /\ SetW(w, Idle)
  /\ UNCHANGED <<now, rec, keys, keyOut, paid, recorded>>

Tick ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ UNCHANGED <<rec, wk, keys, keyOut, paid, recorded, crashes>>

Busy ==
  \/ \E w \in Workers :
       \/ Load(w) \/ Claim(w) \/ Pin(w) \/ PinReply(w) \/ Charge(w)
       \/ CommitLoad(w) \/ CommitWrite(w)
       \/ Release(w) \/ ReleaseWrite(w) \/ ReleaseLoad(w)
       \/ Crash(w)
  \/ Tick

(* Once nothing can happen, the system stays as it is. This step keeps   *)
(* /statechart from reading the end as a deadlock.                       *)
Settled == ~ENABLED Busy /\ UNCHANGED vars

Next == Busy \/ Settled

Spec == Init /\ [][Next]_vars

WorkerSymmetry == Permutations(Workers)

(* ------------------------------- rules --------------------------------- *)

(* The provider makes at most one successful charge per period.          *)
OneChargePerPeriod == \A p \in 1..Periods : paid[p] <= 1

(* A period the provider charged and no commit recorded stays            *)
(* recoverable: the record is flagged for reconciliation, or it still     *)
(* holds the pinned attempt for that period, and either its replay        *)
(* deadline has passed, so the next claim flags it (engine.ts:223-228),   *)
(* or the provider answers its key with that success, so the next claim   *)
(* replays it before the deadline (engine.ts:303).                        *)
NoLostOutcome ==
  \A p \in 1..Periods :
    paid[p] > 0 /\ p \notin recorded =>
      \/ rec.reconcile
      \/ /\ rec.pinned
         /\ NextKey(rec)[1] = p
         /\ \/ rec.replayUntil = Null \/ now >= rec.replayUntil
            \/ NextKey(rec) \in DOMAIN keyOut /\ keyOut[NextKey(rec)] = "succeeded"

(* A live record that is neither ended, flagged nor past the model's last *)
(* period always has a due time, so a sweep claims it again.              *)
Progress ==
  rec.status # "canceled" /\ ~rec.reconcile /\ ~Done(rec) => rec.dueAt # Null

=============================================================================
