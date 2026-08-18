---
"@core0-io/nio": patch
---

Fix twelve defects found by running the collector against a live backend.

**Telemetry that was silently lost.** Both the traces and the logs signal
exported one item at a time, which blew through the OTLP exporter's
30-concurrent-export cap on any turn that produced more than 30 spans or
content records; the overflow was rejected with no retry and no requeue,
and because the turn root is emitted last it was always among the
casualties — leaving traces whose every span named a parent the backend
never received. Both signals now batch, so a turn is one request.

**Guard decisions that never reached the host.** A `deny` could be lost
four ways, all of which are now closed: a non-string field anywhere in an
unvalidated hook payload threw and killed the process carrying the
decision (hosts read a dead hook as "no action"); an engine failure
returned a blanket `allow`, and now denies by the action's blast radius —
`read_file` fails open with a diagnostic, everything else fails closed; a
telemetry flush against an unreachable collector could block a hook past
the host's own timeout, and every OTLP-touching await now shares one
5-second budget; and the Hermes hook could fail to deliver its answer at
all — with a configured-but-unreachable endpoint it never exited, because
the metrics reader's retry timer outlives `forceFlush()`, and a large deny
written to a slow consumer was truncated into invalid JSON, which Hermes
reads as no-action. It now writes in chunks and exits once both stdio
streams have drained.

**Correctness.** `nio.turn.user_prompt` was empty on Claude Code, whose
hook payload carries a prompt id rather than the text — it is now read
from the transcript, filtered to real user messages. `severityText`
carried the nio risk level, which is not a name the OTel logs data model
defines, so records fell out of severity-driven views; it now carries the
standard OTel name and the risk level travels as `nio.risk_level`.

**Operational.** Metric flushes are coalesced so nio stops filling its own
exporter queue against a healthy endpoint, and the collector no longer
flushes metrics mid-dispatch. Repeated stderr diagnostics collapse to one
line plus a "suppressed N" summary (the audit log still records every
occurrence), the `detail` field — the only one naming the actual fault —
is finally printed, and the hint beside it is no longer an unconditional
"check endpoint reachability": the largest class of live export failures
is nio's own exporter refusing to send with its in-flight queue full,
where the endpoint was never contacted. Diagnostics also no longer scatter
into cwd-relative directories when `HOME` is unset.

**Docs.** The site pages never mentioned the capture switch, so a reader
concluded that configuring an endpoint starts collection. Capture gating
is now documented on every page it affects, with a `/nio-monitor` page of
its own.
