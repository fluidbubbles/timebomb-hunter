# Idempotency Timebombs

Code that produces the right effect when it runs once and the wrong effect when it runs
twice. Distinct from concurrency: concurrency asks *"what if two run at the same
time?"*; idempotency asks *"what if this same operation runs again?"*

**Why "again" is not hypothetical.** At scale, repeats are guaranteed:

- Clients retry on timeout — and a timeout does **not** mean the request failed; it may
  have succeeded with a lost response.
- Users double-click; browsers re-POST; mobile networks resend.
- Webhook providers (Stripe, payment processors, GitHub) retry deliveries by design.
- Message queues are **at-least-once**: redelivery on a missed ack is normal, not an
  error.
- Load balancers and SDKs retry idempotent-looking calls automatically.

Hunt every mutating operation and every consumer for: *"if this runs twice, is the
result identical to running it once?"* If not, it is a timebomb.

### IDEM-01 — Non-idempotent mutating endpoint
**Shape:** a POST that creates a row, charges money, or sends a message, with no idempotency key.
**Greps:** `POST` handlers doing `.insert(` / charge / send, with no dedup key checked first.
**Why it detonates:** a client retry after a lost response repeats the effect → duplicate order, double charge, double email.
**Tier:** `T0`–`T1` — retries happen as soon as there is real traffic and real latency.
**Blast:** data-loss (duplicates) / financial.
**Not a bug if:** the operation is naturally idempotent, or an idempotency key is required and de-duplicated.
**Fix:** accept a client-supplied idempotency key; record it; on replay return the stored result instead of re-acting.

### IDEM-02 — Webhook handler without replay protection
**Shape:** a webhook endpoint that processes the event with no event-id deduplication.
**Greps:** `/webhook` / `/callback` routes; Stripe/processor handlers acting without checking the event id.
**Why it detonates:** providers deliberately retry and send duplicates; without dedup the side effect (credit grant, fulfillment) runs every time.
**Tier:** `T0` — duplicate deliveries are a normal, frequent event.
**Blast:** data-loss / financial.
**Not a bug if:** the event id is recorded and already-seen events are skipped (ideally in the same transaction as the effect).
**Fix:** persist processed event ids; ignore an event already seen; verify signatures.

### IDEM-03 — Missing uniqueness constraint
**Shape:** uniqueness enforced only by an application-level check, with no DB `UNIQUE` constraint.
**Greps:** "check if exists then insert" logic; tables that should be unique on `(tenant_id, email)` etc. but whose migration has no `UNIQUE`.
**Why it detonates:** the app check is a TOCTOU race (see CONC-02); under concurrency or retry, duplicates slip past it. Only the database can truly guarantee uniqueness.
**Tier:** `T1`.
**Blast:** data-loss (duplicate records corrupt downstream logic).
**Not a bug if:** a DB unique constraint or unique index already backs the invariant.
**Fix:** add the `UNIQUE` constraint/index; treat the app check as a UX nicety, not the guarantee.

### IDEM-04 — Non-idempotent queue consumer or job
**Shape:** a queue/stream consumer or scheduled job that assumes exactly-once delivery.
**Greps:** consumers for SQS/PgBoss/BullMQ/Kafka doing side effects with no message-id dedup.
**Why it detonates:** queues are at-least-once; a crash before ack, or a visibility-timeout expiry, redelivers the message → the side effect runs again.
**Tier:** `T1`.
**Blast:** data-loss / financial.
**Not a bug if:** the handler is idempotent, or dedups on message id.
**Fix:** make handlers idempotent; dedup on a stored message/job id; do the effect and the ack/state-update atomically.

### IDEM-05 — Side effect not ordered against the DB commit
**Shape:** an external side effect (charge, email, third-party call) performed before the DB commit, or the commit performed with the side effect left to a separate uncoordinated step.
**Greps:** `await stripe.charge(...)` / `await sendEmail(...)` adjacent to a separate `.insert()`/commit with no outbox.
**Why it detonates:** a crash in the gap leaves an inconsistent world — charged but no order, or order but no charge — and a retry cannot tell which half happened.
**Tier:** `T1`.
**Blast:** data-loss / financial.
**Not a bug if:** a transactional outbox or saga coordinates the effect with the commit.
**Fix:** transactional outbox — commit an intent row in the same transaction, deliver the side effect from it idempotently.

### IDEM-06 — Auto-retry wrapping a non-idempotent call
**Shape:** automatic retry logic (a wrapper, SDK retry config, `p-retry`) around a call that is not safe to repeat.
**Greps:** `retry(` / `maxRetries` / `p-retry` around POSTs, charges, inserts, sends.
**Why it detonates:** the retry fires on a timeout where the original actually succeeded → the non-idempotent effect runs twice.
**Tier:** `T1`.
**Blast:** data-loss / financial.
**Not a bug if:** only idempotent operations are retried, or each retry carries the same idempotency key.
**Fix:** retry only idempotent operations; attach an idempotency key so repeats are de-duplicated server-side.

### IDEM-07 — Job double-run with no leader election
**Shape:** a scheduled/cron job that can run on every instance, with no lock or leader election.
**Greps:** `setInterval`/`cron` registrations in code that runs on every instance; no advisory lock around the job body.
**Why it detonates:** with N instances the job runs N times each tick → N× the emails, charges, or batch effects.
**Tier:** `T0` once the app runs more than one instance.
**Blast:** data-loss / financial.
**Not a bug if:** a single-runner guarantee exists (advisory lock, leader election, a dedicated scheduler).
**Fix:** wrap the job in a Postgres advisory lock or leader election so exactly one instance runs it.

### IDEM-08 — Check-then-insert instead of upsert
**Shape:** "create or update" implemented as SELECT-then-INSERT/UPDATE rather than an atomic upsert.
**Greps:** `if (existing) update else insert`; get-or-create helpers.
**Why it detonates:** the check-then-act window (CONC-02) lets a retry or concurrent call insert a duplicate; the operation is not idempotent.
**Tier:** `T1`.
**Blast:** data-loss.
**Not a bug if:** implemented as an atomic `INSERT … ON CONFLICT … DO UPDATE` against a unique constraint.
**Fix:** use a real upsert (`INSERT … ON CONFLICT`) backed by a unique constraint.

### IDEM-09 — Increment-based counter or aggregate
**Shape:** a stored counter/total updated by `value = value + 1` on each event.
**Greps:** `count + 1`, `total + amount` updates driven by events, webhooks, or job runs.
**Why it detonates:** a retry or duplicate delivery double-counts, and because only the running total is kept there is no source of truth to reconcile against.
**Tier:** `T1`.
**Blast:** data-loss (silently wrong numbers).
**Not a bug if:** the increment is de-duplicated by event id, or the figure is derived on read from immutable source rows.
**Fix:** derive aggregates from immutable source-of-truth rows; or dedup the increment by event id.

> Idempotency findings often share a root cause with concurrency findings (a missing
> unique constraint is both CONC-02 and IDEM-03). Report from the idempotency angle —
> "what happens on a repeat" — and let the orchestrator merge duplicates at the same
> `file:symbol`.
