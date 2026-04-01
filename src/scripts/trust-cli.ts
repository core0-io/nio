#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard Trust CLI — lightweight wrapper for SkillRegistry operations.
 *
 * Usage:
 *   node trust-cli.js lookup --id <id> --source <source> --version <version> --hash <hash>
 *   node trust-cli.js attest  --id <id> --source <source> --version <version> --hash <hash> --trust-level <level> [--preset <preset>] [--capabilities <json>] [--reviewed-by <name>] [--notes <text>] [--expires <iso>] [--force]
 *   node trust-cli.js revoke  [--source <source>] [--key <record_key>] --reason <reason>
 *   node trust-cli.js list    [--trust-level <level>] [--status <status>] [--source-pattern <pattern>]
 *   node trust-cli.js hash    --path <dir>
 */

import { join } from 'node:path';

const agentguardPath = join(import.meta.url.replace('file://', ''), '..', '..', '..', '..', 'dist', 'index.js');

interface AgentGuardModule {
  createAgentGuard: (options?: { registryPath?: string }) => {
    scanner: unknown;
    registry: {
      lookup: (skill: SkillIdentity) => Promise<unknown>;
      attest: (params: AttestParams) => Promise<unknown>;
      forceAttest: (params: AttestParams) => Promise<unknown>;
      revoke: (filter: { source?: string; record_key?: string }, reason: string) => Promise<unknown>;
      list: (filters: Record<string, string>) => Promise<unknown>;
    };
    actionScanner: unknown;
  };
  CAPABILITY_PRESETS: Record<string, unknown>;
  SkillScanner: new (options: { useExternalScanner: boolean }) => {
    calculateArtifactHash: (path: string) => Promise<string>;
  };
}

interface SkillIdentity {
  id: string;
  source: string;
  version_ref: string;
  artifact_hash: string;
}

interface AttestParams {
  skill: SkillIdentity;
  trust_level: 'untrusted' | 'restricted' | 'trusted';
  capabilities?: unknown;
  review: { reviewed_by: string; reviewed_at: string; notes: string };
  expires_at?: string;
}

let mod: AgentGuardModule;
try {
  mod = await import(agentguardPath) as AgentGuardModule;
} catch {
  try {
    mod = // @ts-expect-error fallback to npm package if relative import fails
    await import('@core0-io/ffwd-agent-guard') as AgentGuardModule;
  } catch {
    process.stderr.write('FFWD AgentGuard: unable to load engine\n');
    process.exit(1);
  }
}

const { createAgentGuard, CAPABILITY_PRESETS, SkillScanner } = mod!;

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<void> {
  const registryPath = getArg('registry-path');
  const { registry } = createAgentGuard({ registryPath });

  switch (command) {
    case 'lookup': {
      const skill: SkillIdentity = {
        id: getArg('id') || '',
        source: getArg('source') || '',
        version_ref: getArg('version') || '',
        artifact_hash: getArg('hash') || '',
      };
      const record = await registry.lookup(skill);
      console.log(JSON.stringify(record, null, 2));
      break;
    }

    case 'attest': {
      const skill: SkillIdentity = {
        id: getArg('id') || '',
        source: getArg('source') || '',
        version_ref: getArg('version') || '',
        artifact_hash: getArg('hash') || '',
      };
      const trustLevel = (getArg('trust-level') || 'restricted') as
        | 'untrusted'
        | 'restricted'
        | 'trusted';

      let capabilities: unknown;
      const preset = getArg('preset');
      if (preset && preset in CAPABILITY_PRESETS) {
        capabilities =
          CAPABILITY_PRESETS[preset as keyof typeof CAPABILITY_PRESETS];
      } else if (getArg('capabilities')) {
        capabilities = JSON.parse(getArg('capabilities')!);
      }

      const force = hasFlag('force');
      const attestFn = force ? registry.forceAttest : registry.attest;
      const result = await attestFn.call(registry, {
        skill,
        trust_level: trustLevel,
        capabilities,
        review: {
          reviewed_by: getArg('reviewed-by') || 'cli',
          reviewed_at: new Date().toISOString(),
          notes: getArg('notes') || '',
        },
        expires_at: getArg('expires'),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'revoke': {
      const source = getArg('source');
      const key = getArg('key');
      const reason = getArg('reason') || 'Revoked via CLI';
      const result = await registry.revoke(
        { source, record_key: key },
        reason
      );
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'list': {
      const filters: Record<string, string> = {};
      const trustLevel = getArg('trust-level');
      const status = getArg('status');
      const sourcePattern = getArg('source-pattern');
      if (trustLevel) filters.trust_level = trustLevel;
      if (status) filters.status = status;
      if (sourcePattern) filters.source_pattern = sourcePattern;

      const records = await registry.list(filters);
      console.log(JSON.stringify(records, null, 2));
      break;
    }

    case 'hash': {
      const dirPath = getArg('path');
      if (!dirPath) {
        console.error('Error: --path is required for hash');
        process.exit(1);
      }
      const scanner = new SkillScanner({ useExternalScanner: false });
      const hash = await scanner.calculateArtifactHash(dirPath);
      console.log(JSON.stringify({ hash }));
      break;
    }

    default:
      console.error(
        'Usage: trust-cli.js <lookup|attest|revoke|list|hash> [options]'
      );
      console.error('Run with --help for details.');
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
