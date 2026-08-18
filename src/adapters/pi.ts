// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type {
  ActionEnvelope, ActionData, ActionType,
  ExecCommandData, FileOperationData, NetworkRequestData,
} from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';
import { asText } from './common.js';

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
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, ActionType> = {
  bash: 'exec_command',
  write: 'write_file',
  edit: 'write_file',
  read: 'read_file',
};

/**
 * Pi core's seven built-in tools.
 *
 * `hook-engine.ts`'s `parseMcpToolName` needs this to short-circuit the
 * Pi anonymous-MCP fallback tier, exactly as `OPENCODE_BUILTIN_TOOLS`
 * does for opencode. None of the seven currently contains an underscore,
 * so the guard is presently redundant — it is here so that a future Pi
 * built-in named like `apply_patch` cannot be silently re-gated under
 * `permitted_tools.mcp` the moment an MCP server is configured. That is
 * the exact defect Task 9 found in the opencode branch.
 */
export const PI_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'bash', 'read', 'write', 'edit', 'ls', 'find', 'grep',
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
      // `asText`, not `as string`: Pi runs Nio in-process and hands the
      // adapter a live host object. See asText — a throw from the string
      // methods that read this downstream loses the guard decision.
      toolName: asText(event.toolName),
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
      // Every `toolInput` read goes through `asText`: these are
      // model-authored, unvalidated values feeding fields the analysers
      // treat as strings. `content.slice(0, 10_000)` below used to throw
      // on a non-string content, before the guard had reached a verdict.
      // This host runs Nio in-process and its binding catches, so the
      // throw did not kill anything — it failed OPEN, which is the same
      // outcome by a different route.
      case 'exec_command': {
        const data: ExecCommandData = {
          command: asText(input.toolInput.command),
          args: [],
          cwd: input.cwd,
        };
        actionData = data;
        break;
      }

      case 'write_file': {
        // Pi's write tool uses `content`; its edit tool uses
        // `newText` for the replacement body.
        const content =
          asText(input.toolInput.content) ||
          asText(input.toolInput.newText);
        const data: FileOperationData = {
          path: asText(input.toolInput.path),
          content_preview: content.slice(0, 10_000),
        };
        actionData = data;
        break;
      }

      case 'read_file': {
        const data: FileOperationData = {
          path: asText(input.toolInput.path),
        };
        actionData = data;
        break;
      }

      case 'network_request': {
        const data: NetworkRequestData = {
          method: (input.toolInput.method as NetworkRequestData['method']) || 'GET',
          url: asText(input.toolInput.url),
          body_preview: input.toolInput.body as string | undefined,
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
