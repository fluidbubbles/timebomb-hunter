---
name: hunt
description: This skill should be used when the user runs `/timebomb-hunter:hunt`, or asks to "hunt for timebombs", "find scale timebombs", "run a scale audit", "audit the codebase for concurrency bugs", "find race conditions across the codebase", "check for multi-tenant data leaks", or "find code that will break as we grow". Orchestrates the timebomb-hunter agent team — an explorer plus four specialist hunters — and produces a ranked HTML report.
argument-hint: "[path | --diff [ref] | --staged]"
version: 0.1.0
---

# Hunt — Timebomb Audit Orchestrator

Run a team of agents that hunt **scale timebombs** — code correct today that breaks as
the system grows. This skill orchestrates the pipeline: a `timebomb-explorer` maps the
codebase, four specialist hunters fan out in parallel, and a deterministic script
builds a self-contained HTML report with a delta against the previous run.

This file is the orchestrator's playbook. Execute the steps in order. Never edit source
code — this skill only finds and reports.

## Arguments

`$ARGUMENTS` selects the scan scope:

| Argument | Scope |
|----------|-------|
| (none) | Full-codebase audit |
| `<path>` or `<glob>` | Only that path / glob |
| `--diff [ref]` | Only files changed vs `ref` (default: merge-base with the main branch) |
| `--staged` | Only staged files |

## Pipeline

Track the six steps with the Task tools so the user sees progress.

### Step 1 — Set up the run

1. Resolve `repo_root` — `git rev-parse --show-toplevel`, else the working directory.
2. Load settings: read `<repo_root>/.claude/timebomb-hunter.local.md` if it exists and
   parse its YAML frontmatter. Recognized keys, with defaults:
   - `scale_context` — free text; default empty.
   - `ignore` — extra glob patterns; default empty. Always also ignore `node_modules`,
     `dist`, `build`, `.next`, `coverage`, generated code, lockfiles, and test files
     (`*.test.*`, `*.spec.*`, `__tests__`).
   - `concerns` — which hunters to run; default all four (`concurrency`,
     `multi-tenancy`, `resource`, `idempotency`).
   - `report_dir` — default `<repo_root>/timebomb-hunter-reports`.
   - `models` — optional per-role model override.
3. Determine the scope from `$ARGUMENTS`:
   - `--diff [ref]`: require a git repo. Resolve the main branch (`main` or `master`).
     File list: `git diff --name-only $(git merge-base HEAD <ref>) HEAD`.
   - `--staged`: `git diff --name-only --cached`.
   - a path/glob: use it directly.
   - none: `full`.
4. Generate `run_id` with `date +%Y-%m-%d-%H%M%S` (sortable — the report builder relies
   on lexical ordering to find the previous run).
5. Create the run dir: `<repo_root>/.timebomb-hunter/runs/<run_id>/`.
6. Write `<run_dir>/meta.json`:
   `{ "scope": "<full|path|diff|staged>", "scale_context": "<text>", "started_at": "<ISO>" }`.
7. If `.timebomb-hunter/` is not git-ignored, remember to offer to add it in Step 6.

### Step 2 — Map the codebase (explorer)

Dispatch the `timebomb-explorer` agent with the Task tool
(`subagent_type: timebomb-explorer`). In its prompt provide:

- `repo_root` (absolute) and `run_dir` (absolute)
- `scope`: `full`, the path/glob, or — for diff/staged — the explicit changed-file
  list (write it to `<run_dir>/scope-files.txt` and pass that path if it is long)
- `ignore`: the combined ignore globs from Step 1

The explorer writes `<run_dir>/risk-map.json` and returns a summary.

### Step 3 — Confirm scope

Read `<run_dir>/risk-map.json`. Report the hotspot count, the by-concern breakdown,
and the detected stack.

- If the hotspot count is **0**, tell the user there is nothing to hunt, and stop.
- If it is **above ~20**, pause: a full fan-out spends four Opus agent passes. Use
  AskUserQuestion to confirm — proceed / narrow the scope / cancel.
- At or below ~20, proceed directly.

### Step 4 — Fan out the specialists

For each concern in the `concerns` setting, dispatch its hunter **in parallel** — put
all the Task calls in a single message so they run concurrently:

| Concern | `subagent_type` | Catalog file |
|---------|-----------------|--------------|
| concurrency | `concurrency-hunter` | `concurrency.md` |
| multi-tenancy | `multi-tenancy-hunter` | `multi-tenancy.md` |
| resource | `resource-hunter` | `resource.md` |
| idempotency | `idempotency-hunter` | `idempotency.md` |

Use the dispatch template below. Each hunter writes
`<run_dir>/findings-<concern>.json` and returns a summary. Wait for all of them before
Step 5.

### Step 5 — Build the report

Run the report builder via Bash:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/build-report.mjs --run-dir <run_dir> --report-dir <report_dir>
```

It fingerprints findings, computes the delta against the previous run, writes
`<run_dir>/report.json`, and prints the HTML report path to stdout. Capture that path.

### Step 6 — Present results

Read `<run_dir>/report.json` and give the user:

- The tier counts (T0 / T1 / T2 / T3) and the total.
- The delta line, if present — fixed / new / still-open vs the previous run.
- Every `T0` and `T1` finding as one line: title + `file:line`.
- The HTML report path. Offer to open it (`open <path>` on macOS).
- If `.timebomb-hunter/` or the report dir is not git-ignored, offer to add both.

## Specialist dispatch template

Send this as the Task prompt for each hunter, substituting `<concern>`:

```
Timebomb-hunter audit — you are the <concern> specialist. Inputs:
- repo_root: <absolute repo root>
- run_dir: <absolute run dir>
- risk_map: <run_dir>/risk-map.json
- catalog: ${CLAUDE_PLUGIN_ROOT}/skills/timebomb-catalog/references/<concern>.md
- severity_model: ${CLAUDE_PLUGIN_ROOT}/skills/timebomb-catalog/references/severity-model.md
- scale_context: "<scale_context text, or empty>"

Follow your agent instructions: read severity_model and catalog first, select the
risk_map hotspots tagged with your concern, analyze the real code, and write your
findings as a JSON array to <run_dir>/findings-<concern>.json. Then summarize.
```

## Settings

Settings live in `<repo_root>/.claude/timebomb-hunter.local.md` (YAML frontmatter); all
keys are optional. See `examples/timebomb-hunter.local.md` alongside this skill for a
copyable template. The most valuable key is `scale_context` — it calibrates the
detonation tiers.

## Edge cases

- **Not a git repo:** `--diff` and `--staged` are unavailable; tell the user and offer
  a full or path-scoped audit instead.
- **Empty diff:** if the changed-file list is empty, say so and stop before spawning.
- **A hunter fails or writes no file:** `build-report.mjs` treats a missing
  `findings-<concern>.json` as empty and notes it. Report the gap to the user — do not
  silently drop that concern.
- **`node` unavailable:** `build-report.mjs` cannot run, so there is no HTML report or
  delta. The raw `findings-*.json` still exist in the run dir — summarize from those
  and tell the user to install Node, then re-run the builder.
