---
"@core0-io/nio": patch
---

Stop collector diagnostics from flooding the host terminal, and say what
actually failed.

On the in-process platforms (Pi, opencode, OpenClaw) one process serves a
whole session, so a telemetry fault repeated for as long as it lasted: a
live Pi session printed 205 identical `otlp_export_failed` lines in six
minutes and buried the user's work until they turned monitoring off.

- **stderr is now rate limited.** The first occurrence of a distinct
  diagnostic still prints immediately and in full — nothing is silently
  swallowed. Repeats within 60 s are counted instead of printed, and one
  `suppressed N more identical in the last 60s` line reports the count
  when the window closes. A *different* failure is never hidden behind an
  older one. The audit log still receives every occurrence.
- **stderr now prints `detail`.** That field holds the only text naming
  the real fault, and it was never rendered.
- **Failed exports back off.** After 3 consecutive failures a signal's
  exports pause for a doubling delay (1 s → 30 s cap) rather than being
  re-attempted every second by the metric reader and every force-flush.
  The pause and the recovery are each announced once. Per signal, so a
  broken metrics pipeline never pauses traces; the guard is unaffected.
- **The hint no longer blames the endpoint for failures the endpoint did
  not cause.** `Concurrent export limit reached` (61 % of the diagnostics
  in a real audit log) is the exporter refusing to send with a full
  in-flight queue — no request reaches the network at all — and
  `Request timed out` is about `collector.timeout`. Both used to print
  "check endpoint reachability".
- **`AggregateError` is unwrapped.** Node's happy-eyeballs connect
  failures have an empty `message`, so 115 real diagnostics rendered as
  the bare word "AggregateError".
- **Diagnostics can no longer land on a cwd-relative path.** The audit
  path is resolved through `os.homedir()`, matching `common.ts`, so a
  host started without `HOME` writes them to `~/.nio/audit.jsonl` like
  everything else instead of scattering them per directory.
