// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityModel } from '../types/skill.js';

/**
 * Default policy configuration
 */
export interface PolicyConfig {
  /** Default action for secret exfiltration */
  secret_exfil: {
    private_key: 'deny' | 'confirm';
    api_secret: 'deny' | 'confirm';
  };
  /** Default action for command execution */
  exec_command: 'allow' | 'deny' | 'confirm';
  /** Network policies */
  network: {
    untrusted_domain: 'allow' | 'deny' | 'confirm';
    body_contains_secret: 'allow' | 'deny' | 'confirm';
  };
}

/**
 * Default policies - most restrictive
 */
export const DEFAULT_POLICIES: PolicyConfig = {
  // Private key exfiltration is always blocked
  secret_exfil: {
    private_key: 'deny',
    api_secret: 'confirm',
  },

  // Command execution is denied by default
  exec_command: 'deny',

  // Network requests
  network: {
    untrusted_domain: 'confirm',
    body_contains_secret: 'deny',
  },
};

/**
 * Restrictive capability model
 */
export const RESTRICTIVE_CAPABILITY: CapabilityModel = {
  network_allowlist: [],
  filesystem_allowlist: [],
  exec: 'deny',
  secrets_allowlist: [],
};

/**
 * Permissive capability model (for trusted skills)
 */
export const PERMISSIVE_CAPABILITY: CapabilityModel = {
  network_allowlist: ['*'],
  filesystem_allowlist: ['./**'],
  exec: 'allow',
  secrets_allowlist: ['*'],
};

/**
 * Common capability presets
 */
export const CAPABILITY_PRESETS = {
  /** No capabilities */
  none: RESTRICTIVE_CAPABILITY,

  /** Read-only local access */
  read_only: {
    ...RESTRICTIVE_CAPABILITY,
    filesystem_allowlist: ['./**'],
  },

};
