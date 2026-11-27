// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { validateConfig } from '../adapters/config-schema.js';

// Tests run from dist/tests/; the pi package sits two levels up.
const PI_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'pi');
const SECRET_PLACEHOLDER = /\$\{secret:[a-z][a-z0-9_-]*\}/g;

describe('pi package managed-config declaration (crew.json)', () => {
  const declaration = JSON.parse(readFileSync(join(PI_PACKAGE, 'crew.json'), 'utf-8')) as {
    config: { path: string; default: string };
  };
  const defaultPath = join(PI_PACKAGE, declaration.config.default);

  const loadWithSecret = (value: string) =>
    validateConfig(
      yamlLoad(readFileSync(defaultPath, 'utf-8').replace(SECRET_PLACEHOLDER, value)),
      declaration.config.default,
    );

  it('declares a home-relative path under a dot-directory', () => {
    const segments = declaration.config.path.split('/');
    assert.ok(segments.length >= 2);
    assert.match(segments[0]!, /^\.[^./]/);
    assert.ok(!segments.includes('..'));
  });

  it('names a default that ships inside the package', () => {
    assert.ok(existsSync(defaultPath));
  });

  it('validates with the Secret substituted by a value or by an empty string', () => {
    assert.equal(loadWithSecret('sk-test').collector?.api_key, 'sk-test');
    assert.equal(loadWithSecret('').collector?.api_key, '');
  });

  it('denies confirm verdicts', () => {
    assert.equal(loadWithSecret('').guard?.confirm_action, 'deny');
  });
});
