import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { commandUsage, main, parseArgs } from '../src/cli.js';
import { formatVerifyReport, runVerifyCommand } from '../src/commands/verify.js';
import { corpusHash } from '../src/core/changes.js';
import { ServiceError } from '../src/core/errors.js';
import { Store, StoreError } from '../src/core/store.js';
import { loadConfig } from '../src/config.js';
import { EXIT } from '../src/exit-codes.js';
import { createTestLogger, FIXTURE_SECTIONS, makeSection, openTempStore } from './helpers.js';

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function makeIo(env: NodeJS.ProcessEnv = {}): {
  out: string[];
  err: string[];
  io: { out(c: string): void; err(c: string): void; env: NodeJS.ProcessEnv };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (chunk) => out.push(chunk),
      err: (chunk) => err.push(chunk),
      env,
    },
  };
}

/** Seed a temp store AND record the receipt its seeded rows imply. */
function openReceiptedStore() {
  const temp = openTempStore();
  temp.store.setMeta('corpus_hash', corpusHash(temp.store.snapshotTextHashes(38)));
  return temp;
}

/** Run `fn` and return the ServiceError it threw (the test asserts on it). */
function captureServiceError(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('expected a ServiceError, none was thrown');
}

describe('verify argument parsing', () => {
  it('parses verify with and without a snapshot path', () => {
    expect(parseArgs(['verify'])).toEqual({ command: 'verify' });
    expect(parseArgs(['verify', './backup.sqlite'])).toEqual({
      command: 'verify',
      snapshot: './backup.sqlite',
    });
  });

  it('rejects extra arguments and dash-prefixed paths', () => {
    expect(() => parseArgs(['verify', 'a', 'b'])).toThrow(/at most one snapshot path/);
    expect(() => parseArgs(['verify', '--json'])).toThrow(/at most one snapshot path/);
  });

  it('is a known command with its own usage text', () => {
    expect(parseArgs(['verify', '--help'])).toEqual({ command: 'help', topic: 'verify' });
    expect(commandUsage('verify')).toContain('cfr-free verify [snapshot]');
  });
});

describe('runVerifyCommand', () => {
  it('verifies schema, counts, issue date and falls back to the legacy receipt', () => {
    const temp = openReceiptedStore();
    try {
      expect(temp.store.getMeta('title.38.corpus_hash')).toBeNull();
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report).toMatchObject({
        path: temp.indexPath,
        sections: 3,
        appendices: 1,
        issueDate: '2026-10-09',
        receipt: 'match',
      });
      expect(report.recordedCorpusHash).toBe(report.recomputedCorpusHash);
      const output = formatVerifyReport(report);
      expect(output).toContain('schema: ok');
      expect(output).toContain('3 sections + 1 appendices');
      expect(output).toContain('issue date: 2026-10-09');
      expect(output).toContain('corpus receipt: match');
    } finally {
      temp.cleanup();
    }
  });

  it('prefers the Title 38 receipt when the legacy receipt disagrees', () => {
    const temp = openTempStore();
    try {
      const hash = corpusHash(temp.store.snapshotTextHashes(38));
      temp.store.setMeta('title.38.corpus_hash', hash);
      temp.store.setMeta('corpus_hash', '0'.repeat(64));
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report).toMatchObject({ receipt: 'match', recordedCorpusHash: hash });
    } finally {
      temp.cleanup();
    }
  });

  it('verifies a stored snapshot passed positionally, resolving the path', () => {
    const temp = openReceiptedStore();
    const snapshot = path.join(temp.dir, 'backup.sqlite');
    try {
      temp.store.backupTo(snapshot);
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger(), snapshot);
      expect(report.path).toBe(snapshot);
      expect(report.receipt).toBe('match');
      expect(report.sections).toBe(3);
      expect(report.appendices).toBe(1);
    } finally {
      temp.cleanup();
    }
  });

  it('reports an absent receipt: usable, but row provenance cannot be concluded', () => {
    // The fixture seed records no corpus_hash (the pre-receipt shape).
    const temp = openTempStore();
    try {
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.receipt).toBe('absent');
      expect(report.recordedCorpusHash).toBeNull();
      const output = formatVerifyReport(report);
      expect(output).toContain('corpus receipt: absent');
      expect(output).toContain('cannot be concluded either way');
      // What CAN be concluded is stated too: the file opened and counted.
      expect(output).toContain('schema: ok');
      expect(output).toContain('3 sections + 1 appendices');
    } finally {
      temp.cleanup();
    }
  });

  it('reports an index that records neither an issue date nor a receipt', () => {
    const temp = openTempStore({ seed: false });
    try {
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.issueDate).toBeNull();
      expect(report.sections).toBe(0);
      expect(report.appendices).toBe(0);
      expect(report.receipt).toBe('absent');
      const output = formatVerifyReport(report);
      expect(output).toContain('issue date: none recorded');
      expect(output).toContain('0 sections + 0 appendices');
    } finally {
      temp.cleanup();
    }
  });

  it('reports a stale Title 38 receipt when only another title has rows', () => {
    const temp = openTempStore({
      sections: [makeSection({ title: 32, citation: '70.1' })],
    });
    try {
      const recordedCorpusHash = corpusHash(temp.store.snapshotTextHashes(32));
      const emptyCorpusHash = corpusHash(new Map());
      temp.store.setMeta('title.38.corpus_hash', recordedCorpusHash);
      temp.store.setMeta('corpus_hash', emptyCorpusHash);

      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      expect(runVerifyCommand(config, createTestLogger())).toMatchObject({
        sections: 0,
        appendices: 0,
        receipt: 'mismatch',
        recordedCorpusHash,
        recomputedCorpusHash: emptyCorpusHash,
      });
    } finally {
      temp.cleanup();
    }
  });

  it('falls back to the legacy issue_date key when the per-title key is absent', () => {
    const temp = openTempStore();
    try {
      const db = new DatabaseSync(temp.indexPath);
      db.prepare("DELETE FROM meta WHERE key = 'title.38.issue_date'").run();
      db.close();
      temp.store.setMeta('issue_date', '2026-01-02');
      temp.store.setMeta('corpus_hash', corpusHash(temp.store.snapshotTextHashes(38)));
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.issueDate).toBe('2026-01-02');
      expect(report.receipt).toBe('match');
    } finally {
      temp.cleanup();
    }
  });

  it('detects a tampered row: the recorded receipt mismatches the recomputed rows', () => {
    const temp = openReceiptedStore();
    try {
      // The receipt was recorded for the INTACT rows; then one row is
      // tampered with the way a corrupted copy would differ — beneath the
      // meta layer the receipt lives in.
      const db = new DatabaseSync(temp.indexPath);
      db.prepare("UPDATE sections SET text = text || ' [tampered]' WHERE citation = '4.125'").run();
      db.close();
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const report = runVerifyCommand(config, createTestLogger());
      expect(report.receipt).toBe('mismatch');
      expect(report.recordedCorpusHash).not.toBe(report.recomputedCorpusHash);
      const output = formatVerifyReport(report);
      expect(output).toContain('corpus receipt: MISMATCH');
      expect(output).toContain(`recorded:   ${report.recordedCorpusHash}`);
      expect(output).toContain(`recomputed: ${report.recomputedCorpusHash}`);
    } finally {
      temp.cleanup();
    }
  });

  it('refuses a missing path as invalid input', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const missing = path.join(dir, 'missing.sqlite');
      const config = loadConfig({ CFR_INDEX_PATH: missing });
      const error = captureServiceError(() => runVerifyCommand(config, createTestLogger()));
      expect(error.code).toBe('invalid_input');
      expect(error.message).toMatch(/no index or snapshot here/);
      const positional = captureServiceError(() =>
        runVerifyCommand(config, createTestLogger(), missing),
      );
      expect(positional.code).toBe('invalid_input');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not a cfr-free index', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const foreign = path.join(dir, 'foreign.sqlite');
      // A SQLite file holding another program's table.
      const db = new DatabaseSync(foreign);
      db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
      db.close();
      const plain = path.join(dir, 'notes.txt');
      writeFileSync(plain, 'not a database at all');
      const config = loadConfig({ CFR_INDEX_PATH: foreign });
      const error = captureServiceError(() => runVerifyCommand(config, createTestLogger()));
      expect(error.code).toBe('invalid_input');
      expect(error.message).toMatch(/not a cfr-free index/);
      const positional = captureServiceError(() =>
        runVerifyCommand(config, createTestLogger(), plain),
      );
      expect(positional.code).toBe('invalid_input');
      expect(positional.message).toMatch(/cannot open as a cfr-free index/);
      // The refusal carries no path and no raw store/SQLite detail: the
      // reader's line says what to do, and the detail goes to the log.
      expect(positional.message).not.toMatch(/cannot open index at/);
      expect(positional.message).not.toContain(dir);
      expect(positional.message).not.toMatch(/SQLITE|database disk/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path that is not a regular file, before SQLite opens it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const config = loadConfig({ CFR_INDEX_PATH: path.join(dir, 'missing.sqlite') });
      // A directory is not an index file, and SQLite cannot open one.
      const directory = path.join(dir, 'directory.sqlite');
      mkdirSync(directory);
      const error = captureServiceError(() =>
        runVerifyCommand(config, createTestLogger(), directory),
      );
      expect(error.code).toBe('invalid_input');
      expect(error.message).toMatch(/not a regular file/);
      // The configured index path is checked the same way.
      const configured = loadConfig({ CFR_INDEX_PATH: directory });
      const configuredError = captureServiceError(() =>
        runVerifyCommand(configured, createTestLogger()),
      );
      expect(configuredError.message).toMatch(/not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a FIFO before SQLite opens it', (ctx) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const config = loadConfig({ CFR_INDEX_PATH: path.join(dir, 'missing.sqlite') });
      // A FIFO is the case that matters: SQLite's SYNCHRONOUS open blocks on
      // one, so the command would wait forever for a writer that never comes.
      // The refusal has to happen BEFORE the open. The writer below keeps the
      // pipe from blocking if the guard is ever removed, so a regression fails
      // this test instead of hanging it.
      const fifo = path.join(dir, 'fifo.sqlite');
      const made = spawnSync('mkfifo', [fifo]);
      if (made.status !== 0) {
        // No `mkfifo` on this machine: say so instead of quietly not running
        // the case that matters.
        ctx.skip();
        return;
      }
      const writer = spawn('sh', ['-c', `head -c 100 /dev/zero > "${fifo}"`], { stdio: 'ignore' });
      try {
        const fifoError = captureServiceError(() =>
          runVerifyCommand(config, createTestLogger(), fifo),
        );
        expect(fifoError.code).toBe('invalid_input');
        expect(fifoError.message).toMatch(/not a regular file/);
      } finally {
        writer.kill();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells a path that cannot be there from one that cannot be inspected', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const config = loadConfig({ CFR_INDEX_PATH: path.join(dir, 'missing.sqlite') });
      // A path whose parent component is a regular file cannot name an index
      // at all: that is "not there", not "cannot be read".
      const plain = path.join(dir, 'plain.sqlite');
      writeFileSync(plain, 'not a database');
      const missingError = captureServiceError(() =>
        runVerifyCommand(config, createTestLogger(), path.join(plain, 'child.sqlite')),
      );
      expect(missingError.code).toBe('invalid_input');
      expect(missingError.message).toMatch(/no index or snapshot here/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path that cannot be inspected', (ctx) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      // A path nobody may inspect might be there and could not be read: the
      // detail goes to the log, the reader gets guidance. (Root reads
      // everything and Windows has no POSIX permissions, so the case is
      // skipped there — and says so.)
      if (process.platform === 'win32' || process.getuid?.() === 0) {
        ctx.skip();
        return;
      }
      const config = loadConfig({ CFR_INDEX_PATH: path.join(dir, 'missing.sqlite') });
      const locked = path.join(dir, 'locked');
      mkdirSync(locked);
      const hidden = path.join(locked, 'hidden.sqlite');
      writeFileSync(hidden, 'not a database');
      chmodSync(locked, 0o000);
      const logger = createTestLogger();
      try {
        const unreadableError = captureServiceError(() => runVerifyCommand(config, logger, hidden));
        expect(unreadableError.code).toBe('invalid_input');
        expect(unreadableError.message).toMatch(/cannot be read/);
        // The reader's line carries no path and no raw errno.
        expect(unreadableError.message).not.toContain(dir);
        expect(unreadableError.message).not.toMatch(/EACCES|permission denied/i);
        // The detail is in the log.
        expect(logger.records).toContainEqual({
          level: 'warn',
          message: 'verification could not inspect the file',
          fields: { path: hidden, detail: expect.any(String) },
        });
      } finally {
        chmodSync(locked, 0o700);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists the causes an open can fail for, not a single false one', (ctx) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      // A file whose own permissions deny reading it IS a regular file, so
      // the OPEN is what refuses it. The reader must be given every cause an
      // open can have — not one cause asserted as fact.
      if (process.platform === 'win32' || process.getuid?.() === 0) {
        ctx.skip();
        return;
      }
      const config = loadConfig({ CFR_INDEX_PATH: path.join(dir, 'missing.sqlite') });
      const locked = path.join(dir, 'locked.sqlite');
      writeFileSync(locked, 'not a database');
      chmodSync(locked, 0o000);
      try {
        const error = captureServiceError(() =>
          runVerifyCommand(config, createTestLogger(), locked),
        );
        expect(error.code).toBe('invalid_input');
        expect(error.message).toMatch(
          /missing, unreadable, locked, has journal sidecars, or is not a cfr-free index/,
        );
      } finally {
        chmodSync(locked, 0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a lock during the snapshot read as invalid input and closes the reader', () => {
    const temp = openTempStore();
    const logger = createTestLogger();
    const lock = new StoreError('index is locked by another cfr-free process');
    const count = vi.spyOn(Store.prototype, 'countProvisions').mockImplementationOnce(() => {
      throw lock;
    });
    const close = vi.spyOn(Store.prototype, 'close');
    try {
      const config = loadConfig({ CFR_INDEX_PATH: temp.indexPath });
      const error = captureServiceError(() => runVerifyCommand(config, logger));
      expect(error.code).toBe('invalid_input');
      expect(error.message).toBe('cannot read the file as a cfr-free index');
      expect(logger.records).toContainEqual({
        level: 'warn',
        message: 'verification could not read the file',
        fields: { path: temp.indexPath, detail: lock.message },
      });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      count.mockRestore();
      temp.cleanup();
    }
  });

  it('reads ONE revision: a commit during a read cannot produce a false mismatch', () => {
    // The concurrency hazard the read snapshot closes: a sync that commits
    // BETWEEN the verification's hash read and its receipt read would
    // otherwise report a valid index as mismatched. The snapshot pins the
    // revision at its first read, so a commit in between is invisible to
    // the rest of the verification.
    const temp = openTempStore();
    try {
      const before = corpusHash(temp.store.snapshotTextHashes(38));
      temp.store.setMeta('corpus_hash', before);

      // A second connection commits a DIFFERENT receipt while the
      // verification is reading — the rows are unchanged, so the recorded
      // receipt no longer describes them.
      const writer = new DatabaseSync(temp.indexPath);
      const read = temp.store.readSnapshot(() => {
        const first = temp.store.getMeta('corpus_hash');
        writer.exec("UPDATE meta SET value = 'tampered' WHERE key = 'corpus_hash'");
        const second = temp.store.getMeta('corpus_hash');
        return { first, second };
      });
      writer.close();

      // Both reads inside the snapshot saw the same revision: the commit
      // that happened in between did not leak into it.
      expect(read.first).toBe(before);
      expect(read.second).toBe(before);
      // Outside the snapshot the new value is visible, so the test really
      // did commit between the reads.
      expect(temp.store.getMeta('corpus_hash')).toBe('tampered');
    } finally {
      temp.cleanup();
    }
  });

  it('refuses a file stamped with the current version but missing the objects a read needs', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      // The version stamp alone does not make a file usable: this one has
      // the right version but no FTS index, so a search would fail on it.
      const partial = path.join(dir, 'partial.sqlite');
      const db = new DatabaseSync(partial);
      db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sections (
          id INTEGER PRIMARY KEY, title INTEGER NOT NULL DEFAULT 38,
          citation TEXT NOT NULL, kind TEXT NOT NULL, heading TEXT NOT NULL,
          chapter TEXT, subchapter TEXT, part TEXT, subpart TEXT,
          subject_group TEXT, path TEXT NOT NULL, text TEXT NOT NULL,
          markdown TEXT NOT NULL, issue_date TEXT NOT NULL);
        CREATE TABLE section_references (
          citing_id INTEGER NOT NULL, citing_title INTEGER NOT NULL DEFAULT 38,
          cited_citation TEXT NOT NULL);
        PRAGMA user_version = 3;`);
      db.close();
      const config = loadConfig({ CFR_INDEX_PATH: partial });
      const error = captureServiceError(() => runVerifyCommand(config, createTestLogger()));
      expect(error.code).toBe('invalid_input');
      expect(error.message).toMatch(/cannot open as a cfr-free index/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify CLI dispatch and exit codes', () => {
  it('exits 0 and prints the report for a verified index', async () => {
    const temp = openReceiptedStore();
    try {
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify'], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain('corpus receipt: match');
    } finally {
      temp.cleanup();
    }
  });

  it('exits 0 and reports an absent receipt clearly', async () => {
    const temp = openTempStore();
    try {
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify'], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain('corpus receipt: absent');
    } finally {
      temp.cleanup();
    }
  });

  it('exits 1 when the recorded receipt mismatches the current rows', async () => {
    const temp = openReceiptedStore();
    try {
      const db = new DatabaseSync(temp.indexPath);
      db.prepare("UPDATE sections SET heading = 'Retitled.' WHERE citation = '4.130'").run();
      db.close();
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify'], io);
      expect(code).toBe(EXIT.ERROR);
      // The report is still the answer: it is printed, not swallowed.
      expect(out.join('')).toContain('corpus receipt: MISMATCH');
    } finally {
      temp.cleanup();
    }
  });

  it('exits 2 for a missing default index, a missing snapshot and a non-index file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cfr-verify-'));
    try {
      const missing = path.join(dir, 'missing.sqlite');
      const { io: ioMissing } = makeIo({ CFR_INDEX_PATH: missing });
      expect(await main(['verify'], ioMissing)).toBe(EXIT.USAGE);

      const temp = openReceiptedStore();
      try {
        const { err: errSnap, io: ioSnap } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
        expect(await main(['verify', path.join(dir, 'no-such.sqlite')], ioSnap)).toBe(EXIT.USAGE);
        expect(errSnap.join('')).toMatch(/no index or snapshot/);

        const foreign = path.join(dir, 'foreign.sqlite');
        const db = new DatabaseSync(foreign);
        db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
        db.close();
        const { io: ioForeign } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
        expect(await main(['verify', foreign], ioForeign)).toBe(EXIT.USAGE);
      } finally {
        temp.cleanup();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies a snapshot positionally and leaves the file byte-for-byte unchanged', async () => {
    const temp = openReceiptedStore();
    const snapshot = path.join(temp.dir, 'backup.sqlite');
    try {
      temp.store.backupTo(snapshot);
      const before = sha256(snapshot);
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify', snapshot], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain(`verified ${snapshot}`);
      expect(out.join('')).toContain('corpus receipt: match');
      expect(sha256(snapshot)).toBe(before);
    } finally {
      temp.cleanup();
    }
  });

  it('verifies committed WAL data while a writer has an uncommitted change', async () => {
    const temp = openReceiptedStore();
    try {
      const writer = new DatabaseSync(temp.indexPath);
      try {
        writer.exec("BEGIN IMMEDIATE; UPDATE meta SET value = 'pending' WHERE key = 'corpus_hash'");
        const wal = `${temp.indexPath}-wal`;
        expect(statSync(wal).size).toBeGreaterThan(0);
        const before = sha256(temp.indexPath);
        const walBefore = sha256(wal);
        const mode = statSync(temp.indexPath).mode;
        const files = readdirSync(temp.dir);
        const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
        expect(await main(['verify'], io)).toBe(EXIT.OK);
        expect(out.join('')).toContain('3 sections + 1 appendices');
        expect(out.join('')).toContain('corpus receipt: match');
        expect(sha256(temp.indexPath)).toBe(before);
        expect(sha256(wal)).toBe(walBefore);
        expect(statSync(temp.indexPath).mode).toBe(mode);
        expect(readdirSync(temp.dir)).toEqual(files);
        expect(await main(['verify', temp.indexPath], io)).toBe(EXIT.USAGE);
      } finally {
        writer.close();
      }
    } finally {
      temp.cleanup();
    }
  });

  it("verifies a snapshot against its OWN receipt, not the live index's", async () => {
    // The positional path is the subject: an older stored snapshot must
    // verify against the receipt recorded with ITS rows, even when the live
    // index holds different ones.
    const temp = openReceiptedStore();
    const snapshot = path.join(temp.dir, 'older.sqlite');
    try {
      const older = FIXTURE_SECTIONS.map((section) =>
        makeSection({ ...section, citation: section.citation }),
      );
      const olderStore = openTempStore({ sections: older, issueDate: '2026-01-01' });
      try {
        // The snapshot records its own receipt for its own rows.
        olderStore.store.setMeta(
          'corpus_hash',
          corpusHash(olderStore.store.snapshotTextHashes(38)),
        );
        olderStore.store.backupTo(snapshot);
      } finally {
        olderStore.cleanup();
      }
      const { out, io } = makeIo({ CFR_INDEX_PATH: temp.indexPath });
      const code = await main(['verify', snapshot], io);
      expect(code).toBe(EXIT.OK);
      expect(out.join('')).toContain('corpus receipt: match');
      expect(out.join('')).toContain('issue date: 2026-01-01');
    } finally {
      temp.cleanup();
    }
  });
});
