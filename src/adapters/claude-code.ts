// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import type { ActionEnvelope, ActionData, ActionType, ExecCommandData, FileOperationData, NetworkRequestData } from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';

/**
 * Default native-tool → action-type mapping — used when config does not
 * provide one.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, ActionType> = {
  Bash: 'exec_command',
  Write: 'write_file',
  Edit: 'write_file',
  WebFetch: 'network_request',
  WebSearch: 'network_request',
};

export interface ClaudeCodeAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * Claude Code hook adapter
 *
 * Bridges Claude Code's PreToolUse/PostToolUse stdin/stdout protocol
 * to the common Nio decision engine.
 */
export class ClaudeCodeAdapter implements HookAdapter {
  readonly name = 'claude-code';
  private nativeToolMapping: Record<string, ActionType>;

  constructor(opts?: ClaudeCodeAdapterOptions) {
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
        id: initiatingSkill || 'claude-code-session',
        source: initiatingSkill || 'claude-code',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: input.sessionId || `hook-${Date.now()}`,
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

  async inferInitiatingSkill(input: HookInput): Promise<string | null> {
    const data = input.raw as Record<string, unknown>;
    const transcriptPath = data.transcript_path as string | undefined;
    if (!transcriptPath) return null;

    try {
      const fd = openSync(transcriptPath, 'r');
      const stat = fstatSync(fd);
      const TAIL_SIZE = 4096;
      const start = Math.max(0, stat.size - TAIL_SIZE);
      const buf = Buffer.alloc(Math.min(TAIL_SIZE, stat.size));
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);

      const tail = buf.toString('utf-8');
      const lines = tail.split('\n').filter(Boolean);

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'tool_use' && entry.name === 'Skill' && entry.input?.skill) {
            return entry.input.skill;
          }
          if (entry.role === 'assistant' && Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) {
                return block.input.skill;
              }
            }
          }
        } catch {
          // Not valid JSON
        }
      }
    } catch {
      // Can't read transcript
    }
    return null;
  }
}
