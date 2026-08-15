// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type {
  ActionEnvelope, ActionData, ActionType,
  ExecCommandData, FileOperationData, NetworkRequestData,
} from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';
import { asText } from './common.js';

/**
 * Default native-tool → action-type mapping for opencode.
 *
 * The full built-in set is read, write, edit, apply_patch, glob, grep,
 * list, bash, task, todowrite, todoread, webfetch, websearch, lsp,
 * skill, question (see the permission-key table in opencode's
 * docs/agents.mdx and the imports in src/tool/registry.ts).
 *
 * glob / grep / list / todo* / lsp / skill / question are deliberately
 * unmapped: they are navigation and bookkeeping, not effects on the
 * outside world, and mapping them would flood the audit log without
 * adding signal. `task` is handled as a sub-agent span, not an action.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, ActionType> = {
  bash: 'exec_command',
  write: 'write_file',
  edit: 'write_file',
  apply_patch: 'write_file',
  read: 'read_file',
  webfetch: 'network_request',
  websearch: 'network_request',
};

/**
 * All sixteen opencode built-in tool names (same enumeration as the doc
 * comment above `DEFAULT_NATIVE_TOOL_MAPPING`).
 *
 * `hook-engine.ts`'s `parseMcpToolName` needs this to short-circuit
 * opencode's MCP-name fallback tier. opencode flattens MCP tool names as
 * `<server>_<tool>` with no fixed delimiter, so when no registered server
 * prefixes a name, the parser falls back to treating the *whole* name as
 * an anonymous MCP tool. `apply_patch` is the one built-in whose name
 * contains an underscore, so without this guard it would be misread as
 * an MCP call the moment any MCP server is configured — silently
 * re-gating opencode's core file-editing tool under `permitted_tools.mcp`
 * / `blocked_tools.mcp` instead of `permitted_tools.opencode`.
 */
export const OPENCODE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'list', 'bash',
  'task', 'todowrite', 'todoread', 'webfetch', 'websearch', 'lsp', 'skill',
  'question',
]);

export interface OpenCodeAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * Pull the first file target out of an apply_patch payload. opencode
 * marks each file in the patch body with `*** Add File: <path>`,
 * `*** Update File: <path>` or `*** Delete File: <path>`
 * (packages/opencode/src/patch.ts:76-87). Returns null when the payload
 * carries no marker, so the caller can fall back to an empty path
 * rather than inventing one.
 */
function firstPatchTarget(patchText: string | undefined): string | null {
  if (!patchText) return null;
  for (const line of patchText.split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * opencode plugin adapter.
 *
 * Bridges opencode's `tool.execute.before` / `tool.execute.after` hooks
 * to the common Nio decision engine. Those hooks take two arguments
 * (`input` and `output`); the binding layer merges them into a single
 * object of the shape `{ tool, sessionID, callID, args, output? }`
 * before calling `parseInput`, so the single-payload HookAdapter
 * contract still holds.
 *
 * Blocking is done by throwing from the before-hook — opencode's
 * session/tools.ts triggers the hook ahead of `item.execute`, so a
 * throw prevents execution entirely.
 */
export class OpenCodeAdapter implements HookAdapter {
  readonly name = 'opencode';
  private nativeToolMapping: Record<string, ActionType>;

  constructor(opts?: OpenCodeAdapterOptions) {
    this.nativeToolMapping =
      (opts?.nativeToolMapping as Record<string, ActionType>) ?? DEFAULT_NATIVE_TOOL_MAPPING;
  }

  parseInput(raw: unknown): HookInput {
    const event = (raw ?? {}) as Record<string, unknown>;
    return {
      // `asText`, not `as string`: opencode runs Nio in-process and hands
      // the plugin a live host object. See asText — `toolName` is read by
      // string methods downstream (MCP-name parse, deny/allow-list match).
      toolName: asText(event.tool),
      toolInput: (event.args as Record<string, unknown>) || {},
      // The after-hook payload carries `output`; the before-hook does not.
      eventType: 'output' in event ? 'post' : 'pre',
      sessionId: event.sessionID as string | undefined,
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
        id: initiatingSkill || 'opencode-session',
        source: initiatingSkill || 'opencode',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: input.sessionId || `opencode-${Date.now()}`,
      user_present: true,
      env: 'prod' as const,
      time: new Date().toISOString(),
      initiating_skill: initiatingSkill || undefined,
    };

    let actionData: ActionData;

    switch (actionType) {
      // Every `toolInput` read goes through `asText`: these are
      // model-authored, unvalidated values feeding fields the analysers
      // treat as strings. `content.slice(10_000)` below used to throw on
      // a non-string content, outside the orchestrator's try/catch,
      // killing the process before its deny reached the host.
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
        // opencode uses camelCase `filePath`. The three writers differ:
        //   write       → { filePath, content }
        //   edit        → { filePath, newString }
        //   apply_patch → { patchText }   ← NO filePath at all
        // apply_patch's targets are marker lines inside the patch text
        // (packages/opencode/src/tool/apply_patch.ts declares a single
        // `patchText` field; packages/opencode/src/patch.ts parses the
        // `*** Add|Update|Delete File:` markers). Without extracting
        // them, every apply_patch call would reach the audit log with an
        // empty path and give Phase 3 nothing to scan.
        const patchText = asText(input.toolInput.patchText);
        const content =
          asText(input.toolInput.content) ||
          asText(input.toolInput.newString) ||
          patchText;
        const data: FileOperationData = {
          path: asText(input.toolInput.filePath) || firstPatchTarget(patchText) || '',
          content_preview: content.slice(0, 10_000),
        };
        actionData = data;
        break;
      }

      case 'read_file': {
        const data: FileOperationData = {
          path: asText(input.toolInput.filePath),
        };
        actionData = data;
        break;
      }

      case 'network_request': {
        const data: NetworkRequestData = {
          method: 'GET',
          url:
            asText(input.toolInput.url) ||
            asText(input.toolInput.query),
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
   * opencode loads skills through its native `skill` tool rather than
   * annotating downstream tool calls, so the initiating skill is not
   * recoverable from a tool event. Returning null keeps the audit row
   * honest rather than guessing.
   */
  async inferInitiatingSkill(_input: HookInput): Promise<string | null> {
    return null;
  }
}
