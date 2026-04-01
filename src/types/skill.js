"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CAPABILITY = void 0;
exports.generateRecordKey = generateRecordKey;
exports.validateSkillIdentity = validateSkillIdentity;
/**
 * Default capability model - most restrictive
 */
exports.DEFAULT_CAPABILITY = {
    network_allowlist: [],
    filesystem_allowlist: [],
    exec: 'deny',
    secrets_allowlist: [],
};
/**
 * Generate record key from skill identity
 */
function generateRecordKey(skill) {
    return `${skill.source}@${skill.version_ref}#${skill.artifact_hash}`;
}
/**
 * Validate skill identity
 */
function validateSkillIdentity(skill) {
    if (!skill || typeof skill !== 'object')
        return false;
    const s = skill;
    return (typeof s.id === 'string' &&
        typeof s.source === 'string' &&
        typeof s.version_ref === 'string' &&
        typeof s.artifact_hash === 'string');
}
