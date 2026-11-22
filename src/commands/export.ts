import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { CommandError, EXIT } from '../exit-codes.js';
import type { Logger } from '../logger.js';
import { Store } from '../core/store.js';
import type { SectionRow } from '../core/store.js';
import { DEFAULT_TITLE } from '../core/titles.js';

/** Optional export formats; the format-less default is the sqlite snapshot. */
export type ExportOutputFormat = 'jsonl' | 'md';

export interface ExportReport {
  readonly path: string;
  readonly bytes: number;
  /** Which writer produced the file (the default writer is the sqlite snapshot). */
  readonly format: 'sqlite' | 'jsonl' | 'md';
  /** Provisions (sections + appendices) written to the file. */
  readonly provisions: number;
}

/**
 * One compact JSON line per provision, fields in the wire's SectionDetail
 * order (plus subchapter/subjectGroup/title) — insertion order here is the
 * line's key order, so the shape stays stable for pipeline consumers.
 *
 * `title` is in the line because the store can hold more than one CFR
 * title: without it a pipeline consumer would read Title 32 and Title 38
 * provisions as one undifferentiated corpus.
 */
function toJsonlLine(row: SectionRow): string {
  return `${JSON.stringify({
    citation: row.citation,
    kind: row.kind,
    title: row.title,
    heading: row.heading,
    chapter: row.chapter,
    subchapter: row.subchapter,
    part: row.part,
    subpart: row.subpart,
    subjectGroup: row.subjectGroup,
    path: row.path,
    issueDate: row.issueDate,
    text: row.text,
    markdown: row.markdown,
  })}\n`;
}

/**
 * Write every provision as JSONL (compact lines, one object per line,
 * trailing newline at EOF) and return the row count.
 *
 * Chunk array + ONE `writeFileSync`, deliberately over a write stream: at
 * Title 38 scale the whole document is ~20 MB (measured: 2 970 rows,
 * ~16 MB of text+markdown), so the peak stays ~3× the corpus (rows +
 * chunks + joined string ≈ 60 MB) — within the accepted envelope — while a
 * single write keeps the failure mode simple (no half-written stream to
 * reconcile with the refuse-to-overwrite contract). No pretty-printing:
 * compact lines are the ingest contract.
 */
function writeJsonl(store: Store, target: string): number {
  const rows = store.allSections();
  const chunks: string[] = rows.map(toJsonlLine);
  writeExclusive(target, chunks.join(''));
  return rows.length;
}

/**
 * The issue date one title was recorded at.
 *
 * The per-title key (`title.<N>.issue_date`) is the title's own. The legacy
 * global `issue_date` key is Title 38's date — and only Title 38's, so it
 * is the fallback for Title 38 alone: a document holding another title must
 * not be dated with Title 38's revision.
 *
 * This is the RECORDED date, the same one `cfr-free verify` reports: a title
 * whose rows exist but whose meta records none is dated "unknown", not with
 * a date read out of the rows.
 */
function titleIssueDate(store: Store, title: number): string {
  const perTitle = store.getMeta(`title.${title}.issue_date`);
  if (perTitle !== null) return perTitle;
  return title === DEFAULT_TITLE ? (store.getMeta('issue_date') ?? 'unknown') : 'unknown';
}

/**
 * "Titles 12 and 38" for two titles, "Titles 12, 32 and 38" for three.
 *
 * The list holds at least two titles here — the empty and single-title
 * documents are answered before this is called — so `slice` keeps both ends
 * non-empty and neither can be undefined.
 */
function titleList(titles: readonly number[]): string {
  return `Titles ${titles.slice(0, -1).join(', ')} and ${titles.slice(-1).join(', ')}`;
}

/**
 * The Markdown document header: the titles the document holds, and the date
 * each of them was recorded at.
 *
 * The export writes EVERY stored title's rows, so a header that named one
 * title — and one date — would describe a multi-title document as a single
 * revision. The titles come from the rows themselves.
 *
 * A single-title document keeps the header it has always had, byte for byte:
 * a pipeline consumer may parse it.
 */
function markdownHeader(store: Store, rows: readonly SectionRow[]): string {
  const titles = [...new Set(rows.map((row) => row.title))].sort((a, b) => a - b);
  const first = titles[0];
  if (first === undefined) {
    // No rows: there is no title to name, so the legacy line stands.
    return `# Code of Federal Regulations — Title ${DEFAULT_TITLE} (issue date: ${
      store.getMeta('issue_date') ?? 'unknown'
    })\n`;
  }
  if (titles.length === 1) {
    return `# Code of Federal Regulations — Title ${first} (issue date: ${titleIssueDate(
      store,
      first,
    )})\n`;
  }
  const dates = titles.map((title) => `${title} = ${titleIssueDate(store, title)}`).join(', ');
  return `# Code of Federal Regulations — ${titleList(titles)} (issue dates: ${dates})\n`;
}

/**
 * Write one Markdown document: a header naming every title the document
 * holds, each with that title's recorded issue date, then each provision as
 * a `## {citation} — {heading}` section with its `text` verbatim (never
 * fenced, never reflowed) and a `---` separator. Returns the row count.
 *
 * Same chunk-array + single-write choice (and peak) as {@link writeJsonl}.
 */
function writeMarkdown(store: Store, target: string): number {
  const rows = store.allSections();
  const chunks: string[] = [markdownHeader(store, rows)];
  for (const row of rows) {
    // Exactly one newline joins text to the separator: append only when the
    // stored text does not already end in one (verbatim either way).
    const body = row.text.endsWith('\n') ? row.text : `${row.text}\n`;
    // The heading names the authority when the row is not Title 38's, so a
    // multi-title export never presents Title 32 provisions under a Title
    // 38 heading.
    const label =
      row.title === DEFAULT_TITLE ? row.citation : `${row.citation} (Title ${row.title})`;
    chunks.push(`\n## ${label} — ${row.heading}\n${body}\n---\n`);
  }
  writeExclusive(target, chunks.join(''));
  return rows.length;
}

/**
 * Snapshot the index to `target` without ever following or replacing
 * whatever is at that path. SQLite's `VACUUM INTO` opens its output by name,
 * so a symlink planted after the existence check would be written through.
 * Write a private temporary file beside the target instead, then `link` it
 * into place: `link` fails with EEXIST on any existing path, a symlink
 * included, at the moment of linking.
 */
function snapshotExclusive(store: Store, target: string): void {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    store.backupTo(temporary);
    try {
      linkSync(temporary, target);
    } catch (error) {
      throw refusedIfExists(error, target);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // never created, or already gone
    }
  }
}

function writeExclusive(target: string, text: string): void {
  try {
    writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw refusedIfExists(error, target);
  }
}

/** An EEXIST from an exclusive create is the refusal contract, not a crash. */
function refusedIfExists(error: unknown, target: string): unknown {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    return new CommandError(
      `refusing to overwrite existing file: ${target} — remove it first`,
      EXIT.REFUSED,
    );
  }
  return error;
}

/** Whether anything, a dangling symlink included, is at `target`. */
function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * `cfr-free export <path> [jsonl|md]` — write a consistent export of the
 * local index.
 *
 * Default: SQLite `VACUUM INTO`, which includes WAL content, so the copy is
 * a point-in-time image safe to copy elsewhere. Optional `jsonl`/`md`
 * re-serialize the SAME store's rows for pipeline ingestion. Never
 * overwrites: the target must not exist, and the source index must.
 *
 * @param format omit for the sqlite snapshot (unchanged default behavior).
 * @throws {CommandError} exit 3 when there is no index; exit 5 when the
 *   target already exists (a deliberate refusal, not a usage error).
 */
export function runExportCommand(
  config: AppConfig,
  target: string,
  logger: Logger,
  format?: ExportOutputFormat,
): ExportReport {
  if (!existsSync(config.indexPath)) {
    throw new CommandError(
      `no index at ${config.indexPath} — run \`cfr-free sync\` first`,
      EXIT.INDEX_UNAVAILABLE,
    );
  }
  // `lstat`, not `existsSync`: a dangling symlink "does not exist" to
  // `existsSync`, and the write that follows would create the file it points
  // at, wherever that is. The writers below create exclusively (`wx`, or
  // `link` for the snapshot), which refuses an existing path (symlink
  // included) at the moment of writing.
  if (pathExists(target)) {
    throw new CommandError(
      `refusing to overwrite existing file: ${target} — remove it first`,
      EXIT.REFUSED,
    );
  }

  // STRICT open (no allowSchemaUpgrade): the read-only export path never
  // adopts a schema, same contract as the diff command.
  const store = Store.open(config.indexPath);
  let provisions: number;
  try {
    if (format === undefined) {
      snapshotExclusive(store, target);
      provisions = store.countAllSections();
    } else if (format === 'jsonl') {
      provisions = writeJsonl(store, target);
    } else {
      provisions = writeMarkdown(store, target);
    }
  } finally {
    store.close();
  }
  const bytes = statSync(target).size;
  const reportFormat: ExportReport['format'] = format ?? 'sqlite';
  logger.info('index exported', { target, bytes, format: reportFormat, provisions });
  return { path: target, bytes, format: reportFormat, provisions };
}
