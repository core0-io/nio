"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaudeCodeAdapter = void 0;
const node_fs_1 = require("node:fs");
/**
 * Tool name → action type mapping for Claude Code
 */
const TOOL_ACTION_MAP = {
    Bash: 'exec_command',
    Write: 'write_file',
    Edit: 'write_file',
    WebFetch: 'network_request',
    WebSearch: 'network_request',
};
/**
 * Claude Code hook adapter
 *
 * Bridges Claude Code's PreToolUse/PostToolUse stdin/stdout protocol
 * to the common AgentGuard decision engine.
 */
class ClaudeCodeAdapter {
    name = 'claude-code';
    parseInput(raw) {
        const data = raw;
        const hookEvent = data.hook_event_name || '';
        return {
            toolName: data.tool_name || '',
            toolInput: data.tool_input || {},
            eventType: hookEvent.startsWith('Post') ? 'post' : 'pre',
            sessionId: data.session_id,
            cwd: data.cwd,
            raw: data,
        };
    }
    mapToolToActionType(toolName) {
        return TOOL_ACTION_MAP[toolName] || null;
    }
    buildEnvelope(input, initiatingSkill) {
        const actionType = this.mapToolToActionType(input.toolName);
        if (!actionType)
            return null;
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
            env: 'prod',
            time: new Date().toISOString(),
            initiating_skill: initiatingSkill || undefined,
        };
        let actionData;
        switch (actionType) {
            case 'exec_command': {
                const data = {
                    command: input.toolInput.command || '',
                    args: [],
                    cwd: input.cwd,
                };
                actionData = data;
                break;
            }
            case 'write_file': {
                const data = {
                    path: input.toolInput.file_path || '',
                };
                actionData = data;
                break;
            }
            case 'network_request': {
                const data = {
                    method: 'GET',
                    url: input.toolInput.url || input.toolInput.query || '',
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
    async inferInitiatingSkill(input) {
        const data = input.raw;
        const transcriptPath = data.transcript_path;
        if (!transcriptPath)
            return null;
        try {
            const fd = (0, node_fs_1.openSync)(transcriptPath, 'r');
            const stat = (0, node_fs_1.fstatSync)(fd);
            const TAIL_SIZE = 4096;
            const start = Math.max(0, stat.size - TAIL_SIZE);
            const buf = Buffer.alloc(Math.min(TAIL_SIZE, stat.size));
            (0, node_fs_1.readSync)(fd, buf, 0, buf.length, start);
            (0, node_fs_1.closeSync)(fd);
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
                }
                catch {
                    // Not valid JSON
                }
            }
        }
        catch {
            // Can't read transcript
        }
        return null;
    }
}
exports.ClaudeCodeAdapter = ClaudeCodeAdapter;
