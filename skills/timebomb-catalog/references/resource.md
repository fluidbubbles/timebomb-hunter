# Resource Exhaustion Timebombs

Code whose cost is constant in test and grows with data volume, concurrency, or uptime
in production. These are the classic "it was fast last month" failures.

**The mental test for every data access:** *what is the cost when this table has 1,000×
the rows it has today, or when 1,000× the requests hit it at once?* If the answer is
"linear" or "unbounded", it is a timebomb.

**Stack notes.** Postgres connections are scarce and expensive; a pooler (pgbouncer)
multiplexes them — code that holds connections or opens its own bypasses that. ORMs
(Prisma, Drizzle, TypeORM, Knex) make N+1 queries easy to write invisibly inside loops
and relation accessors.

### RES-01 — Unbounded query result (no LIMIT)
**Shape:** a SELECT with no `LIMIT` / pagination over a table that grows with usage.
**Greps:** `.select(` / `SELECT` with no `.limit(` / `.range(` / `LIMIT`; `findMany()` with no `take`.
**Why it detonates:** result size grows with the table; fine at 100 rows, multi-second and memory-heavy at 1M, eventual timeout/OOM.
**Tier:** `T1` for fast-growing tables (events, messages, line items); `T2` for slow-growing ones.
**Blast:** degradation → outage.
**Not a bug if:** the table is bounded by construction (a small enum/config table), or already filtered to a small, bounded subset.
**Fix:** keyset pagination + a hard `LIMIT`; never return an unbounded set.

### RES-02 — N+1 query
**Shape:** query a list, then issue one query per element inside a loop.
**Greps:** `.map(`/`for` loops containing `await db…` / `await prisma…`; relation access inside a `.map`.
**Why it detonates:** 1 + N round trips; latency and connection pressure grow linearly with the list, which grows with data.
**Tier:** `T1`.
**Blast:** degradation; pool pressure → outage.
**Not a bug if:** the list is small and fixed, or the loop body hits no I/O.
**Fix:** one query with a JOIN or `WHERE id IN (…)`; ORM eager-load (`include`/`with`); a DataLoader batch.

### RES-03 — Missing index on a filtered column
**Shape:** a `WHERE`, `JOIN`, or `ORDER BY` on a column with no supporting index.
**Greps:** query predicates on columns; cross-check migrations for `CREATE INDEX`; foreign keys with no index.
**Why it detonates:** Postgres falls back to a sequential scan; query time grows linearly with the table — invisible until the table is large.
**Tier:** `T1`–`T2` depending on table growth rate.
**Blast:** degradation → outage (one slow query holds a connection).
**Not a bug if:** the table is tiny and bounded, or a suitable composite/partial index already covers the predicate.
**Fix:** add the index (composite ordered to match the predicate; partial where applicable).

### RES-04 — Connection pool exhaustion or leak
**Shape:** more concurrent DB work than the pool allows; connections acquired and not released; or a new client/pool per request.
**Greps:** `new Pool(` / `new Client(` / `createClient(` inside handlers; `connect()` with no matching `release()`/`end()` on every path; missing `finally`.
**Why it detonates:** the pool drains → new requests queue → latency climbs → timeout cascade → effective outage.
**Tier:** `T0` if the pool is small relative to current concurrency; `T1` otherwise.
**Blast:** outage.
**Not a bug if:** connections are released in a `finally`, the pool is shared and sized for peak, and a pooler fronts it.
**Fix:** one shared, correctly sized pool; release in `finally`; no slow I/O while holding a connection; front with pgbouncer.

### RES-05 — Unbounded in-memory growth
**Shape:** a module-level `Map`/array/object cache that only ever grows — no eviction, TTL, or max size.
**Greps:** top-level `new Map()` / `{}` with `.set(`/`push(` but no `.delete(`/eviction/TTL.
**Why it detonates:** memory rises with distinct keys and uptime → slow leak → OOM crash days or weeks after deploy.
**Tier:** `T1`.
**Blast:** outage (OOM).
**Not a bug if:** the key space is small and fixed (config keyed by a bounded enum).
**Fix:** a bounded LRU with TTL and a max size; or an external cache (Redis) with eviction.

### RES-06 — Unbounded table growth with no retention
**Shape:** an append-only table (events, logs, audit, sessions, jobs, notifications) with no archival, TTL, or partitioning.
**Greps:** high-volume `.insert(` targets; tables never `DELETE`d from; no retention job or partition scheme.
**Why it detonates:** the table grows forever — every query, index, and `VACUUM` on it slows over time, and storage climbs without bound.
**Tier:** `T2` (slow but certain).
**Blast:** degradation → outage.
**Not a bug if:** a retention/archival policy or time partitioning already exists.
**Fix:** retention policy (delete/archive old rows), time-based partitioning, or move to a store built for the volume.

### RES-07 — Full-table aggregate on the request path
**Shape:** `COUNT(*)`, `SUM`, `AVG`, or `GROUP BY` over a whole growing table inside a request handler.
**Greps:** `count()` / `COUNT(*)` / aggregate calls with no narrow `WHERE`; dashboard/stats endpoints.
**Why it detonates:** constant-time today, linear in table size later; one growing dashboard query degrades a hot endpoint.
**Tier:** `T1`–`T2`.
**Blast:** degradation.
**Not a bug if:** the aggregate is over a small bounded subset, or already cached/materialized.
**Fix:** materialized view or a maintained summary row/table; approximate counts where exactness is not required.

### RES-08 — Large dataset processed in application memory
**Shape:** fetch all rows, then filter/sort/aggregate in JS instead of in SQL.
**Greps:** `.filter(` / `.reduce(` / `.sort(` immediately after a full `.select()`; `findMany()` then in-memory work.
**Why it detonates:** transfer cost and heap usage scale with the table; the database could have done the work in an index.
**Tier:** `T1`–`T2`.
**Blast:** degradation → outage (OOM).
**Not a bug if:** the dataset is provably small and bounded.
**Fix:** push the filter/sort/aggregate into the SQL query; stream or paginate if the result is genuinely large.

### RES-09 — Unbounded fan-out concurrency
**Shape:** `Promise.all` (or `forEach` with async) over an array whose size grows with data.
**Greps:** `Promise.all(items.map(async …))` where `items` is query output / all users / all tenants.
**Why it detonates:** thousands of simultaneous queries or HTTP calls launch at once → pool/socket exhaustion locally, overload downstream.
**Tier:** `T1`.
**Blast:** outage (self) or degradation (downstream).
**Not a bug if:** the array is small and bounded.
**Fix:** bounded concurrency — `p-limit`, fixed-size batches, or a queue.

### RES-10 — Missing timeout on an external call
**Shape:** an HTTP / DB / cache / queue call with no timeout.
**Greps:** `fetch(` / `axios(` / SDK calls with no timeout/`AbortSignal`; DB queries with no `statement_timeout`.
**Why it detonates:** one slow dependency holds connections and workers indefinitely → the wait propagates → cascading exhaustion.
**Tier:** `T1`.
**Blast:** outage.
**Not a bug if:** a timeout is configured globally on the client.
**Fix:** explicit timeouts on every external call; circuit breakers on critical dependencies.

### RES-11 — Per-request construction of an expensive resource
**Shape:** building a DB client, pool, HTTP agent, or heavy parser/object on every request.
**Greps:** `new Pool(` / `new SomeClient(` / heavy `new` inside handlers or per-request middleware.
**Why it detonates:** construction churn — connection storms, GC pressure, pool fragmentation — scaling with request rate.
**Tier:** `T1`–`T2`.
**Blast:** degradation → outage.
**Not a bug if:** the object is genuinely cheap or genuinely must be per-request.
**Fix:** construct once at module load; reuse the singleton across requests.
