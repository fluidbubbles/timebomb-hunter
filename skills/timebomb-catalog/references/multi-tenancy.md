# Multi-Tenant Isolation Timebombs

Code that keeps tenants' data separate when there is one tenant in test and leaks it
when there are thousands in production.

**The core rule:** every read and write of tenant-owned data must be constrained to the
*authenticated* caller's tenant — and that constraint must hold even if a developer
forgets it in one query. That means two layers: an explicit scope predicate in the
query **and** a database backstop (Postgres Row-Level Security). One layer is a
timebomb; the missing layer is the detonator.

**Stack notes.** Supabase exposes Postgres directly to clients — RLS *is* the
authorization model there. The `anon` and `authenticated` keys are public; the
`service_role` key bypasses RLS entirely. Hunt for tables without RLS and for
`service_role` usage on user-facing paths.

### TENANT-01 — Query missing tenant/owner scope
**Shape:** a SELECT/UPDATE/DELETE filtered by a resource id but not by `tenant_id` / `user_id` / `org_id`.
**Greps:** `.eq('id', ...)` / `WHERE id =` with no companion tenant predicate; `.from(table)` queries lacking an owner filter.
**Why it detonates:** if the id is client-supplied, any caller can name another tenant's row → cross-tenant read or write.
**Tier:** `T0` if the id comes from the request and no RLS backstops the table; `T1` if RLS exists but is the only guard.
**Blast:** data-loss (cross-tenant leakage / corruption).
**Not a bug if:** the id was just derived from the caller's own session, or RLS fully constrains the table.
**Fix:** add the tenant predicate to every query; keep RLS as defense-in-depth.

### TENANT-02 — Table without RLS
**Shape:** a Postgres/Supabase table holding tenant data with RLS disabled or no policy.
**Greps:** migrations creating tables with no `ENABLE ROW LEVEL SECURITY`; no `CREATE POLICY` for the table.
**Why it detonates:** with RLS off, any holder of the public `anon`/`authenticated` key can read or write every row of every tenant.
**Tier:** `T0` — exposed the moment the table has data and the client key is public.
**Blast:** data-loss, security breach.
**Not a bug if:** the table is server-only and never reachable by a client key, and that is enforced by grants.
**Fix:** `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and add policies scoped to `auth.uid()` / the tenant.

### TENANT-03 — Permissive RLS policy
**Shape:** RLS enabled but the policy is effectively open.
**Greps:** `USING (true)`; policies referencing only client-controllable columns; `FOR ALL` where reads and writes need different rules.
**Why it detonates:** the policy passes for every row, so RLS provides no isolation despite appearing "on".
**Tier:** `T0`–`T1`.
**Blast:** data-loss, security breach.
**Not a bug if:** the table is genuinely public-read (e.g. a shared catalog) and writes are separately constrained.
**Fix:** scope `USING`/`WITH CHECK` to `auth.uid()` or the tenant; separate `SELECT`/`INSERT`/`UPDATE`/`DELETE` policies.

### TENANT-04 — IDOR: unchecked direct object reference
**Shape:** an endpoint takes a resource id from the request and fetches/mutates it with no ownership check.
**Greps:** route params / body fields like `:id`, `params.id`, `body.accountId` passed straight into a query.
**Why it detonates:** a caller substitutes another tenant's id and reads or modifies their resource.
**Tier:** `T0` if no RLS; `T1` with RLS as sole guard.
**Blast:** data-loss, security breach.
**Not a bug if:** ownership is verified (the query also filters by the caller's tenant, or RLS enforces it).
**Fix:** verify the resource belongs to the caller's tenant before acting on it.

### TENANT-05 — Tenant identity sourced from the client
**Shape:** `tenant_id` / `org_id` / `user_id` read from the request body, query string, or a custom header.
**Greps:** `req.body.tenantId`, `req.headers['x-org-id']`, `query.userId` used as the scope of a query.
**Why it detonates:** the client simply sends a different tenant id and operates as that tenant.
**Tier:** `T0`.
**Blast:** data-loss, security breach.
**Not a bug if:** the value is cross-checked against the authenticated session and rejected on mismatch.
**Fix:** derive tenant identity *only* from the verified auth token / session.

### TENANT-06 — RLS-bypassing client on a user-facing path
**Shape:** the Supabase `service_role` key, or a superuser/`postgres` DB connection, used in code that serves user requests.
**Greps:** `service_role`, `SUPABASE_SERVICE_ROLE_KEY`, `createClient(...serviceKey)` inside request handlers / shared API code.
**Why it detonates:** `service_role` bypasses RLS — every query then returns all tenants' rows; one missing app-level filter leaks everything.
**Tier:** `T0`–`T1`.
**Blast:** data-loss, security breach.
**Not a bug if:** confined to trusted server-only jobs (migrations, admin tooling) never reachable by user input.
**Fix:** use the user-scoped (`authenticated`) client on request paths; reserve `service_role` for isolated trusted code.

### TENANT-07 — Cross-tenant cache key collision
**Shape:** a cache key that omits the tenant/user.
**Greps:** `cache.get('dashboard')`, `redis.get(\`report:${id}\`)` where `id` is not tenant-scoped; memoization keyed only by resource id.
**Why it detonates:** tenant A populates the entry, tenant B reads it → B is served A's data.
**Tier:** `T0` once the cache is warm under multi-tenant traffic.
**Blast:** data-loss (cross-tenant leakage).
**Not a bug if:** the cached data is genuinely tenant-independent.
**Fix:** namespace every cache key with the tenant/user id.

### TENANT-08 — Shared resource not partitioned by tenant
**Shape:** a rate limiter, counter, quota, file path, queue, or upstream credential shared across tenants with no partitioning.
**Greps:** global rate-limit keys, shared upload directories, one queue for all tenants.
**Why it detonates:** one tenant's volume exhausts the shared resource and starves or throttles the others ("noisy neighbour").
**Tier:** `T1`–`T2`.
**Blast:** degradation, outage for co-tenants.
**Not a bug if:** the resource is intentionally global and capacity is provisioned for the whole fleet.
**Fix:** partition the resource by tenant (per-tenant keys, quotas, paths).

### TENANT-09 — Tenant scoping in app code only (no DB backstop)
**Shape:** isolation depends entirely on every query remembering the tenant filter; no RLS.
**Greps:** a data-access layer that adds `.eq('tenant_id', …)` by convention, with RLS disabled on those tables.
**Why it detonates:** the system is one forgotten `WHERE` away from a leak — and that omission is invisible in review and tests.
**Tier:** `T1` — a latent class risk that a single future query turns into `T0`.
**Blast:** data-loss.
**Not a bug if:** RLS already enforces isolation independently of app code.
**Fix:** enable RLS as the backstop so a missed filter still cannot leak.

### TENANT-10 — Enumerable IDs on tenant resources
**Shape:** auto-increment integer primary keys on tenant-owned resources exposed in URLs/APIs.
**Greps:** `serial` / `bigserial` / `identity` PKs on tenant tables; sequential ids in routes.
**Why it detonates:** sequential ids make IDOR (TENANT-04) trivial to exploit at scale — an attacker just counts.
**Tier:** `T2` on its own; escalates any co-occurring IDOR.
**Blast:** security breach.
**Not a bug if:** ids are never exposed externally, or ownership is always enforced.
**Fix:** use UUIDs for externally visible ids — and still enforce ownership (a UUID is not authorization).
