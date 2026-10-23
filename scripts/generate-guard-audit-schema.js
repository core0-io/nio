// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from 'node:fs';
import { guardAuditJsonSchema } from '../dist/schemas/index.js';
const path = new URL('../schemas/guard-audit.schema.json', import.meta.url);
const output = `${JSON.stringify(guardAuditJsonSchema(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output)
    throw new Error('Guard audit schema artifact is stale; run pnpm schema:generate');
} else writeFileSync(path, output);
