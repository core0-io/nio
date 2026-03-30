import type { SkillIdentity, CapabilityModel } from './skill.js';
import type { RiskLevel } from './scanner.js';

/**
 * Action types that can be scanned
 */
export type ActionType =
  | 'network_request'
  | 'exec_command'
  | 'read_file'
  | 'write_file'
  | 'secret_access';

/**
 * Policy decision
 */
export type Decision = 'allow' | 'deny' | 'confirm';

/**
 * Evidence for action decisions
 */
export interface ActionEvidence {
  /** Evidence type */
  type: string;
  /** Field that triggered */
  field?: string;
  /** Matched pattern */
  match?: string;
  /** Description */
  description: string;
}

/**
 * Policy decision result
 */
export interface PolicyDecision {
  /** Decision: allow, deny, or confirm */
  decision: Decision;
  /** Risk level */
  risk_level: RiskLevel;
  /** Risk tags that contributed to decision */
  risk_tags: string[];
  /** Evidence supporting the decision */
  evidence: ActionEvidence[];
  /** Effective capabilities (if modified) */
  effective_capabilities?: Partial<CapabilityModel>;
  /** Human-readable explanation */
  explanation?: string;
}

/**
 * Network request action data
 */
export interface NetworkRequestData {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body_preview?: string;
}

/**
 * Command execution action data
 */
export interface ExecCommandData {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * File operation action data
 */
export interface FileOperationData {
  path: string;
  content_preview?: string;
}

/**
 * Secret access action data
 */
export interface SecretAccessData {
  secret_name: string;
  access_type: 'read' | 'write';
}

/**
 * Union type for all action data
 */
export type ActionData =
  | NetworkRequestData
  | ExecCommandData
  | FileOperationData
  | SecretAccessData;

/**
 * Action context
 */
export interface ActionContext {
  /** Session identifier */
  session_id: string;
  /** Whether user is present/active */
  user_present: boolean;
  /** Environment */
  env: 'prod' | 'dev' | 'test';
  /** Action timestamp */
  time: string;
  /** Skill that initiated this action (inferred from transcript) */
  initiating_skill?: string;
}

/**
 * Action envelope - the complete action request
 */
export interface ActionEnvelope {
  /** Actor information */
  actor: {
    skill: SkillIdentity;
    record_key?: string;
  };
  /** Action details */
  action: {
    type: ActionType;
    data: ActionData;
  };
  /** Action context */
  context: ActionContext;
}
