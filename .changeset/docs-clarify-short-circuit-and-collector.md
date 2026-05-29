---
"@core0-io/nio": patch
---

**Docs: clarify per-phase deny-threshold short-circuit; drop stale collector probe claims.**

The published phase docs described short-circuit as "any CRITICAL
finding → deny", which under-specified the actual rule: any phase
emitting a score ≥ the active level's deny threshold short-circuits
(strict 0.5, balanced 0.8, permissive 0.9), and Phase 6 evaluates
this _per endpoint_ so one external scorer crossing the line denies
even when sibling endpoints would have pulled the weighted average
back under the threshold.

Updates the Phase 2 / 3 / 4 / 5 / 6 reference pages, the pipeline
overview, the scoring page (with a worked Phase 6 per-endpoint
example), the home-page interactive demo, the `ARCHITECTURE.md` ASCII
flow, and the shared SKILL.md. Also fixes a long-standing home-page
bug where short-circuit DENY hardcoded `final = 1.0` instead of the
triggering phase's actual score, which contradicted both the
orchestrator (`Math.max(weighted_avg, triggering_score)`) and the
new scoring examples.

In parallel, the `getting-started`, `configuration`, `install`,
`skill`, `diagnostics`, and shared SKILL.md docs are updated to match
the doctor change above: collector reachability is no longer claimed
as a doctor probe. Adds the previously-missing `id="nio-doctor"`
anchor on `docs/diagnostics.html` so existing cross-references
resolve, and repoints a broken `#oauth` anchor to the real
`#oauth-token_failed` diagnostic row.

Bumps the pinned `NIO_VERSION` example in `README.md` and
`docs/install.html` to the current release tag.
