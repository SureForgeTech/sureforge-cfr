import { statSync } from 'node:fs';

/**
 * What a path IS, decided before anything is asked to open it.
 *
 * Two surfaces take a caller-named path and hand it to SQLite — the offline
 * snapshot comparison (`compare_snapshots`) and `cfr-free verify` — and
 * SQLite's open is SYNCHRONOUS and BLOCKS on a FIFO: the command would wait
 * forever for a writer that never comes. One account of the fact, so the two
 * surfaces cannot disagree about what a path is.
 */
export type PathShape =
  /** A regular file: the only shape SQLite can be asked to open. */
  | { readonly kind: 'regular-file' }
  /**
   * Nothing is there (ENOENT), or the path cannot be there (ENOTDIR — a
   * parent component is a regular file).
   */
  | { readonly kind: 'missing' }
  /** The path might be there and could not be inspected. */
  | { readonly kind: 'unreadable'; readonly detail: string }
  /** Something is there, and it is not a regular file. */
  | { readonly kind: 'not-a-regular-file' };

/**
 * Classify a path with ONE `statSync` call.
 *
 * `statSync` follows symlinks: a link to an index file IS an index file, and
 * a link to a FIFO is not one. Its errno says WHY a path could not be
 * inspected — ENOENT and ENOTDIR mean there is nothing there, every other
 * errno (EACCES, ELOOP, ENAMETOOLONG, …) means the path might be there and
 * could not be read.
 */
export function inspectPathShape(resolved: string): PathShape {
  try {
    return statSync(resolved).isFile() ? { kind: 'regular-file' } : { kind: 'not-a-regular-file' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return {
      kind: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
