// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const CONTENT_TYPES = ['thinking', 'text', 'user_prompt', 'tool_input', 'tool_output'] as const;
export const contentTypeSchema = z.enum(CONTENT_TYPES);
export const contentRecordAttributesSchema = z.object({
  'nio.content.type': contentTypeSchema,
  'nio.content.index': z.number().int().nonnegative(),
  'nio.content.source': z.string().min(1),
  'nio.content.call_id': z.string().min(1).optional(),
  'nio.content.source_id': z.string().min(1).optional(),
  'nio.content.fidelity': z.enum(['full', 'summary', 'unknown']).optional(),
  'nio.content.truncated': z.boolean().optional(),
  'nio.content.original_bytes': z.number().int().nonnegative().optional(),
  'nio.content.redactions': z.number().int().positive().optional(),
  'nio.trace_id': z.string().regex(/^[0-9a-f]{32}$/),
  'nio.span_id': z.string().regex(/^[0-9a-f]{16}$/),
  'gen_ai.tool.call.id': z.string().min(1).optional(),
}).strict();

export const contentRecordSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  body: z.string().min(1),
  attributes: contentRecordAttributesSchema,
}).strict().superRefine((record, ctx) => {
  if (record.traceId !== record.attributes['nio.trace_id']) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attributes', 'nio.trace_id'], message: 'Trace IDs must match' });
  }
  if (record.spanId !== record.attributes['nio.span_id']) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attributes', 'nio.span_id'], message: 'Span IDs must match' });
  }
});

export type ContentType = z.infer<typeof contentTypeSchema>;
export type ContentRecordAttributes = z.infer<typeof contentRecordAttributesSchema>;
export type ContentRecord = z.infer<typeof contentRecordSchema>;

export function contentJsonSchema() {
  return zodToJsonSchema(contentRecordSchema, { name: 'ContentRecord', target: 'jsonSchema7' });
}
