import type { TrustLevel, TrustRecord } from '../types/registry.js';
import type { SkillIdentity, CapabilityModel } from '../types/skill.js';
import { generateRecordKey } from '../types/skill.js';

/**
 * Trust level priorities (higher = more trusted)
 */
export const TRUST_PRIORITY: Record<TrustLevel, number> = {
  untrusted: 0,
  restricted: 1,
  trusted: 2,
};

/**
 * Check if a trust level change is an upgrade
 */
export function isTrustUpgrade(from: TrustLevel, to: TrustLevel): boolean {
  return TRUST_PRIORITY[to] > TRUST_PRIORITY[from];
}

/**
 * Check if a trust level change is a downgrade
 */
export function isTrustDowngrade(from: TrustLevel, to: TrustLevel): boolean {
  return TRUST_PRIORITY[to] < TRUST_PRIORITY[from];
}

/**
 * Determine if a skill needs re-evaluation based on identity changes
 */
export function needsReevaluation(
  existingRecord: TrustRecord,
  newSkill: SkillIdentity
): {
  needsReevaluation: boolean;
  reason?: string;
} {
  // Hash change = definitely needs re-evaluation
  if (existingRecord.skill.artifact_hash !== newSkill.artifact_hash) {
    return {
      needsReevaluation: true,
      reason: 'artifact_hash_changed',
    };
  }

  // Version change (but same hash is fine, unlikely but possible)
  if (existingRecord.skill.version_ref !== newSkill.version_ref) {
    return {
      needsReevaluation: true,
      reason: 'version_changed',
    };
  }

  return { needsReevaluation: false };
}

/**
 * Check if capabilities are being escalated
 */
export function isCapabilityEscalation(
  existing: CapabilityModel,
  requested: CapabilityModel
): {
  isEscalation: boolean;
  escalations: string[];
} {
  const escalations: string[] = [];

  // Check exec permission
  if (existing.exec === 'deny' && requested.exec === 'allow') {
    escalations.push('exec: deny -> allow');
  }

  // Check network allowlist expansion
  const newNetworkDomains = requested.network_allowlist.filter(
    (d) => !existing.network_allowlist.includes(d)
  );
  if (newNetworkDomains.length > 0) {
    escalations.push(`network_allowlist: added ${newNetworkDomains.join(', ')}`);
  }

  // Check filesystem allowlist expansion
  const newFilePaths = requested.filesystem_allowlist.filter(
    (p) => !existing.filesystem_allowlist.includes(p)
  );
  if (newFilePaths.length > 0) {
    escalations.push(`filesystem_allowlist: added ${newFilePaths.join(', ')}`);
  }

  // Check secrets allowlist expansion
  const newSecrets = requested.secrets_allowlist.filter(
    (s) => !existing.secrets_allowlist.includes(s)
  );
  if (newSecrets.length > 0) {
    escalations.push(`secrets_allowlist: added ${newSecrets.join(', ')}`);
  }

  return {
    isEscalation: escalations.length > 0,
    escalations,
  };
}

/**
 * Create a new trust record
 */
export function createTrustRecord(
  skill: SkillIdentity,
  trustLevel: TrustLevel,
  capabilities: CapabilityModel,
  review: {
    reviewed_by: string;
    evidence_refs: string[];
    notes: string;
  },
  expiresAt?: string
): TrustRecord {
  const now = new Date().toISOString();

  return {
    record_key: generateRecordKey(skill),
    skill,
    trust_level: trustLevel,
    capabilities,
    expires_at: expiresAt,
    review: {
      ...review,
      reviewed_at: now,
    },
    status: 'active',
    created_at: now,
    updated_at: now,
  };
}

/**
 * Merge capabilities (take the more restrictive option)
 */
export function mergeCapabilities(
  a: CapabilityModel,
  b: CapabilityModel
): CapabilityModel {
  return {
    network_allowlist: a.network_allowlist.filter((d) =>
      b.network_allowlist.includes(d)
    ),
    filesystem_allowlist: a.filesystem_allowlist.filter((p) =>
      b.filesystem_allowlist.includes(p)
    ),
    exec: a.exec === 'deny' || b.exec === 'deny' ? 'deny' : 'allow',
    secrets_allowlist: a.secrets_allowlist.filter((s) =>
      b.secrets_allowlist.includes(s)
    ),
  };
}
