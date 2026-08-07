#!/usr/bin/env bash
# Export nio telemetry split by agent+model, then merge the splits back into
# one full set.
#
#   ./export-by-model.sh                 # into ./nio-export-by-model/
#   ./export-by-model.sh -o ~/data
#
# Model lives only on chat spans (`gen_ai.request.model`); turn roots and tool
# spans carry none. So a trace is assigned to whichever model its chat spans
# report, and every span in that trace follows it. Log records follow their
# span via nio.span_id.
#
# Run from the otel-test directory — ClickHouse publishes no ports here.
set -euo pipefail

OUT="./nio-export-by-model"
# Models to leave out entirely. Defaults to gpt-5.5: two chat spans from a
# stray Hermes turn, not part of the measured run.
SKIP_MODELS="${SKIP_MODELS:-gpt-5.5}"
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out)  OUT="${2:-}"; shift 2 ;;
    --skip)    SKIP_MODELS="${2:-}"; shift 2 ;;
    --no-skip) SKIP_MODELS=""; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$OUT"
ch() { docker compose exec -T clickhouse clickhouse-client -q "$1"; }

RAW="$OUT/.raw"
mkdir -p "$RAW"

echo "Pulling from ClickHouse…"
ch "
SELECT traceID, spanID, parentSpanID, name, serviceName,
       timestamp, durationNano, statusCode,
       attributes_string, attributes_number, attributes_bool, resources_string
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName LIKE 'nio-%'
ORDER BY timestamp
FORMAT JSONEachRow" > "$RAW/traces.jsonl"

ch "
SELECT timestamp, body, severity_text, severity_number,
       attributes_string, attributes_number, resources_string
FROM signoz_logs.distributed_logs_v2
WHERE resources_string['service.name'] LIKE 'nio-%'
ORDER BY timestamp
FORMAT JSONEachRow" > "$RAW/logs.jsonl"

node - "$RAW/traces.jsonl" "$RAW/logs.jsonl" "$OUT" "$SKIP_MODELS" <<'JS'
const fs = require('fs'), path = require('path');
const [tracePath, logPath, outDir, skipRaw] = process.argv.slice(2);
const skip = new Set((skipRaw || '').split(',').map(s => s.trim()).filter(Boolean));
const read = p => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

const spans = read(tracePath);
const logs = read(logPath);

// A trace's model comes from its chat spans. Tool spans and turn roots carry
// none, so without this step they would all land in an "unknown" bucket.
const traceModel = new Map();
for (const s of spans) {
  const m = (s.attributes_string || {})['gen_ai.request.model'];
  if (!m) continue;
  const seen = traceModel.get(s.traceID);
  // A trace with more than one model is possible in principle (a session that
  // switched models mid-turn). Record the first and count the rest rather than
  // silently picking one.
  if (!seen) traceModel.set(s.traceID, { model: m, conflicts: new Set() });
  else if (seen.model !== m) seen.conflicts.add(m);
}

const key = s => {
  const platform = (s.serviceName || 'unknown').replace(/^nio-/, '');
  const t = traceModel.get(s.traceID);
  return `${platform}+${t ? t.model : 'no-model'}`;
};

// Group spans, then pull each group's log records in by span id.
const spansByGroup = new Map();
const spanToGroup = new Map();
let skippedSpans = 0;
const skippedTraces = new Set();
for (const s of spans) {
  const t = traceModel.get(s.traceID);
  if (t && skip.has(t.model)) { skippedSpans++; skippedTraces.add(s.traceID); continue; }
  const k = key(s);
  if (!spansByGroup.has(k)) spansByGroup.set(k, []);
  spansByGroup.get(k).push(s);
  spanToGroup.set(s.spanID, k);
}
if (skippedSpans) {
  console.log(`\nSkipped ${skippedSpans} span(s) across ${skippedTraces.size} trace(s) ` +
              `for model(s): ${[...skip].join(', ')}`);
}

const logsByGroup = new Map();
let orphanLogs = 0, auditLogs = 0;
for (const l of logs) {
  const a = l.attributes_string || {};
  if (!a['nio.content.type']) { auditLogs++; continue; }
  const k = spanToGroup.get(a['nio.span_id']);
  if (!k) { orphanLogs++; continue; }
  if (!logsByGroup.has(k)) logsByGroup.set(k, []);
  logsByGroup.get(k).push(l);
}

const write = (file, rows) =>
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

// One span per line with its content records inlined, so a reader never has to
// join two files by hand. Content stays on the logs signal in the backend
// because tool results reach 32 KB; this is the reading view, not the wire.
function combine(spanRows, logRows) {
  const bySpan = new Map();
  for (const l of logRows) {
    const a = l.attributes_string || {}, n = l.attributes_number || {};
    const sid = a['nio.span_id'];
    if (!sid) continue;
    const rec = { type: a['nio.content.type'], body: l.body || '' };
    if (a['nio.content.fidelity']) rec.fidelity = a['nio.content.fidelity'];
    if (a['gen_ai.tool.call.id']) rec.tool_call_id = a['gen_ai.tool.call.id'];
    if (n['nio.content.index'] !== undefined) rec.index = n['nio.content.index'];
    if (n['nio.content.original_bytes'] !== undefined) {
      rec.truncated = true;
      rec.original_bytes = n['nio.content.original_bytes'];
    }
    if (!bySpan.has(sid)) bySpan.set(sid, []);
    bySpan.get(sid).push(rec);
  }
  return spanRows.map(s => ({
    ...(s.nio_group ? { nio_group: s.nio_group } : {}),
    trace_id: s.traceID,
    span_id: s.spanID,
    parent_span_id: s.parentSpanID || null,
    name: s.name,
    service: s.serviceName,
    start: new Date(Date.parse(s.timestamp)).toISOString(),
    duration_ms: Math.round((s.durationNano || 0) / 1e6),
    attributes: {
      ...(s.attributes_string || {}),
      ...(s.attributes_number || {}),
      ...(s.attributes_bool || {}),
    },
    content: (bySpan.get(s.spanID) || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
  }));
}

// Each bucket gets its own directory holding traces / logs / combined, so a
// bucket can be handed over on its own without the caller reassembling paths.
function emit(dir, spanRows, logRows) {
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'traces.jsonl'), spanRows);
  write(path.join(dir, 'logs.jsonl'), logRows);
  write(path.join(dir, 'combined.jsonl'), combine(spanRows, logRows));
}

const groups = [...spansByGroup.keys()].sort();
console.log('\nPer agent+model:');
for (const g of groups) {
  const gs = spansByGroup.get(g), gl = logsByGroup.get(g) || [];
  emit(path.join(outDir, g), gs, gl);
  const thinking = gl.filter(l => l.attributes_string['nio.content.type'] === 'thinking');
  const chars = thinking.reduce((n, l) => n + (l.body || '').length, 0);
  console.log(`  ${g.padEnd(28)} ${String(gs.length).padStart(5)} spans  ${String(gl.length).padStart(5)} content  ` +
              `${String(thinking.length).padStart(4)} thinking (${chars} chars)`);
}

// The full set is the concatenation of the buckets — not a re-query — so it
// cannot disagree with them. Rows carry the bucket they came from.
const fullSpans = [], fullLogs = [];
for (const g of groups) {
  for (const s of spansByGroup.get(g)) fullSpans.push({ nio_group: g, ...s });
  for (const l of (logsByGroup.get(g) || [])) fullLogs.push({ nio_group: g, ...l });
}
emit(path.join(outDir, 'full'), fullSpans, fullLogs);

console.log('\nfull/  (concatenation of the above,每行带 nio_group)');
console.log(`  ${fullSpans.length} spans  ${fullLogs.length} content records`);

const conflicted = [...traceModel.entries()].filter(([, v]) => v.conflicts.size);
if (conflicted.length) {
  console.log(`\n  ${conflicted.length} trace(s) reported more than one model; assigned to the first seen:`);
  for (const [t, v] of conflicted)
    console.log(`    ${t.slice(0, 8)}  ${v.model}  (also: ${[...v.conflicts].join(', ')})`);
}
console.log(`\n  ${auditLogs} audit/lifecycle rows excluded (they belong to no span).`);
if (orphanLogs) console.log(`  ${orphanLogs} content record(s) name a span that never reached the backend.`);
JS

rm -rf "$RAW"

echo
echo "Layout:"
for d in "$OUT"/*/; do
  [ -d "$d" ] || continue
  printf "  %s\n" "$(basename "$d")/"
  for f in traces logs combined; do
    [ -f "$d$f.jsonl" ] || continue
    printf "    %-16s %7s lines  %6s\n" "$f.jsonl" \
      "$(wc -l < "$d$f.jsonl" | tr -d ' ')" "$(du -h "$d$f.jsonl" | cut -f1)"
  done
done
