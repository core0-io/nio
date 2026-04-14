import type { ActionEnvelope } from '../types/action.js';
import type { RuntimeAnalyser } from '../core/analysers/runtime/index.js';

/**
 * Standardized hook input — platform-agnostic representation
 */
export interface HookInput {
  /** Tool name (platform-specific, e.g. "Bash" or "exec") */
  toolName: string;
  /** Tool parameters */
  toolInput: Record<string, unknown>;
  /** Hook event type */
  eventType: 'pre' | 'post';
  /** Session identifier */
  sessionId?: string;
  /** Working directory */
  cwd?: string;
  /** Raw platform-specific input */
  raw: unknown;
}

/**
 * Hook evaluation result
 */
export interface HookOutput {
  /** Decision */
  decision: 'allow' | 'deny' | 'ask';
  /** Human-readable reason */
  reason?: string;
  /** Risk level */
  riskLevel?: string;
  /** Numeric severity in [0, 1] (higher = more severe), derived from risk level */
  riskScore?: number;
  /** Risk tags */
  riskTags?: string[];
  /** Initiating skill (if detected) */
  initiatingSkill?: string | null;
}

/**
 * Platform adapter interface
 *
 * Each platform (Claude Code, OpenClaw, etc.) implements this interface
 * to bridge its hook protocol to the common AgentGuard decision engine.
 */
export interface HookAdapter {
  /** Platform identifier */
  readonly name: string;

  /** Parse raw platform input into standardized HookInput */
  parseInput(raw: unknown): HookInput;

  /** Map platform tool name to ActionEnvelope action type */
  mapToolToActionType(toolName: string): string | null;

  /** Build an ActionEnvelope from standardized input */
  buildEnvelope(input: HookInput, initiatingSkill?: string | null): ActionEnvelope | null;

  /** Infer which skill initiated the current tool call */
  inferInitiatingSkill(input: HookInput): Promise<string | null>;
}

/**
 * Agentguard instance interface (subset used by engine)
 */
export interface AgentGuardInstance {
  runtimeAnalyser: RuntimeAnalyser;
}

/**
 * Engine options
 */
export interface EngineOptions {
  config: {
    level?: string;
    guard?: {
      available_tools?: string[];
      blocked_tools?: string[];
      guarded_tools?: Record<string, string>;
    };
  };
  /** Runtime AgentGuard engine (scanner + registry facade) */
  ffwdAgentGuard: AgentGuardInstance;
}
