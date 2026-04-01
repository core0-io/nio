#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const outDir = 'skills/ffwd-agent-guard/scripts';
const srcDir = 'src/scripts';

for (const file of readdirSync(outDir)) {
  if (!file.endsWith('.js')) continue;

  const tsName = file.replace(/\.js$/, '.ts');
  const filePath = join(outDir, file);
  const content = readFileSync(filePath, 'utf-8');

  if (content.includes('AUTO-GENERATED')) continue;

  const banner = [
    `// ⚠️  AUTO-GENERATED — DO NOT EDIT`,
    `// Source: ${srcDir}/${tsName}`,
    `// Compile: npm run build`,
    '',
  ].join('\n');

  let patched;
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n');
    patched = content.slice(0, nl + 1) + banner + content.slice(nl + 1);
  } else {
    patched = banner + content;
  }

  writeFileSync(filePath, patched);
}
