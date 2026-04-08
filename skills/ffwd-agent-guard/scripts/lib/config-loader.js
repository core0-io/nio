/**
 * Lightweight config loader for hook scripts.
 *
 * Reads ~/.ffwd-agent-guard/config.json (or $FFWD_AGENT_GUARD_HOME/config.json)
 * directly without importing the main dist bundle or any heavy dependencies.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export function loadCollectorConfig() {
    const configDir = process.env['FFWD_AGENT_GUARD_HOME']
        ?? join(homedir(), '.ffwd-agent-guard');
    const configPath = join(configDir, 'config.json');
    let raw = {};
    try {
        raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    catch {
        // No config file — return disabled
        return disabled();
    }
    const c = (raw['collector'] ?? {});
    let log = c['log'] ?? '';
    if (log.startsWith('~/')) {
        log = join(homedir(), log.slice(2));
    }
    const endpoint = c['endpoint'] ?? '';
    const enabled = endpoint !== '' || log !== '';
    return {
        endpoint,
        api_key: c['api_key'] ?? '',
        timeout: c['timeout'] || 5000,
        log,
        protocol: c['protocol'] ?? 'http',
        enabled,
    };
}
function disabled() {
    return { endpoint: '', api_key: '', timeout: 5000, log: '', protocol: 'http', enabled: false };
}
