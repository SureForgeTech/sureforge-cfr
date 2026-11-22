import path from 'node:path';
import type { AppConfig } from '../config.js';
import { CORPUS_RECEIPT_LIMIT, corpusHash } from '../core/changes.js';
import { ServiceError } from '../core/errors.js';
import { inspectPathShape } from '../core/path-shape.js';
import { DEFAULT_TITLE, Store } from '../core/store.js';
import type { Logger } from '../logger.js';

/**
 * `cfr-free verify [snapshot]` — prove whether the local index, or a stored
 * snapshot of it, is internally usable and whether the corpus receipt it
 * records still describes its current Title 38 rows.
 *
 * An explicit snapshot uses the immutable evidence path shared with offline
 * snapshot comparison. The configured index uses a read-only SQLite
 * connection that includes committed WAL data. SQLite may update the -shm
 * sidecar or create missing WAL/SHM sidecars. Both modes leave the main
 * database file and its permissions intact.
 *
 * Exit policy (enforced by the CLI dispatch, `src/cli.ts`): a readable index
 * reports and exits 0, INCLUDING when it records no receipt — the absent
 * case is reported plainly, not hidden. An unreadable, missing or non-index
 * input is an `invalid_input` failure, which the CLI's existing mapping
 * turns into exit 2 (usage). A readable file whose recorded receipt
 * MISMATCHES the receipt recomputed from its current rows answers "is this
 * the copy the receipt describes?" with "no": that is the command's finding,
 * so the report is still printed and the exit code is 1 (`EXIT.ERROR` — no
 * new exit code).
 *
 * The file is checked BEFORE it is opened: SQLite's open is synchronous and
 * blocks on a FIFO, so a directory, a device or a FIFO is refused as a usage
 * mistake instead of hanging the command.
 */

/** The receipt verdict: the recorded hash is gone, agrees, or disagrees. */
export type CorpusReceiptStatus = 'match' | 'mismatch' | 'absent';

export interface VerifyReport {
  /** The file verified (the configured index path or the resolved snapshot). */
  readonly path: string;
  /** Title 38 sections in the file. */
  readonly sections: number;
  /** Title 38 appendices in the file. */
  readonly appendices: number;
  /**
   * The recorded eCFR issue date (per-title `title.38.issue_date`, legacy
   * `issue_date` as fallback), or null when the file records none.
   */
  readonly issueDate: string | null;
  /** Whether the recorded receipt still describes the current rows. */
  readonly receipt: CorpusReceiptStatus;
  /** The Title 38 corpus receipt, with the legacy `corpus_hash` as fallback. */
  readonly recordedCorpusHash: string | null;
  /** The receipt recomputed from the store's current Title 38 rows. */
  readonly recomputedCorpusHash: string;
}

/**
 * A missing/unreadable/non-index input is the reader's mistake, not a finding.
 *
 * The message is FIXED guidance: the resolved path and the underlying
 * store/SQLite detail go to the structured log, not to the reader's line.
 * A verification runs on evidence the reader may share, and the guidance
 * they need is what to do next — not the server's directory layout.
 */
function refuse(detail: string): ServiceError {
  return new ServiceError(detail, 'invalid_input');
}

/**
 * Verify the index at `config.indexPath`, or the stored snapshot at
 * `snapshot`. Never creates or repairs the file; see the module doc comment.
 *
 * @throws {ServiceError} (`invalid_input`) when the path is missing, cannot
 *   be read, is not a regular file, or cannot be opened as a current-schema
 *   cfr-free index.
 */
export function runVerifyCommand(
  config: AppConfig,
  logger: Logger,
  snapshot?: string,
): VerifyReport {
  const resolved = snapshot === undefined ? config.indexPath : path.resolve(snapshot);
  // The file is handed to SQLite, whose SYNCHRONOUS open BLOCKS on a FIFO:
  // the reader would wait forever for a writer that never comes. The shape
  // of the path is therefore decided BEFORE the open, and it tells "not
  // there" from "cannot be read" — `existsSync` answers false for both.
  const shape = inspectPathShape(resolved);
  if (shape.kind === 'missing') {
    logger.warn('verification found no file', { path: resolved });
    throw refuse(
      'no index or snapshot here — run `cfr-free sync` first, or store a snapshot with `cfr-free export <path>`',
    );
  }
  if (shape.kind === 'unreadable') {
    logger.warn('verification could not inspect the file', {
      path: resolved,
      detail: shape.detail,
    });
    throw refuse('cannot be read — it must be a readable cfr-free index file');
  }
  if (shape.kind === 'not-a-regular-file') {
    logger.warn('verification refused a file that is not a regular file', { path: resolved });
    throw refuse('not a regular file — it must be a cfr-free index file');
  }
  let store: Store;
  try {
    store = Store.open(resolved, { readOnly: snapshot === undefined ? 'live' : true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn('verification refused the file', { path: resolved, detail });
    throw refuse('cannot open as a cfr-free index — the file is not a cfr-free index');
  }
  try {
    // ONE read snapshot for the whole verification: the counts, the
    // metadata and the row hashes must all describe the SAME revision.
    // Without it a sync committing between two statements could make a
    // valid index report a receipt mismatch — or make a corrupt one look
    // fine. A deferred transaction pins one revision without blocking the
    // writer (WAL).
    const report = store.readSnapshot(() => {
      // The open itself ran PRAGMA quick_check (see Store.open) and
      // checked the schema objects, so reaching here means the file is a
      // structurally sound cfr-free index.
      const { sections, appendices } = store.countProvisions(DEFAULT_TITLE);
      // Per-title key first (multi-title indexes), the legacy key as fallback
      // for indexes built before it existed — the same resolution the offline
      // snapshot comparison uses.
      const issueDate =
        store.getMeta(`title.${DEFAULT_TITLE}.issue_date`) ?? store.getMeta('issue_date');
      // The receipt recomputed from the rows the file holds right now.
      const recomputedCorpusHash = corpusHash(store.snapshotTextHashes(DEFAULT_TITLE));
      const recordedCorpusHash =
        store.getMeta(`title.${DEFAULT_TITLE}.corpus_hash`) ?? store.getMeta('corpus_hash');
      const receipt: CorpusReceiptStatus =
        recordedCorpusHash === null
          ? 'absent'
          : recordedCorpusHash === recomputedCorpusHash
            ? 'match'
            : 'mismatch';
      return {
        sections,
        appendices,
        issueDate,
        receipt,
        recordedCorpusHash,
        recomputedCorpusHash,
      };
    });
    logger.info('index verified', {
      path: resolved,
      sections: report.sections,
      appendices: report.appendices,
      issueDate: report.issueDate,
      receipt: report.receipt,
    });
    return {
      path: resolved,
      sections: report.sections,
      appendices: report.appendices,
      issueDate: report.issueDate,
      receipt: report.receipt,
      recordedCorpusHash: report.recordedCorpusHash,
      recomputedCorpusHash: report.recomputedCorpusHash,
    };
  } catch (error) {
    // A failure INSIDE the read (a missing table, a corrupt row) is the
    // reader's input, not a service fault: it exits 2 with actionable
    // guidance rather than a generic error.
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn('verification could not read the file', { path: resolved, detail });
    throw refuse('cannot read the file as a cfr-free index');
  } finally {
    store.close();
  }
}

/** Render a verification report for stdout: concise human text. */
export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [
    `verified ${report.path}`,
    '  schema: ok (quick_check passed)',
    `  provisions: ${report.sections} sections + ${report.appendices} appendices (Title 38)`,
    `  issue date: ${report.issueDate ?? 'none recorded'}`,
  ];
  if (report.receipt === 'match') {
    lines.push(
      '  corpus receipt: match — the recorded hash equals the receipt recomputed from the ' +
        'current Title 38 rows',
    );
  } else if (report.receipt === 'mismatch') {
    lines.push(
      '  corpus receipt: MISMATCH — the recorded receipt does not describe these rows',
      `    recorded:   ${report.recordedCorpusHash ?? ''}`,
      `    recomputed: ${report.recomputedCorpusHash}`,
    );
  } else {
    lines.push(
      '  corpus receipt: absent — the file records no corpus_hash, so the rows can be read ' +
        'but whether they are the ones a sync wrote cannot be concluded either way',
      `    recomputed from the current rows: ${report.recomputedCorpusHash}`,
    );
  }
  lines.push(`  note: ${CORPUS_RECEIPT_LIMIT}.`);
  return `${lines.join('\n')}\n`;
}
