// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { ActionEnvelope, ActionData, ActionType, ExecCommandData, FileOperationData, NetworkRequestData } from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';

/**
 * Default native-tool → action-type mapping for Codex.
 *
 * Codex 0.118.x ships with `Bash` as its only first-party tool —
 * writes, reads, network access all flow through shell. Plugin- and
 * MCP-provided tools (e.g. Write, Edit from a filesystem plugin) are
 * dynamic and not listed here; they reach Phase 1-6 only when the user
 * adds them to `native_tool_mapping.codex` in nio config.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, ActionType> = {
  Bash: 'exec_command',
};

export interface CodexAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * Codex hook adapter
 *
 * Bridges Codex CLI's lifecycle hook stdin/stdout protocol to the
 * common Nio decision engine. Codex events: SessionStart, PreToolUse,
 * PostToolUse, PermissionRequest, UserPromptSubmit, Stop. There is no
 * SessionEnd / SubagentStop equivalent — collector coverage is reduced
 * accordingly; see docs/COLLECTOR-SIGNALS.md.
 *
 * The PreToolUse stdin payload mirrors Claude Code's shape closely:
 * `{ session_id, turn_id?, transcript_path, cwd, hook_event_name,
 *    model, permission_mode, tool_name, tool_input, tool_use_id }`.
 */
export class CodexAdapter implements HookAdapter {
  readonly name = 'codex';
  private nativeToolMapping: Record<string, ActionType>;

  constructor(opts?: CodexAdapterOptions) {
    this.nativeToolMapping = (opts?.nativeToolMapping as Record<string, ActionType>) ?? DEFAULT_NATIVE_TOOL_MAPPING;
  }

  parseInput(raw: unknown): HookInput {
    const data = raw as Record<string, unknown>;
    const hookEvent = (data.hook_event_name as string) || '';
    return {
      toolName: (data.tool_name as string) || '',
      toolInput: (data.tool_input as Record<string, unknown>) || {},
      eventType: hookEvent.startsWith('Post') ? 'post' : 'pre',
      sessionId: data.session_id as string | undefined,
      cwd: data.cwd as string | undefined,
      raw: data,
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
        id: initiatingSkill || 'codex-session',
        source: initiatingSkill || 'codex',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: input.sessionId || `codex-hook-${Date.now()}`,
      user_present: true,
      env: 'prod' as const,
      time: new Date().toISOString(),
      initiating_skill: initiatingSkill || undefined,
    };

    let actionData: ActionData;

    switch (actionType) {
      case 'exec_command': {
        const data: ExecCommandData = {
          command: (input.toolInput.command as string) || '',
          args: [],
          cwd: input.cwd,
        };
        actionData = data;
        break;
      }

      case 'write_file': {
        const content = (input.toolInput.content as string) ||
                        (input.toolInput.new_string as string) || '';
        const data: FileOperationData = {
          path: (input.toolInput.file_path as string) || '',
          content_preview: content.slice(0, 10_000),
        };
        actionData = data;
        break;
      }

      case 'network_request': {
        const data: NetworkRequestData = {
          method: 'GET',
          url: (input.toolInput.url as string) || (input.toolInput.query as string) || '',
        };
        actionData = data;
        break;
      }

      default:
        return null;
    }

    return {
      actor,
      action: { type: actionType, data: actionData },
      context,
    };
  }

  /**
   * Phase 1: returns null. Codex transcript JSONL has a different
   * schema from Claude Code (different event types, no `tool_use` /
   * `Skill`-named blocks), so reusing the cc heuristic would not yield
   * useful data. Phase 2 will implement codex-specific parsing.
   */
  async inferInitiatingSkill(_input: HookInput): Promise<string | null> {
    return null;
  }
}
