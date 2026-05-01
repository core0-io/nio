// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { ActionEnvelope } from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';

/**
 * Default native-tool → action-type mapping for Hermes.
 *
 * Keyed on Hermes built-in tool names (see the Hermes agent docs).
 * Users can override via `guard.native_tool_mapping.hermes` in config.yaml.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, string> = {
  terminal: 'exec_command',   // Hermes's shell tool
  exec: 'exec_command',       // alt naming in some builds
  shell: 'exec_command',
  write_file: 'write_file',
  patch: 'write_file',        // Hermes patch tool writes to disk
  read_file: 'read_file',
  fetch: 'network_request',
  http_request: 'network_request',
};

export interface HermesAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * Hermes hook adapter
 *
 * Bridges Hermes Agent's shell-hook JSON protocol (from PR #13296) to
 * the common Nio decision engine. Hermes itself spawns our
 * `hook-cli.js` as a subprocess and pipes a snake_case JSON envelope
 * over stdin:
 *
 *   {
 *     "hook_event_name": "pre_tool_call",
 *     "tool_name":       "terminal",
 *     "tool_input":      { "command": "rm -rf /" },
 *     "session_id":      "sess_abc123",
 *     "cwd":             "/home/user/project",
 *     "extra":           { "task_id": "...", "tool_call_id": "..." }
 *   }
 *
 * Blocking is done by writing Claude-Code-style
 * `{"decision": "block", "reason": "..."}` or Hermes-canonical
 * `{"action": "block", "message": "..."}` on stdout; Hermes's
 * `_parse_response` normalises both forms internally.
 *
 * The stdout formatting happens in `hook-cli.ts` — this adapter's
 * responsibility is limited to parsing the stdin envelope and
 * building a normalised `ActionEnvelope` that `evaluateHook` can
 * dispatch through the 6-phase pipeline.
 */
export class HermesAdapter implements HookAdapter {
  readonly name = 'hermes';
  private nativeToolMapping: Record<string, string>;

  constructor(opts?: HermesAdapterOptions) {
    this.nativeToolMapping = opts?.nativeToolMapping ?? DEFAULT_NATIVE_TOOL_MAPPING;
  }

  parseInput(raw: unknown): HookInput {
    const event = raw as Record<string, unknown>;
    const hookEvent = (event.hook_event_name as string) || '';
    return {
      toolName: (event.tool_name as string) || '',
      toolInput: (event.tool_input as Record<string, unknown>) || {},
      eventType: hookEvent.startsWith('post_') ? 'post' : 'pre',
      sessionId: (event.session_id as string) || undefined,
      cwd: (event.cwd as string) || undefined,
      raw: event,
    };
  }

  mapToolToActionType(toolName: string): string | null {
    if (this.nativeToolMapping[toolName]) {
      return this.nativeToolMapping[toolName];
    }
    // Prefix match for tool families (e.g. "terminal_python" → "exec_command")
    for (const [prefix, actionType] of Object.entries(this.nativeToolMapping)) {
      if (toolName.startsWith(prefix)) {
        return actionType;
      }
    }
    return null;
  }

  buildEnvelope(input: HookInput, initiatingSkill?: string | null): ActionEnvelope | null {
    const actionType = this.mapToolToActionType(input.toolName);
    if (!actionType) return null;

    const actor = {
      skill: {
        id: initiatingSkill || 'hermes-session',
        source: initiatingSkill || 'hermes',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: input.sessionId || `hermes-${Date.now()}`,
      user_present: true,
      env: 'prod' as const,
      time: new Date().toISOString(),
      initiating_skill: initiatingSkill || undefined,
    };

    let actionData: Record<string, unknown>;

    switch (actionType) {
      case 'exec_command':
        actionData = {
          command: (input.toolInput.command as string) || '',
          args: [],
        };
        break;

      case 'write_file': {
        const content = (input.toolInput.content as string) ||
                        (input.toolInput.file_text as string) || '';
        actionData = {
          path: (input.toolInput.path as string) ||
                (input.toolInput.file_path as string) || '',
          content_preview: content.slice(0, 10_000),
        };
        break;
      }

      case 'read_file':
        actionData = {
          path: (input.toolInput.path as string) ||
                (input.toolInput.file_path as string) || '',
        };
        break;

      case 'network_request':
        actionData = {
          method: (input.toolInput.method as string) || 'GET',
          url: (input.toolInput.url as string) || '',
          body_preview: input.toolInput.body as string | undefined,
        };
        break;

      default:
        return null;
    }

    return {
      actor,
      action: { type: actionType, data: actionData },
      context,
    } as unknown as ActionEnvelope;
  }

  async inferInitiatingSkill(_input: HookInput): Promise<string | null> {
    return null;
  }
}
