#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Command } from 'commander';

import { SkillScanner } from './scanner/index.js';
import { RuntimeAnalyzer } from './core/analyzers/runtime/index.js';
import type { ProtectionLevel } from './core/analyzers/runtime/decision.js';
import { loadConfig } from './adapters/index.js';
import type { ActionEnvelope } from './types/action.js';

// Module instances (initialized in createServer)
let scanner: SkillScanner;
let runtimeAnalyzer: RuntimeAnalyzer;

// Zod schemas for validation
const SkillIdentitySchema = z.object({
  id: z.string(),
  source: z.string(),
  version_ref: z.string(),
  artifact_hash: z.string(),
});

const ActionContextSchema = z.object({
  session_id: z.string(),
  user_present: z.boolean(),
  env: z.enum(['prod', 'dev', 'test']),
  time: z.string().optional(),
  initiating_skill: z.string().optional(),
});

const ActionEnvelopeSchema = z.object({
  actor: z.object({
    skill: SkillIdentitySchema,
    record_key: z.string().optional(),
  }),
  action: z.object({
    type: z.enum([
      'network_request', 'exec_command', 'read_file',
      'write_file', 'secret_access',
    ]),
    data: z.record(z.unknown()),
  }),
  context: ActionContextSchema,
});

/**
 * Reject objects containing prototype pollution keys
 */
function containsProtoKeys(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (containsProtoKeys((obj as Record<string, unknown>)[key])) return true;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (containsProtoKeys(item)) return true;
    }
  }
  return false;
}

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
  const config = loadConfig();
  scanner = new SkillScanner({ extraPatterns: config.rules });
  runtimeAnalyzer = new RuntimeAnalyzer({
    level: (config.level || 'balanced') as ProtectionLevel,
    weights: config.guard?.weights,
    extraAllowlist: config.guard?.extra_allowlist,
    llmApiKey: config.llm?.api_key,
    llmModel: config.llm?.model,
    scoringEndpoint: config.guard?.scoring_endpoint,
    scoringApiKey: config.guard?.scoring_api_key,
    scoringTimeout: config.guard?.scoring_timeout,
  });

  const server = new Server(
    {
      name: 'ffwd-agent-guard',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List all available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // Scanner tools
        {
          name: 'skill_scanner_scan',
          description: 'Scan a skill directory for security risks. Returns risk level, tags, and evidence.',
          inputSchema: {
            type: 'object',
            properties: {
              skill: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Skill identifier' },
                  source: { type: 'string', description: 'Source repository' },
                  version_ref: { type: 'string', description: 'Version reference' },
                  artifact_hash: { type: 'string', description: 'Artifact hash' },
                },
                required: ['id', 'source', 'version_ref', 'artifact_hash'],
              },
              path: { type: 'string', description: 'Path to skill directory' },
              deep: { type: 'boolean', description: 'Enable deep analysis', default: false },
            },
            required: ['skill', 'path'],
          },
        },

        // Action evaluation tool (RuntimeAnalyzer)
        {
          name: 'action_evaluate',
          description: 'Evaluate a runtime action through the 6-phase guard pipeline. Returns allow/deny/confirm decision with scores.',
          inputSchema: {
            type: 'object',
            properties: {
              actor: {
                type: 'object',
                properties: {
                  skill: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      source: { type: 'string' },
                      version_ref: { type: 'string' },
                      artifact_hash: { type: 'string' },
                    },
                    required: ['id', 'source', 'version_ref', 'artifact_hash'],
                  },
                },
                required: ['skill'],
              },
              action: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['network_request', 'exec_command', 'read_file', 'write_file', 'secret_access'],
                  },
                  data: { type: 'object', description: 'Action-specific data' },
                },
                required: ['type', 'data'],
              },
              context: {
                type: 'object',
                properties: {
                  session_id: { type: 'string' },
                  user_present: { type: 'boolean' },
                  env: { type: 'string', enum: ['prod', 'dev', 'test'] },
                },
                required: ['session_id', 'user_present', 'env'],
              },
            },
            required: ['actor', 'action', 'context'],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // Scanner: scan
        case 'skill_scanner_scan': {
          const skill = SkillIdentitySchema.parse(args?.skill);
          const path = args?.path as string;
          const deep = args?.deep as boolean || false;

          const result = await scanner.scan({
            skill,
            payload: { type: 'dir', ref: path },
            options: { deep },
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        // Action evaluation via RuntimeAnalyzer
        case 'action_evaluate': {
          if (containsProtoKeys(args)) {
            throw new Error('Invalid input: prototype pollution attempt detected');
          }
          const envelope = ActionEnvelopeSchema.parse(args) as unknown as ActionEnvelope;
          envelope.context.time = new Date().toISOString();

          const result = await runtimeAnalyzer.evaluate(envelope);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Main entry point
 */
async function main() {
  const program = new Command();

  program
    .name('ffwd-agent-guard')
    .description('Security skill MCP server for AI agents')
    .version('1.0.0')
    .action(async () => {
      // Create server
      const server = createServer();

      // Connect via stdio
      const transport = new StdioServerTransport();
      await server.connect(transport);

      console.error('FFWD AgentGuard MCP server started');
    });

  await program.parseAsync(process.argv);
}

// Run if executed directly
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
