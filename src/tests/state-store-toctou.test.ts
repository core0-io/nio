// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Review finding M6: the sweep's stat → read → mutate sequence has no
 * lock, so the owning process can rename a fresh shard into place between
 * the stat and the destructive step and have the NEW file acted on.
 *
 * `shardUnchangedSince` is the guard `takeAbandonedShards` re-checks
 * immediately before every destructive step (the salvage rewrite and the
 * GC unlink). It compares mtime, inode and size against the stat that
 * decided the shard was stale.
 *
 * Scope note, stated plainly: these tests pin the GUARD, not the call
 * sites. node is single-threaded and `takeAbandonedShards` is fully
 * synchronous with no injectable seam, so a real writer cannot be
 * interleaved into it from a test — deleting the two `shardUnchangedSince`
 * call sites would not turn anything below red. What they do kill is any
 * weakening of the comparison itself, which is where the subtlety lives:
 * mtime alone is not enough at coarse timestamp granularity, and the
 * inode check is what actually catches `saveState`'s write-then-rename.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveState, statePath, shardUnchangedSince, type CollectorState,
} from '../scripts/lib/traces-state-store.js';
import type { CollectorLogsConfig } from '../adapters/common.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

function freshLogsConfig(): CollectorLogsConfig {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-toctou-')));
  return { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 };
}

function blank(sessionId: string): CollectorState {
  return {
    session_id: sessionId,
    turn_number: 1,
    turn_trace_id: '',
    turn_start_ms: 0,
    pending_spans: {},
    pending_task_spans: {},
  };
}

describe('shardUnchangedSince: the sweep\'s TOCTOU guard', () => {
  it('says unchanged for a file nobody has touched', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-quiet'), 'sess-quiet');
    const path = statePath(logsConfig, 'sess-quiet');

    assert.equal(
      shardUnchangedSince(path, statSync(path)), true,
      'a guard that never says "unchanged" would disable the sweep outright',
    );
  });

  it('catches saveState\'s write-then-rename even when mtime would not', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-owner'), 'sess-owner');
    const path = statePath(logsConfig, 'sess-owner');
    // Pin the timestamp to a whole millisecond first: utimesSync cannot
    // reproduce the sub-millisecond mtime a real write leaves behind, and
    // this test is specifically about the case where mtime AGREES.
    const pinned = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(path, pinned, pinned);
    const seen = statSync(path);

    // The owner wakes up and writes. saveState renames a temp file over
    // the target, so this is a NEW inode at the same path — and the two
    // states serialise to the same length, so `size` cannot see it
    // either. On a filesystem with coarse mtime granularity a same-
    // millisecond rewrite is invisible to mtime as well; the inode is
    // what makes the guard sound.
    saveState(logsConfig, blank('sess-owner'), 'sess-owner');
    utimesSync(path, pinned, pinned);           // simulate the coarse-clock case
    const after = statSync(path);
    assert.equal(after.mtimeMs, seen.mtimeMs, 'the test needs mtime to be uninformative here');
    assert.equal(after.size, seen.size, 'and size too');

    assert.equal(
      shardUnchangedSince(path, seen), false,
      'the sweep would salvage (or GC) a shard the owning process had just replaced — ' +
      'the write it is about to clobber is the one the owner just made',
    );
  });

  it('catches a plain in-place mutation', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-grow'), 'sess-grow');
    const path = statePath(logsConfig, 'sess-grow');
    const seen = statSync(path);

    appendFileSync(path, ' ', 'utf-8');

    assert.equal(shardUnchangedSince(path, seen), false);
  });

  it('says changed when the file is gone', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-vanish'), 'sess-vanish');
    const path = statePath(logsConfig, 'sess-vanish');
    const seen = statSync(path);

    writeFileSync(path, 'x', 'utf-8');
    const gone = join(seen.isFile() ? `${path}.missing` : path);

    assert.equal(
      shardUnchangedSince(gone, seen), false,
      'an unstattable path must never be reported as unchanged — the destructive step ' +
      'is only allowed to run on a file this process has verified',
    );
  });
});
