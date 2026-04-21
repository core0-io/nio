// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { ActionEnvelope, ActionContext } from '../../types/action.js';

/**
 * Build a minimal ActionEnvelope for runtime-guard tests.
 * `type` is the ActionType string; `data` is the action-specific payload.
 */
export function makeEnvelope(
  type: string,
  data: Record<string, unknown>,
): ActionEnvelope {
  return {
    actor: {
      skill: { id: 'test', source: 'test', version_ref: '0.0.0', artifact_hash: '' },
    },
    action: {
      type: type as ActionEnvelope['action']['type'],
      data: data as unknown as ActionEnvelope['action']['data'],
    },
    context: {
      session_id: 'test-session',
      user_present: true,
      env: 'test',
      time: new Date().toISOString(),
    } as ActionContext,
  };
}

export function makeExecEnvelope(command: string, args?: string[]): ActionEnvelope {
  return makeEnvelope('exec_command', args ? { command, args } : { command });
}

export function makeWriteEnvelope(path: string, content = ''): ActionEnvelope {
  return makeEnvelope('write_file', { path, content_preview: content });
}

export function makeNetworkEnvelope(url: string, body = ''): ActionEnvelope {
  return makeEnvelope('network_request', {
    url,
    method: 'POST',
    body_preview: body,
  });
}
