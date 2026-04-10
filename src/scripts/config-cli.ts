#!/usr/bin/env node

export {};

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const agentguardPath = join(dirname(__filename), '..', '..', '..', '..', '..', 'dist', 'index.js');

interface AgentGuardModule {
  loadConfig: () => Record<string, unknown>;
  resetConfig: () => Record<string, unknown>;
}

const subcommand = process.argv[2];

async function main(): Promise<void> {
  let mod: AgentGuardModule;
  try {
    mod = await import(agentguardPath) as AgentGuardModule;
  } catch {
    console.error('Failed to load @core0-io/ffwd-agent-guard');
    process.exit(1);
  }

  switch (subcommand) {
    case 'show': {
      const config = mod.loadConfig();
      console.log(JSON.stringify(config, null, 2));
      break;
    }
    case 'reset': {
      const config = mod.resetConfig();
      console.log('Config reset to defaults:');
      console.log(JSON.stringify(config, null, 2));
      break;
    }
    default:
      console.error('Usage: config-cli.js <show|reset>');
      process.exit(1);
  }
}

main();
