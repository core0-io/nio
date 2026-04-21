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
    default:
      console.error('Usage: config-cli.js <show|reset>');
      process.exit(1);
  }
}

main();
