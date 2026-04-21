#!/usr/bin/env node

export {};

/**
 * Nio Action CLI — lightweight wrapper for RuntimeAnalyser.
 *
 * Usage:
 *   node action-cli.js evaluate --type <action_type> [action-specific args]
 *
 * Action-specific args for `evaluate`:
 *
 *   exec_command:
 *     --command <cmd> [--args <json_array>] [--cwd <dir>]
 *
 *   network_request:
 *     --method <GET|POST|PUT|DELETE|PATCH> --url <url> [--body <text>] [--user-present]
 *
 *   secret_access:
 *     --secret-name <name> --access-type <read|write>
 *
 *   read_file / write_file:
 *     --path <filepath>
 */

import { createNio } from '../index.js';

type ActionType = 'network_request' | 'exec_command' | 'read_file' | 'write_file' | 'secret_access';

interface ActionEnvelope {
  actor: {
    skill: {
      id: string;
      source: string;
      version_ref: string;
      artifact_hash: string;
    };
  };
  action: {
    type: ActionType;
    data: Record<string, unknown>;
  };
  context: {
    session_id: string;
    user_present: boolean;
    env: string;
    time: string;
  };
}

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

function printUsage(): never {
  console.error(`Usage: action-cli.js evaluate [options]

Commands:
  evaluate  Evaluate an action through the 6-phase guard pipeline

evaluate options:
  --type <type>        Action type: exec_command, network_request,
                       secret_access, read_file, write_file

  For exec_command:
    --command <cmd>    Command string (required)
    --args <json>      Arguments as JSON array (optional)
    --cwd <dir>        Working directory (optional)

  For network_request:
    --method <method>  HTTP method (required)
    --url <url>        Request URL (required)
    --body <text>      Request body preview (optional)
    --user-present     User is actively watching (optional flag)

  For secret_access:
    --secret-name <n>  Secret name (required)
    --access-type <t>  read or write (required)

  For read_file / write_file:
    --path <filepath>  File path (required)`);
  process.exit(1);
}

function buildEnvelope(): ActionEnvelope {
  const type = getArg('type') as ActionType;
  if (!type) {
    console.error('Error: --type is required for evaluate');
    printUsage();
  }

  const userPresent = hasFlag('user-present');
  let data: Record<string, unknown>;

  switch (type) {
    case 'exec_command':
      data = {
        command: getArg('command') || '',
        args: getArg('args') ? JSON.parse(getArg('args')!) : undefined,
        cwd: getArg('cwd'),
      };
      break;

    case 'network_request':
      data = {
        method: (getArg('method') || 'GET').toUpperCase(),
        url: getArg('url') || '',
        body_preview: getArg('body'),
      };
      break;

    case 'secret_access':
      data = {
        secret_name: getArg('secret-name') || '',
        access_type: getArg('access-type') || 'read',
      };
      break;

    case 'read_file':
    case 'write_file':
      data = {
        path: getArg('path') || '',
      };
      break;

    default:
      console.error(`Error: unknown action type '${type}'`);
      printUsage();
  }

  return {
    actor: {
      skill: {
        id: getArg('skill-id') || 'unknown',
        source: getArg('skill-source') || 'cli',
        version_ref: getArg('skill-version') || '0.0.0',
        artifact_hash: getArg('skill-hash') || '',
      },
    },
    action: {
      type,
      data,
    },
    context: {
      session_id: `cli-${Date.now()}`,
      user_present: userPresent,
      env: 'prod',
      time: new Date().toISOString(),
    },
  };
}

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    printUsage();
  }

  const { runtimeAnalyser } = createNio({});

  // Support both "evaluate" and legacy "decide" command
  if (command !== 'evaluate' && command !== 'decide') {
    console.error(`Unknown command: ${command}`);
    printUsage();
  }

  const envelope = buildEnvelope();
  const result = await runtimeAnalyser.evaluate(envelope);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: Error) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
