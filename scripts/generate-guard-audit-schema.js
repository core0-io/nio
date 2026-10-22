import { readFileSync, writeFileSync } from 'node:fs';
import { guardAuditJsonSchema } from '../dist/schemas/index.js';
const path = new URL('../schemas/guard-audit.v2.schema.json', import.meta.url);
const output = `${JSON.stringify(guardAuditJsonSchema(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output)
    throw new Error('Guard audit schema artifact is stale; run pnpm schema:generate');
} else writeFileSync(path, output);
