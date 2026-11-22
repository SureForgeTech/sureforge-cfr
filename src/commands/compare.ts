import type { Logger } from '../logger.js';
import {
  compareSnapshots,
  HEADING_CHARS,
  SNAPSHOT_CHANGE_CAP,
  SNAPSHOT_RESPONSE_CHAR_BUDGET,
  type ChangeSummary,
  type SnapshotChange,
  type SnapshotComparison,
} from '../core/snapshot-compare.js';
import type { Hunk } from '../core/redline.js';

/**
 * `cfr-free compare <from_snapshot> <to_snapshot>` — the CLI twin of the
 * offline MCP `compare_snapshots` tool. Both arguments are stored index
 * files (typically copies kept with `cfr-free export <path>`); the comparison
 * itself is the core's read-only, no-network path.
 */
export function runCompareCommand(
  logger: Logger,
  fromPath: string,
  toPath: string,
  options: { readonly part?: string | undefined } = {},
): SnapshotComparison {
  return compareSnapshots({ logger }, fromPath, toPath, options);
}

/** A hunk label that keeps the two 1-based anchors visible without a table. */
function formatHunk(hunk: Hunk): string {
  const mark = hunk.type === 'add' ? '+' : '-';
  const anchor =
    hunk.type === 'add'
      ? `to line ${hunk.toLine ?? '?'}`
      : hunk.type === 'del'
        ? `from line ${hunk.fromLine ?? '?'}`
        : `from line ${hunk.fromLine ?? '?'} → to line ${hunk.toLine ?? '?'}`;
  return `    ${mark} ${anchor}: ${hunk.text.replace(/\r?\n/g, ' ')}`;
}

function formatSources(change: SnapshotChange): string[] {
  return [
    `    from: ${change.fromSourceUrl ?? '(absent)'}`,
    `    to:   ${change.toSourceUrl ?? '(absent)'}`,
  ];
}

function formatSummary(summary: ChangeSummary): string[] {
  const lines = [`  summary${summary.truncated ? ' (truncated)' : ''}:`];
  if (summary.hunks.length === 0) {
    lines.push('    (no text lines differ)');
    return lines;
  }
  for (const hunk of summary.hunks) lines.push(formatHunk(hunk));
  return lines;
}

/**
 * A retitled provision's heading line.
 *
 * A retitle whose difference lies beyond the heading bound clips both sides
 * to the SAME characters, so printing them side by side would show the same
 * string twice and say nothing. The line says where the difference is.
 */
function formatRetitle(change: SnapshotChange): string {
  const previous = change.previousHeading ?? 'unknown';
  if (previous === change.heading) {
    return (
      `${change.heading} (previously: the same first ${HEADING_CHARS} characters — ` +
      'the retitle lies beyond the heading bound)'
    );
  }
  return `${change.heading} (previously: ${previous})`;
}

function formatChange(change: SnapshotChange): string[] {
  const heading = change.headingChanged ? formatRetitle(change) : change.heading;
  const hierarchy = [
    change.chapter === null ? null : `chapter ${change.chapter}`,
    change.part === null ? null : `part ${change.part}`,
    change.subpart === null ? null : `subpart ${change.subpart}`,
  ]
    .filter((part) => part !== null)
    .join(' / ');
  const lines = [`- ${change.citation} — ${heading}`];
  if (hierarchy !== '') lines.push(`  ${hierarchy}`);
  lines.push(`  path: ${change.path}`, '  sources:', ...formatSources(change));
  if (change.imageContent) {
    lines.push('  image content: true — the text does not include rating-table graphics');
  }
  lines.push(...formatSummary(change.summary));
  return lines;
}

/**
 * Render a snapshot comparison for the terminal. The MCP structured payload
 * remains the machine contract; this text is for a reader auditing what two
 * stored revisions changed.
 */
export function formatSnapshotComparison(comparison: SnapshotComparison): string {
  const count = (value: number): string =>
    comparison.truncated && value > 0 ? `at least ${String(value)}` : String(value);
  const lines: string[] = [
    `${count(comparison.changed.length)} changed, ${count(comparison.added.length)} added, ` +
      `${count(comparison.removed.length)} removed between ${comparison.from.issueDate} and ` +
      comparison.to.issueDate,
    `from: ${comparison.from.path}`,
    `to:   ${comparison.to.path}`,
  ];
  if (comparison.part !== null) lines.push(`part: ${comparison.part}`);
  if (comparison.truncated) {
    lines.push(
      `one or more category lists were cut (at the ${SNAPSHOT_CHANGE_CAP}-entry cap or the ` +
        `${SNAPSHOT_RESPONSE_CHAR_BUDGET}-character response budget)`,
    );
  }
  for (const [label, changes] of [
    ['changed', comparison.changed],
    ['added', comparison.added],
    ['removed', comparison.removed],
  ] as const) {
    if (changes.length === 0) continue;
    lines.push('', `${label}:`);
    for (const change of changes) lines.push(...formatChange(change));
  }
  return `${lines.join('\n')}\n`;
}
