<!--
  Thanks for contributing! A few things to make review smooth:

  - Keep the title in Conventional Commits form (feat: / fix: / chore: / …).
  - Link the issue this PR addresses with "Closes #123" below.
  - For anything user-visible, add a changeset (`pnpm version-select`).
  - Security-relevant bugs should go through private disclosure, not PRs.
    See SECURITY.md.
-->

## Summary

<!-- One or two sentences: what does this PR change, and why? -->

## Related issue

Closes #

## Type of change

- [ ] `feat` — user-visible new functionality
- [ ] `fix` — bug fix (detection / guard / build)
- [ ] `refactor` — internal, no behaviour change
- [ ] `perf` — performance improvement
- [ ] `docs` — documentation only
- [ ] `chore` — tooling / release / deps
- [ ] `test` — test-only

## Checklist

- [ ] `pnpm tsc --noEmit` passes (zero TS errors)
- [ ] `pnpm test` passes (all existing tests + any new ones)
- [ ] `pnpm run build` completes cleanly
- [ ] New/changed detection rules have a positive **and** a negative test fixture
- [ ] Added a changeset via `pnpm version-select` (skip only if the change has no user-visible effect)
- [ ] Updated relevant docs (`README.md`, `docs/`, `plugins/shared/skill/SKILL.md`) if behaviour or API changed
- [ ] If borrowing third-party code, updated `NOTICE` and `LICENSES/`

## Notes for reviewers

<!--
  Anything worth calling out:
  - design trade-offs you made
  - parts that are intentionally non-atomic
  - follow-ups you are deliberately deferring
  - manual smoke steps you ran (host commands, test-fixture output)
-->
