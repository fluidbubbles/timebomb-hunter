---
name: timebomb-catalog
description: This skill should be used when the user asks "will this scale", "is this a race condition", "is this concurrency-safe", "is this multi-tenant safe", "could this leak data between tenants", "will this query be slow at scale", "is this idempotent", "what happens if this runs twice", "is this a timebomb", or asks to assess whether a piece of code is safe under concurrency, load, data growth, or multiple users. Provides the timebomb-hunter pattern catalog — concurrency, multi-tenant isolation, resource exhaustion, and idempotency timebombs — and the detonation-tier severity model.
version: 0.1.0
---

# Timebomb Catalog

The reference knowledge base for **scale timebombs** — code that is correct today and
fails as a system grows. Use it to assess whether a specific piece of code is safe
under concurrency, load, data growth, or multiple tenants.

For a full-codebase sweep, use the `/timebomb-hunter:hunt` command instead — it spawns
the agent team. This skill answers targeted questions in the moment.

## The four concern areas

| Concern | The question it asks | Reference |
|---------|----------------------|-----------|
| Concurrency | What if two requests overlap? | `references/concurrency.md` (CONC-01..10) |
| Multi-tenant isolation | Can one tenant reach another's data? | `references/multi-tenancy.md` (TENANT-01..10) |
| Resource exhaustion | What is the cost at 1000× the data or load? | `references/resource.md` (RES-01..11) |
| Idempotency | What if this same operation runs twice? | `references/idempotency.md` (IDEM-01..09) |

## Severity — detonation tiers

Rank a finding by *when it detonates*, not by abstract severity:

- `T0` 🔴 — fails at current load
- `T1` 🟠 — fails within ~10× growth
- `T2` 🟡 — fails at high scale (100×+)
- `T3` ⚪ — latent; no realistic near-term trigger

Within a tier, order by blast radius: `data-loss` > `outage` > `degradation` > `minor`.
The full rubric, confidence levels, and the findings JSON contract are in
`references/severity-model.md`.

## Assessing a piece of code

To judge whether code is a timebomb:

1. **Identify the concern(s).** A DB read followed by a write → concurrency. A query of
   tenant-owned data → multi-tenancy. A loop with I/O, an unbounded query, or an
   in-memory cache → resource. A mutating endpoint, webhook, or job consumer →
   idempotency. Risky code usually touches several.
2. **Open the matching reference file** and scan its patterns. Each pattern gives its
   shape, the greps that find it, why it detonates, its typical tier, and a
   "Not a bug if" clause.
3. **Apply the "Not a bug if" test before reporting.** An audit that cries wolf gets
   ignored. Flag only code that genuinely matches.
4. **Assign a tier** by asking how much growth from today until it breaks.
5. **Explain the mechanism, not the label.** "Two concurrent transfers both read
   balance 100 and both write 90; one debit is lost" — not "possible race condition".

## Stack awareness

The catalog is tuned for TypeScript/JavaScript on Postgres: supabase-js, Prisma,
Drizzle, Knex, TypeORM, raw `pg`/`postgres.js`, raw SQL, and Supabase Row-Level
Security. The patterns are language-portable; only the greps are stack-specific.

## Reference files

- **`references/severity-model.md`** — tier rubric, blast radius, confidence, the findings JSON contract, fingerprinting.
- **`references/concurrency.md`** — 10 concurrency patterns (CONC-01..10).
- **`references/multi-tenancy.md`** — 10 isolation patterns (TENANT-01..10).
- **`references/resource.md`** — 11 resource patterns (RES-01..11).
- **`references/idempotency.md`** — 9 idempotency patterns (IDEM-01..09).
