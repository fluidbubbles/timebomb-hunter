#!/usr/bin/env node
/**
 * build-report.mjs — timebomb-hunter report builder.
 *
 * Deterministic post-processing for one hunt run: fingerprints findings, computes the
 * delta against the previous run, writes a canonical report.json, and emits a
 * self-contained HTML report. Zero npm dependencies — Node stdlib only.
 *
 * Usage:
 *   node build-report.mjs --run-dir <dir> --report-dir <dir>
 *
 * The run dir may contain (anything missing is treated as empty):
 *   meta.json                    { scale_context, scope, started_at }
 *   risk-map.json                explorer output (scope + stack)
 *   findings-concurrency.json    specialist output — a JSON array
 *   findings-multi-tenancy.json
 *   findings-resource.json
 *   findings-idempotency.json
 *
 * On success the HTML report path is printed to stdout (and nothing else).
 */

import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';

// --------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir') out.runDir = argv[++i];
    else if (argv[i] === '--report-dir') out.reportDir = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.runDir || !args.reportDir) {
  console.error('Usage: node build-report.mjs --run-dir <dir> --report-dir <dir>');
  process.exit(args.help ? 0 : 1);
}
if (!existsSync(args.runDir)) {
  console.error(`build-report: run dir not found: ${args.runDir}`);
  process.exit(1);
}

const runDir = args.runDir;
const reportDir = args.reportDir;
const runId = basename(runDir);

// ----------------------------------------------------------------- constants
const CONCERNS = ['concurrency', 'multi-tenancy', 'resource', 'idempotency'];
const CONCERN_LABEL = {
  concurrency: 'Concurrency',
  'multi-tenancy': 'Multi-tenancy',
  resource: 'Resource',
  idempotency: 'Idempotency',
};
const TIERS = ['T0', 'T1', 'T2', 'T3'];
const TIER_META = {
  T0: { label: 'Detonating', emoji: '🔴', color: '#dc2626', desc: 'Fails at current load' },
  T1: { label: 'Imminent', emoji: '🟠', color: '#ea580c', desc: 'Breaks within ~10× growth' },
  T2: { label: 'At scale', emoji: '🟡', color: '#ca8a04', desc: 'Breaks at 100×+ scale' },
  T3: { label: 'Latent', emoji: '⚪', color: '#6b7280', desc: 'No realistic near-term trigger' },
};
const TIER_ORDER = { T0: 0, T1: 1, T2: 2, T3: 3 };
const BLAST_ORDER = { 'data-loss': 0, outage: 1, degradation: 2, minor: 3 };
const CONF_ORDER = { high: 0, medium: 1, low: 2 };

// ------------------------------------------------------------------- helpers
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`build-report: WARNING — ${basename(path)} is not valid JSON (${err.message}); treating as empty.`);
    return fallback;
  }
}

function fingerprint(f) {
  return createHash('sha1')
    .update(`${f.concern}|${f.file}|${f.symbol || ''}|${f.pattern_id}`)
    .digest('hex')
    .slice(0, 12);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function moreSevere(a, b) {
  return (TIER_ORDER[a.tier] - TIER_ORDER[b.tier])
    || (BLAST_ORDER[a.blast_radius] - BLAST_ORDER[b.blast_radius])
    || (CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence]) < 0;
}

// --------------------------------------------------------------- load inputs
const meta = readJson(join(runDir, 'meta.json'), {});
const riskMap = readJson(join(runDir, 'risk-map.json'), {});
const scope = meta.scope || riskMap.scope || 'full';
const stack = riskMap.stack || {};
const scaleContext = meta.scale_context || '';

const REQUIRED = ['pattern_id', 'file', 'tier'];
let findings = [];
const concernsRun = [];
const concernsMissing = [];

for (const concern of CONCERNS) {
  const path = join(runDir, `findings-${concern}.json`);
  if (!existsSync(path)) { concernsMissing.push(concern); continue; }
  const raw = readJson(path, null);
  if (!Array.isArray(raw)) {
    console.error(`build-report: WARNING — findings-${concern}.json is not a JSON array; skipping it.`);
    continue;
  }
  concernsRun.push(concern);
  for (const f of raw) {
    const missing = REQUIRED.filter((k) => !f || f[k] == null || f[k] === '');
    if (missing.length) {
      console.error(`build-report: WARNING — dropped a ${concern} finding missing: ${missing.join(', ')}.`);
      continue;
    }
    f.concern = concern; // trust the file, not the agent's self-label
    f.tier = TIERS.includes(f.tier) ? f.tier : 'T3';
    f.blast_radius = BLAST_ORDER[f.blast_radius] != null ? f.blast_radius : 'minor';
    f.confidence = CONF_ORDER[f.confidence] != null ? f.confidence : 'medium';
    f.fingerprint = fingerprint(f);
    findings.push(f);
  }
}
if (concernsMissing.length) {
  console.error(`build-report: note — no findings file for: ${concernsMissing.join(', ')} (concern not run, or hunter produced nothing).`);
}

// dedup exact fingerprint collisions, keeping the most severe
const byFp = new Map();
for (const f of findings) {
  const seen = byFp.get(f.fingerprint);
  if (!seen || moreSevere(f, seen)) byFp.set(f.fingerprint, f);
}
findings = [...byFp.values()].sort((a, b) => (
  (TIER_ORDER[a.tier] - TIER_ORDER[b.tier])
  || (BLAST_ORDER[a.blast_radius] - BLAST_ORDER[b.blast_radius])
  || (CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence])
  || a.concern.localeCompare(b.concern)
));

// ----------------------------------------------------- previous run + delta
function findPreviousRun() {
  const runsRoot = dirname(runDir);
  let entries;
  try { entries = readdirSync(runsRoot); } catch { return null; }
  const candidates = entries
    .filter((name) => name !== runId)
    .filter((name) => {
      try { return statSync(join(runsRoot, name)).isDirectory(); } catch { return false; }
    })
    .filter((name) => existsSync(join(runsRoot, name, 'report.json')))
    .sort();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

let delta = null;
let fixedFindings = [];
const prevRunId = findPreviousRun();
if (prevRunId) {
  const prev = readJson(join(dirname(runDir), prevRunId, 'report.json'), null);
  if (prev && Array.isArray(prev.findings)) {
    const prevFps = new Set(prev.findings.map((f) => f.fingerprint));
    const currFps = new Set(findings.map((f) => f.fingerprint));
    for (const f of findings) f.isNew = !prevFps.has(f.fingerprint);
    fixedFindings = prev.findings.filter((f) => !currFps.has(f.fingerprint));
    delta = {
      previous_run: prevRunId,
      fixed: fixedFindings.length,
      new: findings.filter((f) => f.isNew).length,
      still_open: findings.filter((f) => !f.isNew).length,
    };
  }
}

// ------------------------------------------------------------------ summary
const summary = {
  total: findings.length,
  by_tier: Object.fromEntries(TIERS.map((t) => [t, findings.filter((f) => f.tier === t).length])),
  by_concern: Object.fromEntries(CONCERNS.map((c) => [c, findings.filter((f) => f.concern === c).length])),
  by_confidence: Object.fromEntries(
    ['high', 'medium', 'low'].map((c) => [c, findings.filter((f) => f.confidence === c).length]),
  ),
};

const generatedAt = new Date().toISOString();
const report = {
  run_id: runId,
  generated_at: generatedAt,
  scope,
  stack,
  scale_context: scaleContext,
  concerns_run: concernsRun,
  summary,
  delta,
  findings,
};
writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

// --------------------------------------------------------------- HTML render
function renderFinding(f) {
  const t = TIER_META[f.tier];
  const loc = escapeHtml(f.file)
    + (f.line ? `:${escapeHtml(f.line)}` : '')
    + (f.symbol ? `  ·  ${escapeHtml(f.symbol)}()` : '');
  return `
    <article class="finding" data-tier="${f.tier}" data-concern="${f.concern}"
             data-confidence="${f.confidence}" data-new="${f.isNew ? '1' : '0'}"
             style="--tier:${t.color}">
      <div class="f-bar">
        <span class="badge tier">${t.emoji} ${f.tier} ${t.label}</span>
        <span class="badge concern c-${f.concern}">${CONCERN_LABEL[f.concern]}</span>
        <span class="badge blast">${escapeHtml(f.blast_radius)}</span>
        <span class="badge conf conf-${f.confidence}">${f.confidence} confidence</span>
        ${f.isNew ? '<span class="badge new">NEW</span>' : ''}
        <span class="pattern">${escapeHtml(f.pattern_id)}</span>
      </div>
      <h3 class="f-title">${escapeHtml(f.title || f.pattern_id)}</h3>
      <div class="f-loc">${loc}</div>
      ${f.what_breaks ? `<div class="f-field"><span class="f-label">What breaks</span><p>${escapeHtml(f.what_breaks)}</p></div>` : ''}
      ${f.at_what_scale ? `<div class="f-field"><span class="f-label">At what scale</span><p>${escapeHtml(f.at_what_scale)}</p></div>` : ''}
      ${f.evidence ? `<div class="f-field"><span class="f-label">Evidence</span><pre><code>${escapeHtml(f.evidence)}</code></pre></div>` : ''}
      ${f.suggested_fix ? `<div class="f-field f-fix"><span class="f-label">Suggested fix</span><p>${escapeHtml(f.suggested_fix)}</p></div>` : ''}
    </article>`;
}

function renderHtml() {
  const stackBadges = []
    .concat(Array.isArray(stack.db) ? stack.db : (stack.db ? [stack.db] : []))
    .concat(stack.framework ? [stack.framework] : [])
    .concat(stack.queue ? [stack.queue] : [])
    .concat(stack.cache ? [stack.cache] : [])
    .filter(Boolean)
    .map((s) => `<span class="stack-badge">${escapeHtml(s)}</span>`)
    .join('');

  const tiles = TIERS.map((t) => `
    <div class="tile" style="--c:${TIER_META[t].color}">
      <div class="tile-n">${summary.by_tier[t]}</div>
      <div class="tile-l">${TIER_META[t].emoji} ${t} · ${TIER_META[t].label}</div>
      <div class="tile-d">${TIER_META[t].desc}</div>
    </div>`).join('');

  const tierChips = TIERS.map((t) => `
    <button class="chip" data-tier-toggle="${t}" style="--c:${TIER_META[t].color}">
      ${TIER_META[t].emoji} ${t} <b>${summary.by_tier[t]}</b></button>`).join('');
  const concernChips = CONCERNS.map((c) => `
    <button class="chip c-${c}" data-concern-toggle="${c}">
      ${CONCERN_LABEL[c]} <b>${summary.by_concern[c]}</b></button>`).join('');

  let deltaBanner;
  if (delta) {
    deltaBanner = `<div class="delta">
      <span class="d-item d-fixed">✅ ${delta.fixed} fixed</span>
      <span class="d-item d-new">🆕 ${delta.new} new</span>
      <span class="d-item d-open">⏳ ${delta.still_open} still open</span>
      <span class="d-prev">vs run ${escapeHtml(delta.previous_run)}</span>
    </div>`;
  } else {
    deltaBanner = '<div class="delta first">First run — no previous run to compare against.</div>';
  }

  const fixedSection = (delta && fixedFindings.length) ? `
    <details class="fixed">
      <summary>✅ ${fixedFindings.length} finding(s) fixed since run ${escapeHtml(delta.previous_run)}</summary>
      <ul>${fixedFindings.map((f) => `<li>
        <span class="fx-tier" style="background:${(TIER_META[f.tier] || {}).color || '#888'}">${escapeHtml(f.tier || '?')}</span>
        ${escapeHtml(f.title || f.pattern_id || 'finding')}
        <span class="fx-loc">${escapeHtml(f.file || '')}</span></li>`).join('')}</ul>
    </details>` : '';

  const body = findings.length
    ? findings.map(renderFinding).join('')
    : '<div class="empty">✅ No timebombs found in scope.</div>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>timebomb-hunter — ${escapeHtml(runId)}</title>
<style>
  :root { --bg:#f4f4f5; --card:#fff; --border:#e4e4e7; --ink:#18181b; --muted:#71717a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.55; }
  .wrap { max-width:980px; margin:0 auto; padding:0 20px 64px; }
  code, pre, .mono { font-family:"SF Mono","JetBrains Mono",Menlo,Consolas,monospace; }

  header.page { background:#18181b; color:#fafafa; padding:30px 0 26px; margin-bottom:24px; }
  header.page .wrap { padding-bottom:0; }
  h1 { margin:0; font-size:25px; letter-spacing:-.4px; }
  .run-meta { color:#a1a1aa; font-size:13px; margin-top:6px; }
  .stack { margin-top:12px; display:flex; gap:6px; flex-wrap:wrap; }
  .stack-badge { background:#27272a; color:#d4d4d8; font-size:11px; padding:3px 9px;
    border-radius:20px; }
  .scale { margin-top:12px; font-size:13px; color:#d4d4d8; background:#27272a;
    border-left:3px solid #6b7280; padding:8px 12px; border-radius:4px; }

  .delta { display:flex; gap:18px; align-items:center; flex-wrap:wrap;
    background:var(--card); border:1px solid var(--border); border-radius:10px;
    padding:14px 18px; margin-bottom:20px; font-size:14px; font-weight:600; }
  .delta.first { color:var(--muted); font-weight:500; }
  .d-fixed { color:#16a34a; } .d-new { color:#dc2626; } .d-open { color:#a16207; }
  .d-prev { color:var(--muted); font-weight:500; margin-left:auto; font-size:12px; }

  .tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:24px; }
  .tile { background:var(--card); border:1px solid var(--border);
    border-top:3px solid var(--c); border-radius:10px; padding:14px 16px; }
  .tile-n { font-size:30px; font-weight:700; color:var(--c); line-height:1; }
  .tile-l { font-size:12px; font-weight:600; margin-top:6px; }
  .tile-d { font-size:11px; color:var(--muted); margin-top:2px; }

  .filters { position:sticky; top:0; background:var(--bg); padding:14px 0;
    border-bottom:1px solid var(--border); margin-bottom:18px; z-index:5; }
  .filter-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .filter-row + .filter-row { margin-top:8px; }
  .chip { cursor:pointer; border:1px solid var(--border); background:var(--card);
    border-radius:20px; padding:5px 12px; font-size:12px; font-weight:600; color:var(--ink);
    border-left:3px solid var(--c,#a1a1aa); }
  .chip b { font-weight:700; }
  .chip.off { opacity:.35; }
  .chip.c-concurrency { --c:#dc2626; } .chip.c-multi-tenancy { --c:#9333ea; }
  .chip.c-resource { --c:#ca8a04; } .chip.c-idempotency { --c:#2563eb; }
  .cb { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:5px; cursor:pointer; }
  .count { font-size:12px; color:var(--muted); margin-left:auto; }

  .finding { background:var(--card); border:1px solid var(--border);
    border-left:4px solid var(--tier); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  .f-bar { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .badge { font-size:11px; font-weight:600; padding:2px 8px; border-radius:5px;
    background:#f4f4f5; color:#3f3f46; }
  .badge.tier { background:var(--tier); color:#fff; }
  .badge.new { background:#dc2626; color:#fff; }
  .badge.conf-low { background:#fef9c3; color:#854d0e; }
  .badge.c-concurrency { background:#fee2e2; color:#991b1b; }
  .badge.c-multi-tenancy { background:#f3e8ff; color:#6b21a8; }
  .badge.c-resource { background:#fef3c7; color:#92400e; }
  .badge.c-idempotency { background:#dbeafe; color:#1e40af; }
  .pattern { margin-left:auto; font-size:11px; color:var(--muted); font-family:monospace; }
  .f-title { margin:10px 0 3px; font-size:16px; letter-spacing:-.2px; }
  .f-loc { font-family:monospace; font-size:12.5px; color:var(--muted); margin-bottom:8px; }
  .f-field { margin-top:9px; }
  .f-label { display:block; font-size:11px; font-weight:700; text-transform:uppercase;
    letter-spacing:.5px; color:var(--muted); margin-bottom:2px; }
  .f-field p { margin:0; font-size:13.5px; }
  .f-fix p { background:#f0fdf4; border-left:3px solid #16a34a; padding:7px 10px; border-radius:4px; }
  pre { background:#1e1e2e; color:#e4e4e7; padding:10px 12px; border-radius:6px;
    overflow-x:auto; font-size:12px; margin:0; }

  .empty { background:var(--card); border:1px dashed var(--border); border-radius:10px;
    padding:36px; text-align:center; color:var(--muted); font-size:15px; }
  .hidden { display:none; }

  details.fixed { margin-top:24px; background:var(--card); border:1px solid var(--border);
    border-radius:10px; padding:12px 16px; }
  details.fixed summary { cursor:pointer; font-weight:600; font-size:13px; color:#16a34a; }
  details.fixed ul { margin:10px 0 2px; padding-left:4px; list-style:none; }
  details.fixed li { font-size:13px; padding:4px 0; border-top:1px solid var(--border); }
  .fx-tier { color:#fff; font-size:10px; font-weight:700; padding:1px 6px; border-radius:4px; }
  .fx-loc { font-family:monospace; font-size:11px; color:var(--muted); }

  footer { text-align:center; color:var(--muted); font-size:12px; margin-top:36px; }
  @media print { .filters { position:static; } .finding { break-inside:avoid; } }
  @media (max-width:680px) { .tiles { grid-template-columns:repeat(2,1fr); } }
</style>
</head>
<body>
<header class="page">
  <div class="wrap">
    <h1>🧨 timebomb-hunter report</h1>
    <div class="run-meta">run ${escapeHtml(runId)} · scope <b>${escapeHtml(scope)}</b> · generated ${escapeHtml(generatedAt.slice(0, 16).replace('T', ' '))} UTC · ${summary.total} finding(s)</div>
    ${stackBadges ? `<div class="stack">${stackBadges}</div>` : ''}
    ${scaleContext ? `<div class="scale">Scale context: ${escapeHtml(scaleContext)}</div>` : ''}
  </div>
</header>
<div class="wrap">
  ${deltaBanner}
  <div class="tiles">${tiles}</div>
  <div class="filters">
    <div class="filter-row">${tierChips}</div>
    <div class="filter-row">${concernChips}
      <label class="cb"><input type="checkbox" id="hide-low" checked> Hide low-confidence</label>
      ${delta ? '<label class="cb"><input type="checkbox" id="new-only"> New only</label>' : ''}
      <span class="count"><b id="shown-count">0</b> shown</span>
    </div>
  </div>
  <main>
    ${body}
    <div id="filtered-empty" class="empty hidden">No findings match the current filters.</div>
  </main>
  ${fixedSection}
  <footer>Generated by timebomb-hunter · detonation tiers: T0 now · T1 ~10× · T2 100×+ · T3 latent</footer>
</div>
<script>
(function () {
  var state = {
    tiers: new Set(['T0','T1','T2','T3']),
    concerns: new Set(['concurrency','multi-tenancy','resource','idempotency']),
    hideLow: true,
    newOnly: false
  };
  var cards = Array.prototype.slice.call(document.querySelectorAll('.finding'));
  function apply() {
    var shown = 0;
    cards.forEach(function (el) {
      var ok = state.tiers.has(el.dataset.tier)
        && state.concerns.has(el.dataset.concern)
        && !(state.hideLow && el.dataset.confidence === 'low')
        && !(state.newOnly && el.dataset.new !== '1');
      el.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });
    var c = document.getElementById('shown-count');
    if (c) c.textContent = shown;
    var fe = document.getElementById('filtered-empty');
    if (fe) fe.classList.toggle('hidden', shown !== 0 || cards.length === 0);
  }
  document.querySelectorAll('[data-tier-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.tierToggle;
      if (state.tiers.has(t)) state.tiers.delete(t); else state.tiers.add(t);
      b.classList.toggle('off', !state.tiers.has(t));
      apply();
    });
  });
  document.querySelectorAll('[data-concern-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var cc = b.dataset.concernToggle;
      if (state.concerns.has(cc)) state.concerns.delete(cc); else state.concerns.add(cc);
      b.classList.toggle('off', !state.concerns.has(cc));
      apply();
    });
  });
  var low = document.getElementById('hide-low');
  if (low) low.addEventListener('change', function () { state.hideLow = low.checked; apply(); });
  var nw = document.getElementById('new-only');
  if (nw) nw.addEventListener('change', function () { state.newOnly = nw.checked; apply(); });
  apply();
})();
</script>
</body>
</html>
`;
}

if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
const htmlPath = join(reportDir, `${runId}.html`);
writeFileSync(htmlPath, renderHtml());

// stdout: the report path only — the orchestrator captures this.
console.log(htmlPath);
