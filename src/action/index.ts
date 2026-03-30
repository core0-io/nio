import type {
  ActionEnvelope,
  PolicyDecision,
  NetworkRequestData,
  ExecCommandData,
} from '../types/action.js';
import type { CapabilityModel } from '../types/skill.js';
import { DEFAULT_CAPABILITY } from '../types/skill.js';
import { SkillRegistry } from '../registry/index.js';
import { analyzeNetworkRequest } from './detectors/network.js';
import { analyzeExecCommand } from './detectors/exec.js';
import * as nodePath from 'path';

/**
 * Action Scanner options
 */
export interface ActionScannerOptions {
  /** Registry instance */
  registry?: SkillRegistry;
  /** Default capabilities when no registry record found */
  defaultCapabilities?: CapabilityModel;
}

/**
 * Action Scanner - Module C
 * Runtime action decision engine
 */
export class ActionScanner {
  private registry: SkillRegistry;
  private defaultCapabilities: CapabilityModel;

  constructor(options: ActionScannerOptions = {}) {
    this.registry = options.registry || new SkillRegistry();
    this.defaultCapabilities = options.defaultCapabilities || DEFAULT_CAPABILITY;
  }

  /**
   * Main decision method
   */
  async decide(envelope: ActionEnvelope): Promise<PolicyDecision> {
    const { actor, action, context } = envelope;

    // Look up skill capabilities
    const lookupResult = await this.registry.lookup(actor.skill);
    const capabilities = lookupResult.effective_capabilities;
    const trustLevel = lookupResult.effective_trust_level;

    // Route to appropriate handler based on action type
    switch (action.type) {
      case 'network_request':
        return this.handleNetworkRequest(
          action.data as NetworkRequestData,
          capabilities,
          context.user_present
        );

      case 'exec_command':
        return this.handleExecCommand(
          action.data as ExecCommandData,
          capabilities
        );

      case 'secret_access':
        return this.handleSecretAccess(
          action.data as { secret_name: string; access_type: string },
          capabilities
        );

      case 'read_file':
      case 'write_file':
        return this.handleFileOperation(
          action.data as { path: string },
          action.type,
          capabilities
        );

      default:
        return {
          decision: 'deny',
          risk_level: 'high',
          risk_tags: ['UNKNOWN_ACTION_TYPE'],
          evidence: [
            {
              type: 'unknown_action',
              description: `Unknown action type: ${action.type}`,
            },
          ],
          explanation: `Unknown action type: ${action.type}`,
        };
    }
  }

  /**
   * Handle network request actions
   */
  private async handleNetworkRequest(
    request: NetworkRequestData,
    capabilities: CapabilityModel,
    userPresent: boolean
  ): Promise<PolicyDecision> {
    const analysis = analyzeNetworkRequest(
      request,
      capabilities.network_allowlist
    );

    // Critical secret leak - always deny
    if (analysis.risk_tags.includes('CRITICAL_SECRET_EXFIL')) {
      return {
        decision: 'deny',
        risk_level: 'critical',
        risk_tags: analysis.risk_tags,
        evidence: analysis.evidence,
        explanation: analysis.block_reason || 'Critical secret exfiltration blocked',
      };
    }

    // Should block
    if (analysis.should_block) {
      return {
        decision: 'deny',
        risk_level: analysis.risk_level,
        risk_tags: analysis.risk_tags,
        evidence: analysis.evidence,
        explanation: analysis.block_reason || 'Request blocked',
      };
    }

    // High risk - require confirmation
    if (analysis.risk_level === 'high' || analysis.risk_level === 'critical') {
      return {
        decision: userPresent ? 'confirm' : 'deny',
        risk_level: analysis.risk_level,
        risk_tags: analysis.risk_tags,
        evidence: analysis.evidence,
        explanation: userPresent
          ? 'High-risk request requires confirmation'
          : 'High-risk request denied (user not present)',
      };
    }

    // Untrusted domain - require confirmation
    if (analysis.risk_tags.includes('UNTRUSTED_DOMAIN')) {
      return {
        decision: userPresent ? 'confirm' : 'deny',
        risk_level: analysis.risk_level,
        risk_tags: analysis.risk_tags,
        evidence: analysis.evidence,
        explanation: userPresent
          ? 'Request to untrusted domain requires confirmation'
          : 'Request to untrusted domain denied (user not present)',
      };
    }

    // Allow
    return {
      decision: 'allow',
      risk_level: analysis.risk_level,
      risk_tags: analysis.risk_tags,
      evidence: analysis.evidence,
    };
  }

  /**
   * Handle command execution actions
   */
  private handleExecCommand(
    command: ExecCommandData,
    capabilities: CapabilityModel
  ): PolicyDecision {
    const execAllowed = capabilities.exec === 'allow';
    const analysis = analyzeExecCommand(command, execAllowed);

    if (analysis.should_block) {
      // Critical threats (rm -rf, fork bomb, etc.) are always hard denied.
      // Non-critical blocked commands (exec not allowed but not dangerous)
      // return 'confirm' so balanced mode can prompt the user instead of blocking.
      const isCritical = analysis.risk_level === 'critical';
      return {
        decision: isCritical ? 'deny' : 'confirm',
        risk_level: analysis.risk_level,
        risk_tags: analysis.risk_tags,
        evidence: analysis.evidence,
        explanation: analysis.block_reason || 'Command execution blocked',
      };
    }

    // High-risk commands need confirmation even if exec is allowed
    if (analysis.risk_level === 'high' || analysis.risk_level === 'critical') {
      return {
        decision: 'confirm',
        risk_level: analysis.risk_level,
        risk_tags: analysis.risk_tags,
        evidence: analysis.evidence,
        explanation: 'High-risk command requires confirmation',
      };
    }

    return {
      decision: 'allow',
      risk_level: analysis.risk_level,
      risk_tags: analysis.risk_tags,
      evidence: analysis.evidence,
    };
  }

  /**
   * Handle secret access
   */
  private handleSecretAccess(
    access: { secret_name: string; access_type: string },
    capabilities: CapabilityModel
  ): PolicyDecision {
    const isAllowed = capabilities.secrets_allowlist.includes(access.secret_name);

    if (isAllowed) {
      return {
        decision: 'allow',
        risk_level: 'low',
        risk_tags: [],
        evidence: [],
      };
    }

    return {
      decision: 'deny',
      risk_level: 'high',
      risk_tags: ['SECRET_NOT_ALLOWED'],
      evidence: [
        {
          type: 'secret_access_denied',
          field: 'secret_name',
          match: access.secret_name,
          description: `Secret ${access.secret_name} not in allowlist`,
        },
      ],
      explanation: `Access to secret '${access.secret_name}' is not allowed`,
    };
  }

  /**
   * Handle file operations
   */
  private handleFileOperation(
    file: { path: string },
    type: 'read_file' | 'write_file',
    capabilities: CapabilityModel
  ): PolicyDecision {
    // Normalize path to prevent traversal attacks (e.g. ./allowed/../../../etc/passwd)
    const normalizedPath = nodePath.normalize(file.path);
    if (normalizedPath !== file.path && file.path.includes('..')) {
      return {
        decision: 'deny',
        risk_level: 'high',
        risk_tags: ['PATH_TRAVERSAL'],
        evidence: [
          {
            type: 'path_traversal',
            field: 'path',
            match: file.path,
            description: `Path traversal detected: "${file.path}" resolves to "${normalizedPath}"`,
          },
        ],
        explanation: 'Path traversal attack blocked',
      };
    }

    // Check if path is in allowlist (use normalized path)
    const isAllowed = capabilities.filesystem_allowlist.some((pattern) => {
      if (pattern === '*') return true;
      if (pattern.endsWith('/**')) {
        const prefix = pattern.slice(0, -3);
        return normalizedPath.startsWith(prefix);
      }
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -2);
        const remainder = normalizedPath.slice(prefix.length);
        return normalizedPath.startsWith(prefix) && !remainder.includes('/');
      }
      return normalizedPath === pattern || normalizedPath.startsWith(pattern + '/');
    });

    if (isAllowed) {
      return {
        decision: 'allow',
        risk_level: 'low',
        risk_tags: [],
        evidence: [],
      };
    }

    return {
      decision: 'deny',
      risk_level: 'medium',
      risk_tags: ['PATH_NOT_ALLOWED'],
      evidence: [
        {
          type: 'path_access_denied',
          field: 'path',
          match: file.path,
          description: `Path ${file.path} not in allowlist`,
        },
      ],
      explanation: `${type === 'read_file' ? 'Read' : 'Write'} access to '${file.path}' is not allowed`,
    };
  }
}

// Export singleton instance
export const actionScanner = new ActionScanner();

// Re-export types and sub-modules
export * from './detectors/index.js';
