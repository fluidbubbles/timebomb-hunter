---
# timebomb-hunter settings — example template.
# Copy this file to  <your-repo>/.claude/timebomb-hunter.local.md  and edit.
# Every key is optional; delete what you do not need.

# The single most valuable setting. Free text describing where the system is today and
# where it is heading. It calibrates the detonation tiers — it tells the hunters what
# "10x growth" concretely means for you, so T0/T1/T2 are grounded in your reality.
scale_context: "~2,000 users today, targeting 50,000 within 12 months. Peak ~80 req/s."

# Extra glob patterns to skip, on top of the always-ignored defaults (node_modules,
# dist, build, .next, coverage, lockfiles, generated code, and test files).
ignore:
  - "**/*.generated.ts"
  - "packages/legacy/**"

# Which specialist hunters to run. Default: all four.
# Trim this to focus a run or to cut cost.
concerns: [concurrency, multi-tenancy, resource, idempotency]

# Where HTML reports are written. Default: ./timebomb-hunter-reports
report_dir: "./timebomb-hunter-reports"

# Optional per-role model override. Defaults: explorer = sonnet, specialists = opus.
models:
  explorer: sonnet
  specialists: opus
---

# timebomb-hunter — project notes

Anything below the frontmatter is free-form context the hunt agents read to calibrate
their analysis. Use it to record what they cannot infer from the code alone:

- **Architecture** — e.g. "Stateless API on Cloud Run, 2–20 instances autoscaled.
  Single Postgres (Supabase) behind pgbouncer in transaction mode."
- **Known hotspots** — the tables that grow fastest, the endpoints under the most load.
- **Scale facts** — current row counts of the big tables, peak concurrency, pool size.
- **Out of scope** — areas deliberately not worth auditing yet.

The more concrete this section is, the sharper the detonation-tier ranking will be.
