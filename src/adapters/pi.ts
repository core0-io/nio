// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type {
  ActionEnvelope, ActionData, ActionType,
  ExecCommandData, FileOperationData, NetworkRequestData,
} from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';
import { editTargets, targetFields } from './edit-targets.js';

/**
 * Default native-tool → action-type mapping for Pi.
 *
 * Pi core ships exactly seven built-in tools — bash, read, write, edit,
 * ls, find, grep (see packages/coding-agent/src/core/tools/*.ts) — and
 * has NO network tool. Network access happens through `bash` and is
 * covered by the Phase 1-6 command analysis. `ls` / `find` / `grep` are
 * deliberately unmapped: they are directory metadata reads, not file
 * content reads, and mapping them would flood the audit log without
 * adding signal.
 *
 * The last three entries are tools that OMP-based hosts add: `eval` runs a
 * Python/JS cell, `bash_background` starts a shell command, `web_search`
 * sends a query out. Plain pi never emits these names.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, ActionType> = {
  bash: 'exec_command',
  write: 'write_file',
  edit: 'write_file',
  read: 'read_file',
  eval: 'exec_command',
  bash_background: 'exec_command',
  web_search: 'network_request',
};

const EVAL_INTERPRETERS: Record<string, string> = { py: 'python3 -c', js: 'node -e' };

/**
 * An `eval` cell (`{ language, code }`) as the equivalent interpreter
 * invocation, double-quoted so `extractInlineCode` recovers `code` verbatim
 * for the Phase 3/4 analysers.
 */
function evalCellAsCommand(toolInput: Record<string, unknown>): string | undefined {
  const interpreter = EVAL_INTERPRETERS[toolInput.language as string];
  const code = toolInput.code;
  if (!interpreter || typeof code !== 'string' || !code) return undefined;
  return `${interpreter} "${code.replace(/["\\$`]/g, '\\$&')}"`;
}

/** OMP's patch-mode edit entries: `{ op?, rename?, diff? }`. */
function patchEditEntries(toolInput: Record<string, unknown>): Array<{ rename?: unknown; diff?: unknown }> {
  return Array.isArray(toolInput.edits) ? toolInput.edits : [];
}

/**
 * Pi core's seven built-in tools, plus the natively mapped tools that
 * OMP-based hosts add.
 *
 * `hook-engine.ts`'s `parseMcpToolName` needs this to short-circuit the
 * Pi anonymous-MCP fallback tier, exactly as `OPENCODE_BUILTIN_TOOLS`
 * does for opencode: without it a registry server named `web` or `bash`
 * would claim `web_search` / `bash_background` as MCP and re-gate them
 * under `permitted_tools.mcp`. That is the exact defect Task 9 found in
 * the opencode branch.
 */
export const PI_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'bash', 'read', 'write', 'edit', 'ls', 'find', 'grep',
  'eval', 'bash_background', 'web_search',
]);

export interface PiAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * Pi extension adapter.
 *
 * Bridges Pi's `tool_call` / `tool_result` extension events to the
 * common Nio decision engine. Pi passes tool parameters as `input`
 * (mutable in place) rather than OpenClaw's `params`.
 *
 * Blocking is done by returning `{ block: true, reason }` from the
 * `tool_call` handler — see src/adapters/pi-plugin.ts.
 */
export class PiAdapter implements HookAdapter {
  readonly name = 'pi';
  private nativeToolMapping: Record<string, ActionType>;

  constructor(opts?: PiAdapterOptions) {
    this.nativeToolMapping =
      (opts?.nativeToolMapping as Record<string, ActionType>) ?? DEFAULT_NATIVE_TOOL_MAPPING;
  }

  parseInput(raw: unknown): HookInput {
    const event = (raw ?? {}) as Record<string, unknown>;
    return {
      toolName: (event.toolName as string) || '',
      toolInput: (event.input as Record<string, unknown>) || {},
      eventType: 'pre',
      sessionId: event.sessionId as string | undefined,
      cwd: event.cwd as string | undefined,
      raw: event,
    };
  }

  mapToolToActionType(toolName: string): string | null {
    return this.nativeToolMapping[toolName] || null;
  }

  buildEnvelope(input: HookInput, initiatingSkill?: string | null): ActionEnvelope | null {
    const actionType = this.mapToolToActionType(input.toolName) as ActionType | null;
    if (!actionType) return null;

    const actor = {
      skill: {
        id: initiatingSkill || 'pi-session',
        source: initiatingSkill || 'pi',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: input.sessionId || `pi-${Date.now()}`,
      user_present: true,
      env: 'prod' as const,
      time: new Date().toISOString(),
      initiating_skill: initiatingSkill || undefined,
    };

    let actionData: ActionData;

    switch (actionType) {
      case 'exec_command': {
        const command = (input.toolInput.command as string) || evalCellAsCommand(input.toolInput);
        if (!command) return null;
        const data: ExecCommandData = {
          command,
          args: [],
          cwd: input.cwd,
        };
        actionData = data;
        break;
      }

      case 'write_file': {
        // Pi's write tool uses `content`; its edit tool uses `newText`
        // (OMP's replace-mode edit: `new_string`) for the replacement body.
        // OMP's patch-mode edit adds `edits[{ rename, diff }]`; its
        // apply_patch / hashline / sloppy modes carry only `input`.
        const patchText = typeof input.toolInput.input === 'string' ? input.toolInput.input : undefined;
        const entries = patchEditEntries(input.toolInput);
        const targets = [...new Set([
          input.toolInput.path,
          ...entries.map(entry => entry.rename),
          ...editTargets(patchText),
        ].filter((target): target is string => typeof target === 'string' && target !== ''))];
        if (patchText !== undefined && targets.length === 0) return null;
        const patchDiffs = entries.map(entry => entry.diff).filter(diff => typeof diff === 'string').join('\n');
        const content =
          (input.toolInput.content as string) ||
          (input.toolInput.newText as string) ||
          (input.toolInput.new_string as string) ||
          patchText || patchDiffs;
        const data: FileOperationData = {
          ...targetFields(targets),
          content_preview: content.slice(0, 10_000),
        };
        actionData = data;
        break;
      }

      case 'read_file': {
        const data: FileOperationData = {
          path: (input.toolInput.path as string) || '',
        };
        actionData = data;
        break;
      }

      case 'network_request': {
        const data: NetworkRequestData = {
          method: (input.toolInput.method as NetworkRequestData['method']) || 'GET',
          url: (input.toolInput.url as string) || '',
          // A search tool has no URL; its query is the payload that leaves the machine.
          body_preview: (input.toolInput.body ?? input.toolInput.query) as string | undefined,
        };
        actionData = data;
        break;
      }

      default:
        return null;
    }

    return { actor, action: { type: actionType, data: actionData }, context };
  }

  /**
   * Pi exposes skills as `/skill:name` commands and does not surface the
   * initiating skill on tool events. Returning null keeps the audit row
   * honest rather than guessing.
   */
  async inferInitiatingSkill(_input: HookInput): Promise<string | null> {
    return null;
  }
}
