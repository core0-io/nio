// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { ActionEnvelope } from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';
import { asText } from './common.js';

/**
 * Default native-tool → action-type mapping for OpenClaw.
 * Used when config does not provide guard.native_tool_mapping.openclaw.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, string> = {
  exec: 'exec_command',
  write: 'write_file',
  read: 'read_file',
  web_fetch: 'network_request',
  browser: 'network_request',
};

export interface OpenClawAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * OpenClaw hook adapter
 *
 * Bridges OpenClaw's before_tool_call / after_tool_call plugin hooks
 * to the common Nio decision engine.
 *
 * OpenClaw plugin hooks receive an event object:
 *   { toolName: string, params: Record<string, any>, toolCallId?: string }
 *
 * Blocking is done by returning { block: true, blockReason: "..." }
 * from the before_tool_call handler.
 */
export class OpenClawAdapter implements HookAdapter {
  readonly name = 'openclaw';
  private nativeToolMapping: Record<string, string>;

  constructor(opts?: OpenClawAdapterOptions) {
    this.nativeToolMapping = opts?.nativeToolMapping ?? DEFAULT_NATIVE_TOOL_MAPPING;
  }

  parseInput(raw: unknown): HookInput {
    const event = raw as Record<string, unknown>;
    return {
      // `asText`, not `as string`: OpenClaw runs Nio in-process and hands
      // the adapter a live host object. `toolName` is read by string
      // methods downstream (MCP-name parse, deny/allow-list match, this
      // adapter's prefix-matching `mapToolToActionType`); see asText.
      toolName: asText(event.toolName),
      toolInput: (event.params as Record<string, unknown>) || {},
      eventType: 'pre', // before_tool_call = pre
      raw: event,
    };
  }

  mapToolToActionType(toolName: string): string | null {
    // Direct match
    if (this.nativeToolMapping[toolName]) {
      return this.nativeToolMapping[toolName];
    }
    // Prefix match for tool families (e.g. "exec_python" → "exec_command")
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
        id: initiatingSkill || 'openclaw-session',
        source: initiatingSkill || 'openclaw',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: `openclaw-${Date.now()}`,
      user_present: true,
      env: 'prod' as const,
      time: new Date().toISOString(),
      initiating_skill: initiatingSkill || undefined,
    };

    let actionData: Record<string, unknown>;

    switch (actionType) {
      // Every `toolInput` read goes through `asText`: these are
      // model-authored, unvalidated values feeding fields the analysers
      // treat as strings. `content.slice(10_000)` below used to throw on
      // a non-string content, outside the orchestrator's try/catch,
      // killing the process before its deny reached the host.
      case 'exec_command':
        actionData = {
          command: asText(input.toolInput.command),
          args: [],
        };
        break;

      case 'write_file': {
        const content = asText(input.toolInput.content) ||
                        asText(input.toolInput.file_text);
        actionData = {
          path: asText(input.toolInput.path) ||
                asText(input.toolInput.file_path),
          content_preview: content.slice(0, 10_000),
        };
        break;
      }

      case 'read_file':
        actionData = {
          path: asText(input.toolInput.path) ||
                asText(input.toolInput.file_path),
        };
        break;

      case 'network_request':
        actionData = {
          // NOT `asText`: `method` is only ever JSON.stringify'd
          // (action-orchestrator.ts's Phase 5 synthetic request.json;
          // the Phase 2 network analyser destructures it and never reads
          // it), so no runtime value can make it throw. Left as-is
          // rather than coerced for uniformity — an unkillable change.
          method: (input.toolInput.method as string) || 'GET',
          url: asText(input.toolInput.url),
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
