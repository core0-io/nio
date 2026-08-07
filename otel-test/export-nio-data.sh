#!/usr/bin/env bash
# Export nio's traces and logs out of SigNoz's ClickHouse into JSONL files.
#
#   ./export-nio-data.sh                        # everything, into ./nio-export/
#   ./export-nio-data.sh -o ~/data              # choose the output directory
#   ./export-nio-data.sh -p nio-pi              # only one platform
#   ./export-nio-data.sh -s "now() - INTERVAL 2 HOUR"   # only recent data
#
# ClickHouse's ports are not published by docker-compose, so everything goes
# through `docker compose exec`. Run this from the otel-test directory.
set -euo pipefail

OUT="./nio-export"
PLATFORM=""
SINCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out)      OUT="${2:-}"; shift 2 ;;
    -p|--platform) PLATFORM="${2:-}"; shift 2 ;;
    -s|--since)    SINCE="${2:-}"; shift 2 ;;
    -h|--help)     sed -n '2,12p' "$0"; exit 0 ;;
    *)             echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

# Service names are nio-<platform>: nio-claude-code, nio-pi, nio-codex, …
TRACE_WHERE="serviceName LIKE 'nio-%'"
LOG_WHERE="resources_string['service.name'] LIKE 'nio-%'"
if [ -n "$PLATFORM" ]; then
  TRACE_WHERE="serviceName = '$PLATFORM'"
  LOG_WHERE="resources_string['service.name'] = '$PLATFORM'"
fi
if [ -n "$SINCE" ]; then
  TRACE_WHERE="$TRACE_WHERE AND timestamp > $SINCE"
  # logs store timestamp as nanosecond UInt64, not DateTime
  LOG_WHERE="$LOG_WHERE AND toDateTime(intDiv(timestamp,1000000000)) > $SINCE"
fi

mkdir -p "$OUT"
ch() { docker compose exec -T clickhouse clickhouse-client -q "$1"; }

echo "Exporting traces…"
ch "
SELECT traceID, spanID, parentSpanID, name, serviceName,
       timestamp, durationNano, statusCode,
       attributes_string, attributes_number, attributes_bool,
       resources_string
FROM signoz_traces.distributed_signoz_index_v3
WHERE $TRACE_WHERE
ORDER BY timestamp
FORMAT JSONEachRow" > "$OUT/traces.jsonl"

echo "Exporting logs…"
ch "
SELECT timestamp, body, severity_text, severity_number,
       attributes_string, attributes_number,
       resources_string
FROM signoz_logs.distributed_logs_v2
WHERE $LOG_WHERE
ORDER BY timestamp
FORMAT JSONEachRow" > "$OUT/logs.jsonl"

echo
echo "Wrote:"
for f in traces logs; do
  printf "  %-14s %8s lines  %6s\n" "$f.jsonl" \
    "$(wc -l < "$OUT/$f.jsonl" | tr -d ' ')" \
    "$(du -h "$OUT/$f.jsonl" | cut -f1)"
done

echo
echo "Content records in logs.jsonl, by type:"
node -e '
const fs=require("fs");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const by={};
for (const r of rows) {
  const t=(r.attributes_string||{})["nio.content.type"]||"(audit/lifecycle)";
  by[t]=by[t]||{n:0,bytes:0};
  by[t].n++; by[t].bytes+=(r.body||"").length;
}
for (const [t,v] of Object.entries(by).sort((a,b)=>b[1].bytes-a[1].bytes))
  console.log("  "+t.padEnd(20)+String(v.n).padStart(5)+" records"+String(v.bytes).padStart(10)+" chars");
' "$OUT/logs.jsonl" 2>/dev/null || echo "  (node unavailable — skipped)"

echo
echo "Combining…"
node -e '
const fs=require("fs");
const [tracePath, logPath, outPath] = process.argv.slice(1);
const read = p => fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

const spans = read(tracePath);
const logs  = read(logPath);

// Content records reach the backend as their own log records carrying the
// span id as a plain string attribute — the trace itself only holds counts.
// Group them by span so each span can be emitted self-contained.
const bySpan = new Map();
let orphans = 0, audit = 0;
for (const l of logs) {
  const a = l.attributes_string || {};
  const type = a["nio.content.type"];
  if (!type) { audit++; continue; }          // audit / lifecycle rows, not content
  const sid = a["nio.span_id"];
  if (!sid) { orphans++; continue; }
  const rec = { type, body: l.body || "" };
  if (a["nio.content.fidelity"]) rec.fidelity = a["nio.content.fidelity"];
  if (a["gen_ai.tool.call.id"])  rec.tool_call_id = a["gen_ai.tool.call.id"];
  const n = l.attributes_number || {};
  if (n["nio.content.index"] !== undefined) rec.index = n["nio.content.index"];
  if (n["nio.content.original_bytes"] !== undefined) {
    rec.truncated = true;
    rec.original_bytes = n["nio.content.original_bytes"];
  }
  if (!bySpan.has(sid)) bySpan.set(sid, []);
  bySpan.get(sid).push(rec);
}

const known = new Set(spans.map(s => s.spanID));
let attached = 0, unmatched = 0;
for (const [sid, recs] of bySpan) {
  if (known.has(sid)) attached += recs.length; else unmatched += recs.length;
}

const out = fs.createWriteStream(outPath);
for (const s of spans) {
  const content = (bySpan.get(s.spanID) || [])
    .sort((a,b) => (a.index ?? 0) - (b.index ?? 0));
  out.write(JSON.stringify({
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
    content,
  }) + "\n");
}
out.end();

console.log("  spans:", spans.length,
            " with content:", [...bySpan.keys()].filter(k=>known.has(k)).length);
console.log("  content records attached:", attached,
            " unmatched span id:", unmatched,
            " missing span id:", orphans);
console.log("  audit/lifecycle rows skipped:", audit, "(they belong to no span)");
' "$OUT/traces.jsonl" "$OUT/logs.jsonl" "$OUT/combined.jsonl"

printf "  %-14s %8s lines  %6s\n" "combined.jsonl" \
  "$(wc -l < "$OUT/combined.jsonl" | tr -d ' ')" \
  "$(du -h "$OUT/combined.jsonl" | cut -f1)"

cat <<'NOTE'

combined.jsonl
  One line per span, with its content records inlined under "content".
  Each content entry is {type, body, …} where type is thinking / text /
  tool_input / tool_output.

  Every thinking block with its model:
    jq -r 'select(.content[]?.type=="thinking")
           | .attributes["gen_ai.request.model"] as $m
           | .content[] | select(.type=="thinking")
           | [$m, .fidelity // "-", .body] | @tsv' combined.jsonl

  One turn as a readable trace (chat calls and tool calls in order):
    jq -r 'select(.trace_id=="<TRACE_ID>")
           | [.start, .name, (.content|map(.type)|join(","))] | @tsv' combined.jsonl

  Audit and lifecycle rows are NOT in combined.jsonl — they describe hook
  events rather than a span, and stay in logs.jsonl.

  Content is redacted for secrets and truncated to the per-kind cap before
  export, so it is not byte-identical to what the model produced.
NOTE
