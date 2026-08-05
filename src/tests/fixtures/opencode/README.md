# opencode fixtures

Merged `input` + `output` payloads for the `tool.execute.before` and
`tool.execute.after` hooks, whose signatures are defined in
`sst/opencode` → `packages/plugin/src/index.ts` (the `Hooks` interface).
The binding layer merges the two hook arguments into one object before
handing it to `OpenCodeAdapter.parseInput`.

opencode's write/edit tools use `filePath` (camelCase), unlike Claude
Code's `file_path`.
