# Concurrency Timebombs

Code that is correct when one request runs at a time and wrong when two overlap.

**The Node nuance.** A Node process runs JS on a single thread — two lines of
synchronous JS never interleave. The race surface is elsewhere:

- **`await` is an interleaving point.** Between `await x` and the next line, the event
  loop runs other requests' continuations. A value read before an `await` may be stale
  after it.
- **Multiple instances.** Horizontally scaled apps run many processes; in-memory
  "safety" is per-process and meaningless across the fleet.
- **The database is genuinely concurrent.** Two requests' SQL runs in true parallel.
  Most real concurrency timebombs live at the DB boundary.

Hunt around `await`, around a DB read followed by a related DB write, and around any
state shared between requests.

### CONC-01 — Read-modify-write without atomicity
**Shape:** read a value (SELECT) → compute in JS → write it back (UPDATE).
**Greps:** an `.update(` / `UPDATE` of a column that was just `.select(`-ed; arithmetic such as `balance -`, `count + 1`, `quantity -`, `+ amount`.
**Why it detonates:** two requests interleave between the read and the write; both write `old ± n`; one change is silently lost.
**Tier:** `T0` if the row is hot (counters, balances, inventory of popular items, aggregate rows); `T1` for ordinary rows.
**Blast:** data-loss.
**Not a bug if:** the write uses an atomic SQL expression (`balance = balance - $1`), runs inside `SELECT … FOR UPDATE`, or the row was just inserted by this request.
**Fix:** atomic SQL expression; or `SELECT … FOR UPDATE` inside a transaction; or an optimistic `version` column.

### CONC-02 — Check-then-act (TOCTOU)
**Shape:** SELECT to check existence / quota / state, then INSERT or UPDATE based on the result.
**Greps:** `if (!existing)` / `if (count <` / `if (!found)` followed by `.insert(` / `.update(`; "create if not exists" logic.
**Why it detonates:** two requests both pass the check before either acts → duplicate insert, over-quota, double state transition.
**Tier:** `T0`–`T1` — duplicates appear as soon as any retry or concurrent submit occurs.
**Blast:** data-loss (duplicates) or degradation.
**Not a bug if:** the act is guarded by a DB `UNIQUE` constraint or an atomic conditional write that makes the check redundant.
**Fix:** unique constraint + handle the conflict; or `INSERT … ON CONFLICT`; or a conditional `UPDATE … WHERE` that fails atomically.

### CONC-03 — Missing transaction boundary
**Shape:** several related writes (create order + decrement stock + write ledger) issued as independent statements.
**Greps:** multiple `.insert(`/`.update(`/`.delete(` in one handler with no `transaction(` / `BEGIN` / `db.tx` wrapper.
**Why it detonates:** a crash, throw, or timeout between writes leaves the data half-applied; concurrent readers see the inconsistent middle state.
**Tier:** `T1` — partial failures become routine as error rates rise with traffic.
**Blast:** data-loss.
**Not a bug if:** the writes are independent, or a single statement, or reconciled by an idempotent retry.
**Fix:** wrap the related writes in one transaction.

### CONC-04 — Wrong transaction scope or isolation
**Shape:** a transaction that holds open across network/HTTP calls or slow work; or logic that needs `REPEATABLE READ`/`SERIALIZABLE` running under default `READ COMMITTED`.
**Greps:** `await fetch(` / external SDK calls inside a `transaction(` block; `FOR UPDATE` with no surrounding isolation reasoning.
**Why it detonates:** long transactions hold row locks and a pooled connection → lock contention and pool drain under load; wrong isolation lets concurrent transactions both act on stale snapshots.
**Tier:** `T1`–`T2`.
**Blast:** outage (lock pile-up) or data-loss (isolation).
**Not a bug if:** the transaction is short, does only DB work, and the invariant holds under `READ COMMITTED`.
**Fix:** shrink the transaction; move I/O outside it; raise isolation where the invariant requires it.

### CONC-05 — Mutable module-level state in a request handler
**Shape:** `let`/`const` `Map`/array/object at module scope, mutated while serving requests.
**Greps:** top-level `let cache = {}` / `const sessions = new Map()` / `let current` in server code; module-scope mutation inside a handler.
**Why it detonates:** the value is shared by every concurrent request in the process and diverges between instances → data leaks between requests/users, lost updates on the structure.
**Tier:** `T0` if it holds per-request or per-user data; `T1` otherwise.
**Blast:** data-loss (cross-request leakage).
**Not a bug if:** the state is immutable after init (config, compiled regex) or an intentional process-local cache of non-user data with correct invalidation.
**Fix:** per-request scope; or an external store (Redis); or make it immutable.

### CONC-06 — Per-request data on a shared instance
**Shape:** a singleton service stores request-specific data on `this`, then `await`s, then reads `this` back.
**Greps:** `this.currentUser =` / `this.context =` on a class instantiated once; assignment to `this` followed by `await` then a read.
**Why it detonates:** another request's continuation overwrites `this.x` during the `await`; the first request resumes with the second's data.
**Tier:** `T0` — interleaving happens at any real concurrency.
**Blast:** data-loss (cross-request leakage), security.
**Not a bug if:** a fresh instance is created per request, or the field is set and read with no `await` between.
**Fix:** never store per-request data on a shared instance; pass it through the call stack or use `AsyncLocalStorage`.

### CONC-07 — Cache stampede / unsynchronized lazy init
**Shape:** lazy singleton init or cache-fill with no in-flight deduplication.
**Greps:** `if (!cached) cached = await expensive()`; lazy getters doing async work.
**Why it detonates:** N concurrent callers all see the empty cache and all run the expensive init at once → thundering herd on the DB or upstream.
**Tier:** `T1`–`T2` — harmless at low concurrency, painful at high.
**Blast:** degradation, possible outage of the upstream.
**Not a bug if:** the init is cheap, or already single-flighted.
**Fix:** cache the in-flight *promise*, not just the resolved value (single-flight).

### CONC-08 — Fire-and-forget / unawaited promise
**Shape:** an async call whose promise is never awaited.
**Greps:** a statement line that is a bare `somethingAsync()` with no `await`/`return`/`.catch`; `void fn()`.
**Why it detonates:** errors vanish unhandled, ordering is not guaranteed, and the work may run after the response is sent or be dropped on shutdown.
**Tier:** `T1` — lost work and unhandled rejections scale with traffic.
**Blast:** data-loss or degradation.
**Not a bug if:** it is genuinely best-effort *and* has its own `.catch`, or is deliberately handed to a durable queue.
**Fix:** `await` it, or enqueue it as a real durable job.

### CONC-09 — Inconsistent lock ordering (deadlock)
**Shape:** acquiring multiple row locks or advisory locks in an order that differs between code paths.
**Greps:** multiple `FOR UPDATE` / `pg_advisory_lock` per transaction; locking two entities by id without sorting.
**Why it detonates:** path A locks row 1 then 2, path B locks 2 then 1 → mutual wait → deadlock; Postgres aborts one transaction.
**Tier:** `T1`–`T2`.
**Blast:** outage (aborted transactions, retries pile up).
**Not a bug if:** only one lock is ever held, or locks are always acquired in a fixed total order.
**Fix:** acquire locks in a consistent order (e.g. sort the IDs before locking).

### CONC-10 — Last-write-wins on concurrent edits
**Shape:** UPDATE of a whole record or JSON blob with no version/`updated_at` guard.
**Greps:** `.update(entireObject)` from a prior `.select()`; PATCH/PUT handlers that overwrite all columns.
**Why it detonates:** two users edit the same entity from stale copies; the second save silently discards the first's changes.
**Tier:** `T1` — common once multiple users or multiple tabs touch the same data.
**Blast:** data-loss.
**Not a bug if:** updates are field-scoped and commutative, or guarded by an optimistic version check.
**Fix:** optimistic locking — `UPDATE … WHERE version = $expected`, reject on zero rows; or field-level updates.
