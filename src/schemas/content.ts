// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Captured OTel GenAI v1.40.0 subset; attributed upstream schemas are in schemas/opentelemetry.
export const contentPartSchema = z.object({
  type: z.enum(['text', 'reasoning']),
  content: z.string(),
}).strict();
export const inputMessageSchema = z.object({
  role: z.literal('user'),
  parts: z.array(contentPartSchema).min(1),
}).strict();
export const outputMessageSchema = z.object({
  role: z.literal('assistant'),
  finish_reason: z.string(),
  parts: z.array(contentPartSchema).min(1),
}).strict();
const auxiliaryAttributes = {
  'nio.content.truncated': z.boolean().optional(),
  // Sum of redacted, pre-truncation property bytes, present only on truncation.
  'nio.content.original_bytes': z.number().int().nonnegative().optional(),
  'nio.content.redactions': z.number().int().positive().optional(),
  'nio.trace_id': z.string().regex(/^[0-9a-f]{32}$/).optional(),
  'nio.span_id': z.string().regex(/^[0-9a-f]{16}$/).optional(),
};
export const contentRecordAttributesSchema = z.union([
  z.object({ ...auxiliaryAttributes, 'gen_ai.input.messages': z.array(inputMessageSchema).length(1), 'gen_ai.output.messages': z.never().optional() }).strict(),
  z.object({ ...auxiliaryAttributes, 'gen_ai.output.messages': z.array(outputMessageSchema).length(1), 'gen_ai.input.messages': z.never().optional() }).strict(),
]);
export const contentRecordSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  attributes: contentRecordAttributesSchema,
}).strict().superRefine((record, ctx) => {
  for (const [key, value] of [['nio.trace_id', record.traceId], ['nio.span_id', record.spanId]] as const) {
    if (record.attributes[key] !== undefined && record.attributes[key] !== value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attributes', key], message: 'Association IDs must match' });
    }
  }
});
export type ContentPart = z.infer<typeof contentPartSchema>;
export type ContentRecordAttributes = z.infer<typeof contentRecordAttributesSchema>;
export type ContentRecord = z.infer<typeof contentRecordSchema>;

export function contentJsonSchema() {
  return zodToJsonSchema(contentRecordSchema, { name: 'ContentRecord', target: 'jsonSchema7' });
}
