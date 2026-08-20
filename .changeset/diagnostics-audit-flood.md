---
"@core0-io/nio": patch
---

**A collector that can't reach its endpoint no longer erases the audit
log it writes to.** If you have ever run nio against an OTLP endpoint
that was down — a local collector you hadn't started, a container between
restarts — this is the change that matters most to you.

Measured on a live machine: `~/.nio/audit.jsonl` at 13.9 MB holding
34 689 `otlp_export_failed` entries, 97 % of the file, against roughly
1 500 real agent events. The previous 100 MB generation had already been
filled the same way and rotated over. Across 23 hours those 34 689 lines
carried exactly six distinct `(component, detail)` pairs — the same
handful of faults, restated every second by the metric reader's retries
and by each event's force-flush.

Two defects combined to produce that.

The audit leg of `reportDiagnostic()` never deduplicated. That was a
deliberate choice — the audit log is the forensic record — but rotation
keeps exactly ONE generation (`audit.jsonl` is renamed over
`audit.jsonl.1`), so a flood does not merely bloat the file, it evicts the
guard decisions and lifecycle records the log exists to hold, permanently.
Preserving the diagnostic *count* was costing the agent *record*. Repeats
are now collapsed on the audit leg in lockstep with stderr, and the count
survives in the closing summary rather than in the line count: the first
occurrence is written in full, repeats inside the 60 s window are counted,
and when the window closes one summary entry carries `suppressed_count`
and `window_started_at`. Replaying the flood above now produces **12 lines
and 4.4 KB with all 34 689 occurrences still accounted for**.

If you aggregate `~/.nio/audit.jsonl` yourself, this is the one thing to
change: count occurrences as `suppressed_count ?? 1` per entry rather than
counting lines. A summary entry stands for the repeats it collapsed and
not for itself. The `nio-report` skill has been updated to count this way;
`/nio doctor` never read the audit log and is unaffected.

Second, that leg never rotated at all. `writeAuditLog()` calls
`rotateIfNeeded()` before every append; `reportDiagnostic()` had its own
`appendFileSync` and no size check, so `collector.logs.max_size_mb` only
ever constrained real agent events — a host emitting nothing but
diagnostics grew the file unbounded until the next real event happened to
look. Both writers now share one rotation implementation
(`adapters/audit-rotate.ts`) and one ceiling: `writeAuditLog()` publishes
the configured `max_size_mb` to the diagnostics leg as it loads it. This
matters more than it sounds — both writers rotate the same path, so a leg
rotating at a hardcoded 10 MB while you configured 100 MB would have
silently discarded ten times more history than before.

Neither leg goes quiet. The first occurrence of any distinct fault still
reaches the terminal and the log immediately, and a fault whose `detail`
changes is new information that never waits behind an older fault's
window.
