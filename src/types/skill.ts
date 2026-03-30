/**
 * Skill Identity - Strong binding to source + version + hash
 */
export interface SkillIdentity {
  /** Skill name identifier */
  id: string;
  /** Source repository (e.g., github.com/org/repo) */
  source: string;
  /** Version reference (e.g., v1.0.0) */
  version_ref: string;
  /** Artifact hash (e.g., sha256:abc...) */
  artifact_hash: string;
}

/**
 * Capability Model - Minimum privilege snapshot
 */
export interface CapabilityModel {
  /** Allowed network domains (supports wildcards like *.example.com) */
  network_allowlist: string[];
  /** Allowed filesystem paths */
  filesystem_allowlist: string[];
  /** Command execution permission */
  exec: 'allow' | 'deny';
  /** Allowed secrets (env var names) */
  secrets_allowlist: string[];
}

/**
 * Default capability model - most restrictive
 */
export const DEFAULT_CAPABILITY: CapabilityModel = {
  network_allowlist: [],
  filesystem_allowlist: [],
  exec: 'deny',
  secrets_allowlist: [],
};

/**
 * Generate record key from skill identity
 */
export function generateRecordKey(skill: SkillIdentity): string {
  return `${skill.source}@${skill.version_ref}#${skill.artifact_hash}`;
}

/**
 * Validate skill identity
 */
export function validateSkillIdentity(skill: unknown): skill is SkillIdentity {
  if (!skill || typeof skill !== 'object') return false;
  const s = skill as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.source === 'string' &&
    typeof s.version_ref === 'string' &&
    typeof s.artifact_hash === 'string'
  );
}
