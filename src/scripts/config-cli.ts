#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

import { loadConfig, resetConfig } from '../index.js';

const subcommand = process.argv[2];

async function main(): Promise<void> {
  switch (subcommand) {
    case 'show': {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
      break;
    }
    case 'reset': {
      const config = resetConfig();
      console.log('Config reset to defaults:');
      console.log(JSON.stringify(config, null, 2));
      break;
    }
    case 'import': {
      const path = process.argv[3];
      if (!path) {
        console.error('Usage: config-cli.js import <path>');
        process.exit(2);
      }
      // Same code path as the /nio config import slash command — runs the
      // full doctor probe suite, backs up the existing config with a
      // timestamped .bak, atomic write of the new one.
      const { dispatchNioCommand } = await import('../adapters/openclaw-dispatch.js');
      const result = await dispatchNioCommand(`config import ${path}`, {
        orchestrator: undefined as never,   // config import doesn't use deps
        scanner: undefined as never,
      });
      console.log(result);
      // Non-zero exit on REJECTED / FAILED so callers (setup.sh) can detect.
      if (/^# config import (REJECTED|FAILED)/m.test(result)) process.exit(1);
      break;
    }
    default:
      console.error('Usage: config-cli.js <show|reset|import <path>>');
      process.exit(1);
  }
}

main();
