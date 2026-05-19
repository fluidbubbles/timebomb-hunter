# timebomb-hunter

Spawns a team of specialized agents that hunt **scale timebombs** — code that works
fine today and detonates as your user base grows.

A timebomb is correct at 10 users and broken at 10,000: a query with no `LIMIT`, a
read-modify-write with no lock, a table query missing its tenant filter. Each one is
invisible in code review and in your tests. `timebomb-hunter` finds them before your
users do.

## What it hunts

| Concern | Examples |
|---------|----------|
| **Concurrency** | race conditions, non-atomic read-modify-write, TOCTOU, missing/wrong transaction boundaries, lock ordering, shared mutable state in a long-lived process |
| **Multi-tenant isolation** | missing RLS policies, queries missing a tenant/user filter, IDOR, auth-context leaks, cross-tenant cache keys |
| **Resource exhaustion** | connection pool starvation, unbounded result sets (no `LIMIT` / pagination), N+1 queries, missing indexes, unbounded table or cache growth |
| **Idempotency** | duplicate submit handling, webhook/event replay, non-idempotent retries, missing uniqueness constraints, double-processing in background jobs |

It is **stack-aware** for TypeScript/JavaScript on Postgres — it understands
supabase-js, Prisma, Drizzle, Knex, TypeORM, raw `pg`/`postgres.js`, raw SQL, and
Supabase RLS. It runs on other stacks too, with generic pattern detection.

## How it works

1. You run `/timebomb-hunter:hunt`.
2. A **`timebomb-explorer`** agent (Sonnet) maps the repo into modules and flags risky
   surfaces — DB access layers, API handlers, write paths, jobs, auth/RLS, caches —
   tagging each with the concerns that apply.
3. Four **specialist** agents (Opus), one per concern, fan out in parallel. Each scans
   only the surfaces tagged for it, so no agent re-reads the whole repo.
4. Findings are deduped, ranked by **detonation tier**, and written to a single
   self-contained HTML report.
5. Every run is saved. The next report shows the **delta** — what you fixed, what's
   new, what's still open.

## Severity — detonation tiers

| Tier | Meaning |
|------|---------|
| 🔴 **T0** | Breaking now or imminent — fails at current load |
| 🟠 **T1** | Breaks within ~10× growth |
| 🟡 **T2** | Breaks at high scale (100×+) |
| ⚪ **T3** | Latent — unsafe in principle, no realistic near-term trigger |

Within a tier, findings sort by blast radius: data loss > outage > degradation > minor.

## Install

Local / development:

```
claude --plugin-dir /path/to/timebomb-hunter
```

Or register the directory in a marketplace and install from there.

## Usage

```
/timebomb-hunter:hunt              # full-codebase audit
/timebomb-hunter:hunt src/api      # scope to a path or glob
/timebomb-hunter:hunt --diff       # only changes vs the main branch
/timebomb-hunter:hunt --diff main  # only changes vs a given ref
/timebomb-hunter:hunt --staged     # only staged changes
```

The explorer runs first and reports how many hotspots it found. You confirm before the
specialist team fans out, so a full audit never surprises you with its cost.

**Passive use:** just ask. Questions like *"is this query multi-tenant safe?"* or
*"will this race under load?"* surface the `timebomb-catalog` knowledge skill without
running the full team.

## Output

A single self-contained HTML report (no external assets) at
`./timebomb-hunter-reports/<timestamp>.html`, plus a machine-readable run record under
`./.timebomb-hunter/runs/`.

Add both to the scanned repo's `.gitignore`:

```
timebomb-hunter-reports/
.timebomb-hunter/
```

## Configuration (optional)

Create `.claude/timebomb-hunter.local.md` in the repo you scan:

```
---
scale_context: "~2,000 users today, targeting 50,000 within 12 months"
ignore:
  - "**/*.test.ts"
  - "**/dist/**"
  - "**/generated/**"
concerns: [concurrency, multi-tenancy, resource, idempotency]
report_dir: "./timebomb-hunter-reports"
models:
  explorer: sonnet
  specialists: opus
---

Free-form notes about the system's architecture, scale, or known risk areas.
The hunt agents read this to calibrate severity.
```

`scale_context` is the most valuable field: it tells the detonation tiers what
"10× growth" actually means for your system. Every field is optional and has a default.

## Prerequisites

- **Node.js** — for the report builder (zero npm dependencies, just the runtime).
- **A git repository** — required for `--diff` / `--staged` modes.

## Components

- **Skills** — `hunt` (the orchestrator) · `timebomb-catalog` (pattern knowledge, also
  the agents' shared reference).
- **Agents** — `timebomb-explorer` + `concurrency-hunter`, `multi-tenancy-hunter`,
  `resource-hunter`, `idempotency-hunter`.
- **Script** — `scripts/build-report.mjs` — deterministic fingerprinting, run-over-run
  delta, and HTML generation.

## License

MIT
