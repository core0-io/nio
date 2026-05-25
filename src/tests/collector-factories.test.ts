// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMeterProvider } from '../scripts/lib/metrics-collector.js';
import { createTracerProvider } from '../scripts/lib/traces-collector.js';
import { createLoggerProvider } from '../scripts/lib/logs-collector.js';
import type { CollectorConfig } from '../scripts/lib/config-loader.js';

// All three OTEL provider factories must short-circuit when their
// signal-specific toggle is false, even with a valid endpoint. This was
// the regression that left collector.metrics.enabled=false dead code.

const baseEnabled: CollectorConfig = {
  endpoint: 'http://localhost:4318',
  api_key: '',
  headers: {},
  timeout: 5000,
  protocol: 'http',
  enabled: true,
  metrics_enabled: true,
  traces_enabled: true,
  logs_enabled: true,
};

describe('createMeterProvider', () => {
  it('returns null when endpoint is missing', () => {
    assert.equal(createMeterProvider({ ...baseEnabled, endpoint: '' }), null);
  });

  it('returns null when metrics_enabled is false (even with endpoint set)', () => {
    assert.equal(createMeterProvider({ ...baseEnabled, metrics_enabled: false }), null);
  });

  it('returns a provider when endpoint set and metrics_enabled true', () => {
    const p = createMeterProvider(baseEnabled);
    assert.notEqual(p, null);
    p?.shutdown();
  });
});

describe('createTracerProvider', () => {
  it('returns null when endpoint is missing', () => {
    assert.equal(createTracerProvider({ ...baseEnabled, endpoint: '' }), null);
  });

  it('returns null when traces_enabled is false (even with endpoint set)', () => {
    assert.equal(createTracerProvider({ ...baseEnabled, traces_enabled: false }), null);
  });

  it('returns a provider when endpoint set and traces_enabled true', () => {
    const p = createTracerProvider(baseEnabled);
    assert.notEqual(p, null);
    p?.shutdown();
  });
});

describe('createLoggerProvider', () => {
  it('returns null when endpoint is missing', () => {
    assert.equal(createLoggerProvider({ ...baseEnabled, endpoint: '' }), null);
  });

  it('returns null when logs_enabled is false (even with endpoint set)', () => {
    assert.equal(createLoggerProvider({ ...baseEnabled, logs_enabled: false }), null);
  });

  it('returns a provider when endpoint set and logs_enabled true', () => {
    const p = createLoggerProvider(baseEnabled);
    assert.notEqual(p, null);
    p?.shutdown();
  });
});
