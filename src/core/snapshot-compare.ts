import path from 'node:path';
import type { Logger } from '../logger.js';
import { CHANGE_LIST_CAP, diffHashes } from './changes.js';
import { assertIssueDate } from './diff.js';
import { ServiceError } from './errors.js';
import { inspectPathShape } from './path-shape.js';
import { lcsHunks, presenceHunks, splitRedlineLines, type Hunk } from './redline.js';
import { DEFAULT_TITLE, Store, type SectionRow } from './store.js';
import { datedSourceUrlFor } from './urls.js';
import { IMAGE_MARKER_PREFIX } from './xml.js';

/**
 * Offline comparison of two STORED snapshots of the index: "what was added,
 * removed or changed in Title 38 between the revision this file holds and
 * the revision that one holds?". A snapshot is any cfr-free index file —
 * typically a copy kept with `cfr-free export <path>` — and each records the
 * eCFR issue date it was built from, so the two dates the comparison reports
 * are RECORDED dates, not selectors.
 *
 * This is the offline counterpart of the `diff_issues` MCP tool: that one
 * fetches both revisions from the live versioner on demand and reports
 * citation lists only; this one reads two files the operator already stored,
 * works with no network access and no eCFR client, and carries a short
 * line-level summary, the hierarchy path and a dated source URL per change.
 * Obtaining a snapshot stays a separate, explicit step (`cfr-free sync` to
 * refresh the index, `cfr-free export <path>` to store a copy of it).
 */

/** Entries listed per category on the wire; counts beyond the cap set `truncated`. */
export const SNAPSHOT_CHANGE_CAP = CHANGE_LIST_CAP;

/**
 * One character budget over the whole comparison response.
 *
 * The per-list cap ({@link SNAPSHOT_CHANGE_CAP}) and the per-entry text bounds
 * keep any ONE entry small; nothing bounded the RESPONSE. Three lists of 100
 * entries, each carrying a bounded summary, was around a megabyte of
 * structured payload — and about twice that on the wire, because the text
 * channel renders the same information again.
 *
 * The budget is split into three equal shares, one per category, so every
 * category is represented: a comparison of two wholesale rebuilds still shows
 * what was added, what was removed and what changed, each within its share. A
 * share that is not spent is not lent to the others, so the bound is the same
 * for every comparison.
 *
 * The FIRST entry of a category is always taken, even when it does not fit
 * (see {@link takeWithinBudget}): a category is never empty, so its count is
 * never a false zero. The response can therefore exceed the budget by up to
 * one such entry per category — three in all.
 */
export const SNAPSHOT_RESPONSE_CHAR_BUDGET = 200_000;

/** One category's share of {@link SNAPSHOT_RESPONSE_CHAR_BUDGET}. */
const CATEGORY_CHAR_BUDGET = Math.floor(SNAPSHOT_RESPONSE_CHAR_BUDGET / 3);

/** Changed lines shown in one entry's summary; more set the summary's `truncated` flag. */
export const SUMMARY_HUNK_CAP = 10;

/** Per-hunk character bound; a provision line can approach the parser's whole-section cap. */
const SUMMARY_HUNK_CHARS = 1_000;

/** Per-entry character bound across the shown hunks. */
const SUMMARY_TOTAL_CHARS = 2_500;

/** Per-side character bound of a coarse summary block (a provision over the line LCS cap). */
const SUMMARY_BLOCK_CHARS = 1_000;

/**
 * Per-side line cap for the comparison's changed-lines summary.
 *
 * The redline's own cap is 2,000 lines per side, and the line identity it
 * computes is quadratic: measured on this machine an LCS over two 2,000-line
 * sides takes ~12 ms and allocates an 8 MB table, while one over two
 * 500-line sides takes ~1 ms. The entry cap lets a comparison show ~100
 * entries per category, so the redline's cap would still mean around a
 * second of SYNCHRONOUS work on the server's own thread for one tool call.
 *
 * The comparison is a summary, not a redline: a provision over this cap falls
 * back to the same coarse excerpt the redline uses — two clipped blocks, one
 * per side — and claims no per-line identity.
 */
export const SUMMARY_MAX_LINES = 500;

/**
 * Per-entry bound on a heading.
 *
 * The corpus bounds a provision's TEXT but not its HEADING, so a heading can
 * be as long as a section's text. The comparison is a summary surface: a
 * heading is a title, and a heading bound keeps the entry a summary can
 * carry. (An entry can still exceed a category share — the corpus does not
 * bound a citation or a hierarchy path either.)
 */
export const HEADING_CHARS = 1_000;

/**
 * Clip a heading at the bound; a cut heading is marked with an ellipsis.
 *
 * Two headings that share their first {@link HEADING_CHARS} characters clip
 * to the SAME string, even though they differ: a retitle whose difference
 * lies beyond the bound is then visible only as `headingChanged`, which is
 * decided on the RAW headings. The wire says so, and so does the CLI.
 */
function clipHeading(heading: string): string {
  return heading.length <= HEADING_CHARS ? heading : `${heading.slice(0, HEADING_CHARS)}…`;
}

/** One side of the comparison: the file and the issue date it records. */
export interface SnapshotSide {
  /** The snapshot file, as the caller named it (never the resolved path). */
  readonly path: string;
  /** The eCFR issue date recorded in the snapshot's meta (its revision stamp). */
  readonly issueDate: string;
}

/** The short line-level difference attached to one change entry. */
export interface ChangeSummary {
  /**
   * The differing lines (never 'same' entries). Anchors are 1-based line
   * numbers into that side's text; `null` marks the side the line is absent
   * from. A provision over the comparison's line cap
   * ({@link SUMMARY_MAX_LINES}) on either side falls back to two excerpt
   * blocks (from-side deletion, to-side addition).
   */
  readonly hunks: readonly Hunk[];
  /** True when differing lines exist that the summary does not show. */
  readonly truncated: boolean;
}

/** One provision that differs between the two snapshots. */
export interface SnapshotChange {
  readonly citation: string;
  readonly kind: 'section' | 'appendix';
  /**
   * The heading at the to-side (the only side for an added provision),
   * bounded at {@link HEADING_CHARS} characters — a cut heading ends with an
   * ellipsis.
   */
  readonly heading: string;
  /**
   * True when the heading differs across the two snapshots (a retitle).
   *
   * Decided on the RAW headings, so it stays true when the difference lies
   * beyond the heading bound and the two clipped headings are identical.
   */
  readonly headingChanged: boolean;
  /**
   * The from-side heading when `headingChanged`, else null. Bounded like
   * {@link heading}, and therefore identical to it when the difference lies
   * beyond the bound.
   */
  readonly previousHeading: string | null;
  /** The authority hierarchy the provision sits in (to-side; from-side for a removal). */
  readonly chapter: string | null;
  readonly part: string | null;
  readonly subpart: string | null;
  readonly path: string;
  /** Both snapshots' recorded issue dates — the two revisions being compared. */
  readonly fromIssueDate: string;
  readonly toIssueDate: string;
  /** The dated eCFR permalink at the from-side revision; null for an addition. */
  readonly fromSourceUrl: string | null;
  /** The dated eCFR permalink at the to-side revision; null for a removal. */
  readonly toSourceUrl: string | null;
  /**
   * True when either side's text carries an image-content marker: the
   * provision's rating-table graphics are not in the text, so the summary
   * (like the stored text itself) is not complete coverage.
   */
  readonly imageContent: boolean;
  readonly summary: ChangeSummary;
}

/** The comparison result: three sorted category lists plus both sides' identities. */
export interface SnapshotComparison {
  readonly from: SnapshotSide;
  readonly to: SnapshotSide;
  /** The part filter the comparison ran under, or null for the whole title. */
  readonly part: string | null;
  readonly added: readonly SnapshotChange[];
  readonly removed: readonly SnapshotChange[];
  readonly changed: readonly SnapshotChange[];
  /**
   * True when any category list was cut — at the entry cap
   * ({@link SNAPSHOT_CHANGE_CAP}) or at the response budget
   * ({@link SNAPSHOT_RESPONSE_CHAR_BUDGET}).
   */
  readonly truncated: boolean;
}

/**
 * Take entries while the category's character budget lasts.
 *
 * An entry's cost is its JSON size: the same bytes the structured payload
 * carries (the text channel renders the same information, so the wire carries
 * roughly twice this).
 *
 * The FIRST entry of a category is always taken, even when it does not fit:
 * the corpus bounds a provision's text but not its citation, heading or
 * hierarchy path, so one pathological entry can be larger than a whole
 * share. Dropping it would leave the category EMPTY, and an empty category
 * reports a count of zero for changes that exist — a wrong answer, told as
 * "0 added". One entry over the budget is a cost worth paying; a false count
 * is not.
 */
function takeWithinBudget(
  citations: readonly string[],
  build: (citation: string) => SnapshotChange,
): { readonly entries: SnapshotChange[]; readonly cut: boolean } {
  const entries: SnapshotChange[] = [];
  let spent = 0;
  for (const citation of citations) {
    const entry = build(citation);
    const cost = JSON.stringify(entry).length;
    if (entries.length > 0 && spent + cost > CATEGORY_CHAR_BUDGET) {
      return { entries, cut: true };
    }
    spent += cost;
    entries.push(entry);
  }
  return { entries, cut: false };
}

/** Cut a coarse summary block at the character bound, on a nearby line boundary. */
function clipBlock(text: string): string {
  if (text.length <= SUMMARY_BLOCK_CHARS) return text;
  const cut = text.slice(0, SUMMARY_BLOCK_CHARS);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > SUMMARY_BLOCK_CHARS / 2 ? cut.slice(0, lastBreak) : cut;
}

/** Bound one provision summary: per-hunk, then a total budget across the shown hunks. */
function boundedHunks(hunks: readonly Hunk[], alreadyTruncated: boolean): ChangeSummary {
  const bounded: Hunk[] = [];
  let used = 0;
  let truncated = alreadyTruncated;
  for (const hunk of hunks) {
    let text = hunk.text;
    if (text.length > SUMMARY_HUNK_CHARS) {
      text = `${text.slice(0, SUMMARY_HUNK_CHARS)}…`;
      truncated = true;
    }
    if (bounded.length > 0 && used + text.length > SUMMARY_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    bounded.push({ ...hunk, text });
    used += text.length;
  }
  return { hunks: bounded, truncated };
}

/** The summary of a provision present on only one side: an excerpt of its lines. */
function presenceSummary(text: string, presentSide: 'from' | 'to'): ChangeSummary {
  const lines = splitRedlineLines(text);
  return boundedHunks(
    presenceHunks(lines.slice(0, SUMMARY_HUNK_CAP), presentSide),
    lines.length > SUMMARY_HUNK_CAP,
  );
}

/** The summary of a provision present on both sides with differing content. */
function changedSummary(fromText: string, toText: string): ChangeSummary {
  // A RETITLE with an unchanged body: the change list holds it (the heading
  // is part of the change hash) but no line differs, so the summary is empty
  // — above the line cap exactly as below it. The coarse fallback below
  // would otherwise report the whole body as deleted and re-added, and
  // claim that differing lines were left out when there are none.
  if (fromText === toText) return boundedHunks([], false);
  const fromLines = splitRedlineLines(fromText);
  const toLines = splitRedlineLines(toText);
  if (fromLines.length > SUMMARY_MAX_LINES || toLines.length > SUMMARY_MAX_LINES) {
    // Over the comparison's line cap: no per-line identity is claimed — the
    // summary carries one excerpt block per side, the redline's coarse shape
    // cut to a short bound.
    return boundedHunks(
      [
        { fromLine: 1, toLine: null, type: 'del', text: clipBlock(fromText) },
        { fromLine: null, toLine: 1, type: 'add', text: clipBlock(toText) },
      ],
      true,
    );
  }
  const differing = lcsHunks(fromLines, toLines).filter((hunk) => hunk.type !== 'same');
  return boundedHunks(differing.slice(0, SUMMARY_HUNK_CAP), differing.length > SUMMARY_HUNK_CAP);
}

/**
 * The from-side input a change entry needs: its row (absent for an addition)
 * plus the snapshot's recorded issue date.
 */
interface SideContext {
  readonly issueDate: string;
  readonly row: SectionRow | null;
}

/** Build an added/removed entry: the row on the present side, with an excerpt of its text. */
function presenceChange(
  citation: string,
  from: SideContext,
  to: SideContext,
  status: 'added' | 'removed',
): SnapshotChange {
  const present = status === 'added' ? to.row : from.row;
  if (present === null) {
    // Unreachable: diffHashes reports an addition/removal only for a
    // citation present on exactly one side.
    throw new Error(`snapshot comparison lost the row for ${citation}`);
  }
  return {
    citation,
    kind: present.kind,
    heading: clipHeading(present.heading),
    headingChanged: false,
    previousHeading: null,
    chapter: present.chapter,
    part: present.part,
    subpart: present.subpart,
    path: present.path,
    fromIssueDate: from.issueDate,
    toIssueDate: to.issueDate,
    fromSourceUrl:
      status === 'added' ? null : datedSourceUrlFor(citation, present.kind, from.issueDate),
    toSourceUrl:
      status === 'added' ? datedSourceUrlFor(citation, present.kind, to.issueDate) : null,
    imageContent: present.text.includes(IMAGE_MARKER_PREFIX),
    summary: presenceSummary(present.text, status === 'added' ? 'to' : 'from'),
  };
}

/** Build a changed entry: both rows, a changed-lines summary, retitle surfaced. */
function changedChange(citation: string, from: SideContext, to: SideContext): SnapshotChange {
  if (from.row === null || to.row === null) {
    // Unreachable: diffHashes reports a change only for a citation present
    // on both sides.
    throw new Error(`snapshot comparison lost a side for ${citation}`);
  }
  const headingChanged = from.row.heading !== to.row.heading;
  return {
    citation,
    kind: to.row.kind,
    heading: clipHeading(to.row.heading),
    headingChanged,
    previousHeading: headingChanged ? clipHeading(from.row.heading) : null,
    chapter: to.row.chapter,
    part: to.row.part,
    subpart: to.row.subpart,
    path: to.row.path,
    fromIssueDate: from.issueDate,
    toIssueDate: to.issueDate,
    fromSourceUrl: datedSourceUrlFor(citation, to.row.kind, from.issueDate),
    toSourceUrl: datedSourceUrlFor(citation, to.row.kind, to.issueDate),
    imageContent:
      from.row.text.includes(IMAGE_MARKER_PREFIX) || to.row.text.includes(IMAGE_MARKER_PREFIX),
    summary: changedSummary(from.row.text, to.row.text),
  };
}

/**
 * Open one snapshot for reading, refusing anything that is not a regular file.
 *
 * A snapshot is a FILE the operator stored with `cfr-free export`. Anything
 * else — a directory, a device, a FIFO — is refused BEFORE SQLite sees it:
 * opening a FIFO with the synchronous driver blocks the open forever, so one
 * tool call would freeze the whole stdio server.
 *
 * Every failure here is CLIENT-SAFE (SPEC §7): the message names the side and
 * what to do, never the server's path and never raw SQLite text. The detail
 * goes to the server log.
 */
function openSnapshot(resolved: string, label: string, logger: Logger): Store {
  const shape = inspectPathShape(resolved);
  if (shape.kind === 'missing') {
    throw new ServiceError(
      `the ${label} snapshot does not exist — store one first with \`cfr-free export <path>\``,
      'invalid_input',
    );
  }
  if (shape.kind === 'unreadable') {
    // The file cannot be inspected at all (its directory cannot be read, it
    // vanished): the detail is for the log, the client gets guidance.
    logger.error('snapshot could not be inspected', {
      side: label,
      message: shape.detail,
    });
    throw new ServiceError(
      `the ${label} snapshot could not be read — it must be a readable cfr-free index file`,
      'invalid_input',
    );
  }
  if (shape.kind === 'not-a-regular-file') {
    throw new ServiceError(
      `the ${label} snapshot is not a regular file — a snapshot must be a cfr-free index file`,
      'invalid_input',
    );
  }
  try {
    // STRICT, read-only open (no creation, journal-mode rewrite, schema
    // creation, or upgrade), same adoption contract as export: a comparison
    // never repairs or alters the files it reads.
    return Store.open(resolved, { readOnly: true });
  } catch (error) {
    // The raw SQLite text (and the path it names) stays in the log; the
    // client receives guidance it can act on.
    logger.error('snapshot could not be opened', {
      side: label,
      message: error instanceof Error ? error.message : String(error),
    });
    throw new ServiceError(
      `the ${label} snapshot could not be opened — it must be a cfr-free index file ` +
        '(store one with `cfr-free export <path>`)',
      'invalid_input',
    );
  }
}

/** The recorded issue date of a snapshot, rejecting files that record none. */
function snapshotIssueDate(store: Store, label: string): string {
  // Per-title key first (multi-title indexes), the legacy key as fallback
  // for snapshots stored before it existed.
  const issueDate =
    store.getMeta(`title.${DEFAULT_TITLE}.issue_date`) ?? store.getMeta('issue_date');
  if (issueDate === null) {
    throw new ServiceError(
      `the ${label} snapshot records no issue date — it is not a synced cfr-free index`,
      'invalid_input',
    );
  }
  return assertIssueDate(issueDate, `the ${label} snapshot's recorded issue date`);
}

/**
 * Compare two stored snapshots of the Title 38 index and report the
 * provision-level differences. Fully offline: both files are opened
 * read-only (strict schema) and nothing is fetched or written.
 *
 * @throws {ServiceError} (`invalid_input`) when a path is missing, names the
 *   same file on both sides, names something that is not a regular file, names
 *   a file that is not a cfr-free snapshot, or names a snapshot that records
 *   no issue date. Every message names the side and what to do — never the
 *   server's path, never raw SQLite text (SPEC §7).
 */
export function compareSnapshots(
  deps: { readonly logger: Logger },
  fromPath: string,
  toPath: string,
  options: { readonly part?: string | undefined } = {},
): SnapshotComparison {
  const fromResolved = path.resolve(fromPath);
  const toResolved = path.resolve(toPath);
  if (fromResolved === toResolved) {
    throw new ServiceError(
      'from and to snapshots are the same file — pass two different snapshots',
      'invalid_input',
    );
  }
  const fromStore = openSnapshot(fromResolved, 'from', deps.logger);
  try {
    const toStore = openSnapshot(toResolved, 'to', deps.logger);
    try {
      const part = options.part ?? null;
      const fromIssueDate = snapshotIssueDate(fromStore, 'from');
      const toIssueDate = snapshotIssueDate(toStore, 'to');
      if (fromIssueDate > toIssueDate) {
        throw new ServiceError(
          `from snapshot records ${fromIssueDate}, after the to snapshot's ${toIssueDate} — pass the earlier stored snapshot as from_snapshot`,
          'invalid_input',
        );
      }
      deps.logger.info('comparing stored snapshots', {
        from: fromStore.path,
        to: toStore.path,
        part,
      });

      const diff = diffHashes(
        fromStore.snapshotTextHashes(DEFAULT_TITLE, options.part),
        toStore.snapshotTextHashes(DEFAULT_TITLE, options.part),
      );

      const fromSide = (citation: string): SideContext => ({
        issueDate: fromIssueDate,
        row: fromStore.getProvision(citation),
      });
      const toSide = (citation: string): SideContext => ({
        issueDate: toIssueDate,
        row: toStore.getProvision(citation),
      });

      const capCut =
        diff.changed.length > SNAPSHOT_CHANGE_CAP ||
        diff.added.length > SNAPSHOT_CHANGE_CAP ||
        diff.removed.length > SNAPSHOT_CHANGE_CAP;
      const added = takeWithinBudget(diff.added.slice(0, SNAPSHOT_CHANGE_CAP), (citation) =>
        presenceChange(
          citation,
          { issueDate: fromIssueDate, row: null },
          toSide(citation),
          'added',
        ),
      );
      const removed = takeWithinBudget(diff.removed.slice(0, SNAPSHOT_CHANGE_CAP), (citation) =>
        presenceChange(
          citation,
          fromSide(citation),
          { issueDate: toIssueDate, row: null },
          'removed',
        ),
      );
      const changed = takeWithinBudget(diff.changed.slice(0, SNAPSHOT_CHANGE_CAP), (citation) =>
        changedChange(citation, fromSide(citation), toSide(citation)),
      );
      const budgetCut = added.cut || removed.cut || changed.cut;
      const result: SnapshotComparison = {
        // The paths are the ones the CALLER named, not the resolved ones:
        // a response that repeats the server's absolute paths discloses the
        // server's directory layout to a client that never asked for it.
        from: { path: fromPath, issueDate: fromIssueDate },
        to: { path: toPath, issueDate: toIssueDate },
        part,
        added: added.entries,
        removed: removed.entries,
        changed: changed.entries,
        truncated: capCut || budgetCut,
      };
      deps.logger.info('snapshot comparison computed', {
        changed: diff.changed.length,
        added: diff.added.length,
        removed: diff.removed.length,
        truncated: result.truncated,
      });
      return result;
    } finally {
      toStore.close();
    }
  } finally {
    fromStore.close();
  }
}
