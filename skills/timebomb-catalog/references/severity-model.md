# Severity Model & Findings Contract

Defines how findings are ranked and the exact JSON shape every hunter must emit. All
specialist agents and `scripts/build-report.mjs` depend on this file.

## Detonation tiers

A timebomb is ranked by *when it detonates* — when its trigger condition becomes
routine — not by abstract "severity". Four tiers:

| Tier | Label | Definition |
|------|-------|------------|
| `T0` | 🔴 Detonating | Fails at **current** load. The trigger (concurrent access to a hot row, a tenant with many rows, a drained pool) is already met by today's traffic. Incidents are plausibly happening now. |
| `T1` | 🟠 Imminent | Safe today, fails within **~10× growth** — one order of magnitude more users, data, concurrency, or tenants. The danger zone for a growing product. |
| `T2` | 🟡 At scale | Fails only at **high scale (≥100×)** — large data volumes or heavy concurrency. Real, but not the near-term fire. |
| `T3` | ⚪ Latent | Violates a correctness invariant but has **no realistic foreseeable trigger** (an unreachable concurrent path, a table that structurally cannot grow). Recorded so it is not lost. |

A finding's tier answers one question: *"How much growth from today until this
breaks?"* None → `T0`. ~10× → `T1`. ~100×+ → `T2`. Not foreseeable → `T3`.

## Calibration with `scale_context`

The settings file may supply `scale_context` (free text, e.g. "~2,000 users today,
targeting 50,000 in 12 months"). Treat it as the definition of "current load" and "10×".

Without `scale_context`, estimate current scale from repo signals: presence of
pagination, connection-pool size, a pooler (pgbouncer), caching layers, queue
infrastructure, table and index design. Always state the assumption in `at_what_scale`
so the reader can correct it.

## Blast radius — within-tier ordering

Within a tier, findings sort by blast radius (worst first):

| Value | Meaning |
|-------|---------|
| `data-loss` | Silent corruption, lost writes, cross-tenant leakage. Worst — undetectable and often irreversible. |
| `outage` | Crash, hang, deadlock, pool exhaustion — total or broad unavailability. |
| `degradation` | Slowdown, elevated latency, partial failures, timeouts under load. |
| `minor` | Narrow or self-recovering impact. |

## Confidence

Every finding carries a confidence level. The report filters `low` out by default.

| Level | Bar |
|-------|-----|
| `high` | The defect is provable from the cited code alone; the mechanism is certain. |
| `medium` | The pattern is clearly present, but realizing the failure depends on runtime context not fully verified (e.g. whether two callers actually race depends on routing). |
| `low` | A suspicious shape that is plausibly safe depending on code not seen. Reported for completeness only. |

Never raise confidence to compensate for a weak finding. A noisy audit gets ignored.

## Findings contract

Each specialist agent returns its findings as a JSON array. Each finding object:

| Field | Type | Notes |
|-------|------|-------|
| `concern` | string | `concurrency` \| `multi-tenancy` \| `resource` \| `idempotency` |
| `pattern_id` | string | Catalog ID, e.g. `CONC-01`. Must exist in the concern's reference file. |
| `title` | string | One specific line — name the function and the defect, not the pattern. |
| `file` | string | Repo-relative path. |
| `line` | number | Line of the primary evidence. For display; not used in the fingerprint. |
| `symbol` | string | Enclosing function / method / class / component name. Used in the fingerprint. |
| `tier` | string | `T0` \| `T1` \| `T2` \| `T3`. |
| `blast_radius` | string | `data-loss` \| `outage` \| `degradation` \| `minor`. |
| `confidence` | string | `high` \| `medium` \| `low`. |
| `what_breaks` | string | The failure mechanism — the precise interleaving or scale condition that produces the fault. |
| `at_what_scale` | string | The trigger, and the growth assumption behind the tier. |
| `evidence` | string | The actual code (a few lines) that proves the finding. |
| `suggested_fix` | string | Concrete direction — name the technique. Not a diff; the plugin never edits code. |

Agents do **not** compute fingerprints — `build-report.mjs` does.

## Fingerprinting

`build-report.mjs` identifies a finding across runs by:

```
fingerprint = sha1(concern + "|" + file + "|" + symbol + "|" + pattern_id)
```

Line number is deliberately excluded — lines shift on every commit, and a line-based ID
would mark every finding "new" after any edit above it. `symbol` survives line moves.
Renaming a function reads as one finding fixed + one new — acceptable.

The run-over-run delta is set arithmetic on fingerprints: `fixed` = in the previous run
but not the current; `new` = in the current but not the previous; `still-open` = in both.
