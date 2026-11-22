import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { defaultIndexDirectory } from '../config.js';
import { hashContent } from './changes.js';
import {
  EXCEPTION_DEMOTION_KEY,
  asksAboutExceptions,
  buildFtsQueries,
  contentTerms,
  queryTerms,
  tidySnippet,
  toFtsQuery,
  visibleMatches,
  type MatchMode,
  type QueryTerm,
} from './query.js';
import { extractReferences } from './references.js';
import { DEFAULT_TITLE, type TitleScope } from './titles.js';
import { escapeMarkdownLinks } from './xml.js';
import type { SectionKind, RawSection } from './xml.js';

// The title vocabulary lives in a leaf module (`titles.ts`) so the permalink
// builder can share it without importing the store; it is re-exported here
// because the store is where the title scope is enforced.
export { DEFAULT_TITLE } from './titles.js';
export type { TitleScope } from './titles.js';

/**
 * SQLite index of the eCFR corpus: one row per section/appendix per title,
 * plus an FTS5 external-content index kept consistent by triggers. All
 * writes happen in a single transaction so concurrent readers (WAL) never
 * observe a partial index.
 */

type Statement = ReturnType<DatabaseSync['prepare']>;

/** Raised when the local index cannot be opened or queried. */
export class StoreError extends Error {
  override readonly name = 'StoreError';
}

/**
 * The CFR title every read path scopes to when the caller names none lives
 * in `titles.ts` (shared with the permalink builder); see the re-export
 * above.
 */

export interface SectionRow {
  readonly title: number;
  readonly citation: string;
  readonly kind: SectionKind;
  readonly heading: string;
  readonly chapter: string | null;
  readonly subchapter: string | null;
  readonly part: string | null;
  readonly subpart: string | null;
  readonly subjectGroup: string | null;
  readonly path: string;
  readonly text: string;
  readonly markdown: string;
  readonly issueDate: string;
}

/**
 * Structural Citation Support (SCS) — the diagnostic vector (G, P, I) from
 * docs/research/ranking-instrument-design-2026-11-01.md §3.1, computed from
 * the materialized `section_references` edges. Diagnostic output only: no
 * search ranking key or candidate-set query ever reads it.
 */
export interface CitationSupport {
  /**
   * G(s) — distinct citing sections whose non-null, non-empty `part` AND
   * `subject_group` exactly equal the cited section's own.
   */
  readonly subjectGroup: number;
  /**
   * P(s) — distinct citing sections whose non-null, non-empty `part` exactly
   * equals the cited section's own. Missing/empty metadata on either side
   * never wildcard-matches: such a citing section counts toward `total` only.
   */
  readonly part: number;
  /** I(s) — distinct citing sections overall (self-citations excluded). */
  readonly total: number;
}

export interface SearchHit {
  /**
   * The CFR title this hit belongs to.
   *
   * Every hit carries its OWN authority: a store holds several titles' rows,
   * and a hit that did not say which title it came from would blend two
   * authorities into one unlabeled list (multi-title design, 2026-11-13).
   */
  readonly title: number;
  readonly citation: string;
  readonly heading: string;
  readonly part: string | null;
  readonly path: string;
  readonly snippet: string;
  /** The index issue date the row was read at; used to build the dated eCFR URL. */
  readonly issueDate: string;
  /** bm25 score — lower is better (more negative = stronger match). */
  readonly score: number;
  /** Query terms visible in this hit's citation, heading, or snippet. */
  readonly matches: readonly string[];
}

export interface SearchQuery {
  readonly query: string;
  readonly page: number;
  readonly perPage: number;
  readonly part?: string | undefined;
  readonly kind?: SectionKind | undefined;
  readonly chapter?: string | undefined;
  /**
   * The CFR title the search runs in (default {@link DEFAULT_TITLE}).
   *
   * The search is scoped to ONE authority unless the caller asks for every
   * stored title (`all`): the store holds every enabled title's rows, and a
   * citation may exist in more than one of them. An unscoped search would
   * mix authorities in one result list and label every hit with the serving
   * title's display form — so the scope is bound here and carried through
   * the candidate count, the AND tier and the ranked rows alike.
   */
  readonly title?: TitleScope | undefined;
}

export interface SearchOutcome {
  readonly hits: readonly SearchHit[];
  /** Size of the CANDIDATE SET — the rows the pagination walks. */
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  /**
   * The tier the candidate set came from.
   *
   * The OR tier is the only candidate tier: a section matching at least one
   * query term is a candidate, and the AND tier (every term) survives only
   * as a ranking boost. The field stays in the response (its `and`/`or`
   * enum is part of the wire contract) and reports `or`.
   */
  readonly matchMode: MatchMode;
}

/**
 * FTS external-content triggers: keep the index consistent with the
 * 'sections' table on every write path. All three must be updated together
 * if columns ever change (single schema, no migrations: index is rebuilt
 * wholesale by sync). Shared with upgradeSchemaShape, which drops and
 * recreates them when adopting a pre-v3 file.
 */
const FTS_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS sections_ai AFTER INSERT ON sections BEGIN
  INSERT INTO sections_fts(rowid, citation, heading, text)
  VALUES (new.id, new.citation, new.heading, new.text);
END;

-- Delete-side mirror of sections_ai (external-content tables do not track
-- deletions themselves).
CREATE TRIGGER IF NOT EXISTS sections_ad AFTER DELETE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, citation, heading, text)
  VALUES ('delete', old.id, old.citation, old.heading, old.text);
END;

-- Update path: remove the old index row, then index the new values.
CREATE TRIGGER IF NOT EXISTS sections_au AFTER UPDATE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, citation, heading, text)
  VALUES ('delete', old.id, old.citation, old.heading, old.text);
  INSERT INTO sections_fts(rowid, citation, heading, text)
  VALUES (new.id, new.citation, new.heading, new.text);
END;
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  title INTEGER NOT NULL DEFAULT ${DEFAULT_TITLE},
  citation TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('section', 'appendix')),
  heading TEXT NOT NULL,
  chapter TEXT,
  subchapter TEXT,
  part TEXT,
  subpart TEXT,
  subject_group TEXT,
  path TEXT NOT NULL,
  text TEXT NOT NULL,
  markdown TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  UNIQUE (title, citation)
);

-- Reverse cross-reference edges ("what cites X"), the materialized
-- counterpart of the forward "references" list a section read computes on
-- the fly. Populated inside the rebuild transaction from the same
-- extractReferences() pass the service uses, so both directions always
-- describe the same corpus. citing_id cascades with its section row;
-- cited_citation stores the lowercase form extractReferences() emits,
-- matching the (lowercase) section citations the corpus actually uses.
-- citing_title is the citing row's title, denormalized so a citedBy lookup
-- scopes to one authority without re-joining: a Title 32 section citing
-- "§ 70.3" means Title 32's § 70.3 — edges never cross titles (multi-title
-- design, 2026-11-13).
CREATE TABLE IF NOT EXISTS section_references (
  citing_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  citing_title INTEGER NOT NULL DEFAULT ${DEFAULT_TITLE},
  cited_citation TEXT NOT NULL,
  PRIMARY KEY (citing_id, cited_citation)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS section_references_cited ON section_references(cited_citation);

CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
  citation, heading, text,
  content = 'sections',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

${FTS_TRIGGER_SQL}`;

const INSERT_SECTION_SQL = `
INSERT INTO sections (
  title, citation, kind, heading, chapter, subchapter, part, subpart,
  subject_group, path, text, markdown, issue_date
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// citing_id comes from the section INSERT's lastInsertRowid; citing_title is
// that row's title (edges are scoped to one authority); cited_citation is one
// already-lowercased extractReferences() entry (deduped by the PRIMARY KEY
// below, which also bounds self-citations to one row each).
const INSERT_SECTION_REFERENCE_SQL = `
INSERT INTO section_references (citing_id, citing_title, cited_citation) VALUES (?, ?, ?)`;

// Reverse lookup: which sections of `title` cite `cited_citation`. Scope is
// the citing row's title — a Title 32 section's edge never answers a Title 38
// citedBy. Deterministic order (citing citation, lexicographic) so wire
// consumers see a stable list.
const CITED_BY_SQL = `
SELECT s.citation
FROM section_references r
JOIN sections s ON s.id = r.citing_id
WHERE r.cited_citation = ? AND r.citing_title = ?
ORDER BY s.citation`;

// Structural Citation Support (design doc §3.1): one pass over the
// materialized edges for one cited citation of one title. `c` is the citing
// section; `s` (LEFT JOIN) is the cited section, whose part/subject_group
// define the P/G neighbourhoods — absent from the index, it contributes to
// `total` only, the same "missing metadata never wildcard-matches" rule as an
// empty value. count(DISTINCT citing_id) makes repeated references from one
// citing section count once, and the s.id guard drops self-citations.
//
// The title scope is the citing row's title, exactly like citedBy: an edge
// never crosses titles, so "§ 4.105" in a Title 32 section means Title 32's
// § 4.105. The cited section is therefore resolved in that same title (the
// join keys on r.citing_title), and a title that has no such provision
// leaves its part/subject_group unknown — a count toward `total` only.
const CITATION_SUPPORT_SQL = `
SELECT
  count(DISTINCT r.citing_id) AS total,
  count(DISTINCT CASE
    WHEN c.part IS NOT NULL AND c.part <> '' AND c.part = s.part THEN r.citing_id
  END) AS part,
  count(DISTINCT CASE
    WHEN c.part IS NOT NULL AND c.part <> ''
     AND c.subject_group IS NOT NULL AND c.subject_group <> ''
     AND c.part = s.part AND c.subject_group = s.subject_group
    THEN r.citing_id
  END) AS subject_group
FROM section_references r
JOIN sections c ON c.id = r.citing_id
LEFT JOIN sections s
  ON s.title = r.citing_title AND s.citation = r.cited_citation
WHERE r.cited_citation = ? AND r.citing_title = ?
  AND (s.id IS NULL OR r.citing_id <> s.id)`;

// Full-corpus read for the export command: same row shape as getSection
// (SELECT * + toSectionRow), citation-ordered like the repo's other
// citation listing (CITED_BY_SQL).
const SELECT_ALL_SECTIONS_SQL = 'SELECT * FROM sections ORDER BY citation';

const UPSERT_META_SQL = `
INSERT INTO meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

// 36 tokens ≈ 2–3 sentences: enough context to quote from, bounded enough
// for token-sensitive MCP consumers. tidySnippet() then trims leading
// mid-sentence fragments (SPEC: sentence-boundary fidelity).
const SNIPPET_TEXT = `snippet(sections_fts, 2, '', '', '…', 36)`;
const SNIPPET_HEADING = `snippet(sections_fts, 1, '', '', '…', 36)`;
const SNIPPET_EXPR = `CASE WHEN ${SNIPPET_TEXT} = '' THEN ${SNIPPET_HEADING} ELSE ${SNIPPET_TEXT} END`;

/** Current schema version, stored in `PRAGMA user_version`.
 *  v3: multi-title — sections.title with (title, citation) uniqueness and
 *  section_references.citing_title edge scope. v2/v1 files are not migrated
 *  in place: `title`'s DEFAULT 38 keeps pre-upgrade rows schema-valid, and
 *  the version-mismatch path guides a wholesale rebuild (sync's single
 *  transaction rolls a failed rebuild back to the intact pre-upgrade rows). */
export const SCHEMA_VERSION = 3;

/** How long a connection waits on a locked database before failing. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface StoreOpenOptions {
  /** Override the busy-wait timeout (tests use a short one). */
  readonly busyTimeoutMs?: number;
  /**
   * True opens a standalone snapshot as immutable evidence and refuses
   * journal sidecars. 'live' opens the main file read-only and uses SQLite's
   * WAL protocol, which can update shared memory in the -shm sidecar and
   * create missing WAL/SHM sidecars if the directory is writable.
   */
  readonly readOnly?: boolean | 'live';
  /**
   * Adopt an OLDER schema version (0 < version < SCHEMA_VERSION) instead of
   * failing. Only the sync path may set this: `syncIndex` immediately
   * wholesale-rebuilds every row via replaceAllWithBaseline, so adoption is
   * never left holding stale-shaped data (v2's added edge table and v3's
   * title columns are both covered by the wholesale rebuild; the title
   * columns' DEFAULT 38 keeps pre-upgrade rows valid even before it runs).
   * Downgrade (version > SCHEMA_VERSION) always fails regardless of this
   * flag.
   */
  readonly allowSchemaUpgrade?: boolean;
}

// Column weights (citation 10, heading 5, body 1): exact-citation and
// heading matches must outrank body-only matches (delivery log §13).
const SCORE_EXPR = 'bm25(sections_fts, 10.0, 5.0, 1.0) AS score';

/**
 * The AND tier's citations, as a CTE.
 *
 * The AND tier is not a candidate tier any more (the candidate set is the
 * OR tier); it is a RANKING boost, and the boost is computed IN SQL: a JS
 * prototype that sorted the rows to find the AND members cost ~200 ms and
 * ~700 ms on citation queries. The CTE's MATCH parameter binds FIRST — the
 * CTE precedes the main SELECT in the statement text.
 */
const AND_TIER_CTE = `
WITH and_hits(rowid) AS (
  SELECT s.id
  FROM sections_fts
  JOIN sections s ON s.id = sections_fts.rowid
  WHERE sections_fts MATCH ?
)`;

/**
 * The AND-tier membership key: 1 when the row matches EVERY query term, 0
 * when it matches only some. Sorted DESC, it puts the rows that answered
 * the whole question ahead of the rows that answered part of it.
 */
const AND_TIER_KEY = '(CASE WHEN a.rowid IS NOT NULL THEN 1 ELSE 0 END) DESC';

/**
 * The ranked-search statement.
 *
 * The candidate set is the OR tier (`sections_fts MATCH ?` with the OR
 * query); the AND tier joins onto it as the ranking boost. `where` is the
 * filter tail (` AND s.part = ? …`, always fixed column names with bound
 * values) and `orderBy` is the sort-key prefix, so every value binds as a
 * parameter and no user input reaches the SQL text.
 */
const SELECT_MATCHES_SQL = (where: string, orderBy: string): string => `
${AND_TIER_CTE}
SELECT s.title, s.citation, s.heading, s.part, s.path, s.issue_date AS issue_date, ${SNIPPET_EXPR} AS snippet,
       ${SCORE_EXPR}
FROM sections_fts
JOIN sections s ON s.id = sections_fts.rowid
LEFT JOIN and_hits a ON a.rowid = s.id
WHERE sections_fts MATCH ?${where}
ORDER BY ${orderBy}score, s.citation
LIMIT ? OFFSET ?`;

/**
 * Optional search filters map to FIXED column names. The WHERE tail is
 * assembled from this map only — never from user input — and every filter
 * value is a bound parameter, so no filter value ever reaches SQL text.
 * The prepared-statement cache is keyed by SQL text, so each of the ≤8
 * filter combinations compiles exactly once.
 */
const SEARCH_FILTER_COLUMNS = {
  part: 's.part',
  kind: 's.kind',
  chapter: 's.chapter',
} as const;

type SearchFilterName = keyof typeof SEARCH_FILTER_COLUMNS;

/** A present search filter: fixed column key plus its (bound) value. */
type SearchFilter = readonly [name: SearchFilterName, value: string];

/** Present filters in a fixed order so statement shapes stay deterministic. */
function presentFilters(query: SearchQuery): SearchFilter[] {
  const filters: SearchFilter[] = [];
  if (query.part !== undefined) filters.push(['part', query.part]);
  if (query.kind !== undefined) filters.push(['kind', query.kind]);
  if (query.chapter !== undefined) filters.push(['chapter', query.chapter]);
  return filters;
}

/**
 * The WHERE tail of a search: the title scope first, then the optional
 * filters — every value bound.
 *
 * The TITLE SCOPE is part of the tail rather than a separate clause so the
 * candidate count and the ranked rows cannot drift apart: both build their
 * tail here, and a query that forgot the scope would have to forget it in
 * one place only. `s.title = ?` is a fixed column name with a bound value,
 * so the title never reaches the SQL text.
 *
 * The `all` scope is the ONE tail without a title predicate: every stored
 * title is a candidate, and the ranking stays the ranking it was (no
 * cross-title weights — multi-title design, 2026-11-13). Its bound value
 * list is empty too, so the statement and its parameters cannot disagree
 * about which scope they describe.
 */
interface SearchScope {
  /** The SQL tail: fixed column names, bound values only. */
  readonly clause: string;
  /** The values bound to it, in the order they appear in the statement. */
  readonly params: readonly (string | number)[];
}

function scopeClause(title: TitleScope, filters: readonly SearchFilter[]): SearchScope {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (title !== 'all') {
    parts.push(' AND s.title = ?');
    params.push(title);
  }
  for (const [name, value] of filters) {
    parts.push(` AND ${SEARCH_FILTER_COLUMNS[name]} = ?`);
    params.push(value);
  }
  return { clause: parts.join(''), params };
}

const COUNT_MATCHES_SQL = (where: string): string => `
SELECT count(*) AS n
FROM sections_fts
JOIN sections s ON s.id = sections_fts.rowid
WHERE sections_fts MATCH ?${where}`;

const DIRECT_MATCH_SQL = `
SELECT 1
FROM sections_fts
JOIN sections s ON s.id = sections_fts.rowid
WHERE sections_fts MATCH ? AND s.citation = ? COLLATE NOCASE AND s.title = ?
LIMIT 1`;

/**
 * Version check for a read-only evidence open: never adopt or repair the file.
 * Snapshot readers need the current v3 shape (the title column is part of
 * their read path), and any older/newer file is rejected with the same
 * rebuild guidance as the strict mutable open.
 */
function ensureReadOnlySchemaVersion(db: DatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  const version = Number(versionRow?.['user_version'] ?? 0);
  if (version === SCHEMA_VERSION) return;
  throw new StoreError(
    `index schema version ${version} is not supported for read-only snapshot comparison ` +
      `(expected ${SCHEMA_VERSION}, the v3 multi-title snapshot shape); export a fresh snapshot ` +
      'copy with a current cfr-free release — re-syncing changes the live index and cannot ' +
      'recreate this stored revision',
  );
}

/**
 * The objects a usable cfr-free index MUST have: the row table, the
 * metadata table, the edge table and the FTS index.
 *
 * `refuseForeignDatabase` only asks "are the tables ours?" and the version
 * check only asks "is the version current?"; neither asks whether the
 * objects the READ paths need actually EXIST. A file stamped with the
 * current version but missing its FTS index would open, answer `quick_check`
 * and then fail on the first search — so verification, which exists to
 * answer "is this file usable?", checks the objects themselves.
 */
const REQUIRED_TABLES = ['meta', 'sections', 'section_references', 'sections_fts'] as const;

/** The columns of `sections` a read path selects. */
const REQUIRED_SECTION_COLUMNS = [
  'id',
  'title',
  'citation',
  'kind',
  'heading',
  'chapter',
  'subchapter',
  'part',
  'subpart',
  'subject_group',
  'path',
  'text',
  'markdown',
  'issue_date',
] as const;

/**
 * Confirm the file holds the objects a cfr-free index is made of.
 *
 * Runs against a read-only connection and writes nothing: it only reads
 * `sqlite_master` and `pragma_table_info`.
 */
function assertUsableSchema(db: DatabaseSync): void {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
      .all()
      .map((row) => String((row as Record<string, unknown>)['name'])),
  );
  const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
  if (missing.length > 0) {
    throw new StoreError(
      `the file is missing the ${missing.join(', ')} ${missing.length === 1 ? 'object' : 'objects'} ` +
        'a cfr-free index needs — it is not a usable cfr-free index',
    );
  }
  const columns = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('sections')")
      .all()
      .map((row) => String((row as Record<string, unknown>)['name'])),
  );
  const absent = REQUIRED_SECTION_COLUMNS.filter((name) => !columns.has(name));
  if (absent.length > 0) {
    throw new StoreError(
      `the sections table is missing the ${absent.join(', ')} ` +
        `${absent.length === 1 ? 'column' : 'columns'} a cfr-free index needs`,
    );
  }
}

/**
 * Ensure the on-disk schema version is compatible; adopt legacy files.
 *
 * Adoption rules: version 0 (pre-versioning) always adopts; an OLDER
 * versioned file adopts only when `allowSchemaUpgrade` vouches for an
 * immediate wholesale rebuild (the sync path, the only permitted caller —
 * replaceAllWithBaseline repopulates every row, including the new
 * section_references edges); a NEWER version always fails — downgrade is
 * unsupported, flag or not.
 */
function ensureSchemaVersion(db: DatabaseSync, allowSchemaUpgrade: boolean): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  const version = Number(versionRow?.['user_version'] ?? 0);
  if (version === SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new StoreError(
      `index schema version ${version} is not supported (expected ${SCHEMA_VERSION}) — ` +
        'downgrade is unsupported; delete the index file and run `cfr-free sync`',
    );
  }
  if (version !== 0 && !allowSchemaUpgrade) {
    throw new StoreError(
      `index schema version ${version} is not supported (expected ${SCHEMA_VERSION}) — rebuild it with \`cfr-free sync\``,
    );
  }
  // Adopting version 0 (pre-versioning) or an older versioned file whose
  // caller vouches for a full rebuild. v3 changes the shape of EXISTING
  // tables (unlike v2, which only added one), so first bring the tables to
  // the v3 shape: rows are preserved (title defaults to 38) and the rebuild
  // itself runs in one transaction, so a failed rebuild rolls back to those
  // intact pre-upgrade rows rather than a half-migrated store.
  upgradeSchemaShape(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Bring a pre-v3 file's tables to the v3 shape, preserving rows.
 *
 * Runs only on the adoption path (see ensureSchemaVersion). `CREATE TABLE IF
 * NOT EXISTS` cannot change an existing table's shape, and the old
 * `UNIQUE(citation)` would wrongly reject a citation shared across titles
 * even after a rebuild — so `sections` is rebuilt as a new table with rows
 * copied (ids preserved, title stamped 38), while `section_references` only
 * gains a defaulted column (its key is per citing row and stays correct).
 * Dropping `sections` drops its FTS triggers with it; they are recreated
 * here. Dropping and recreating the FTS5 external-content table's content
 * table under the same name also breaks the virtual table's cached state on
 * this connection (a later DML threw "database disk image is malformed" in
 * reproduction), so the FTS index is rebuilt from the copied rows — one
 * `rebuild` command, keyed by the preserved rowids.
 */
function upgradeSchemaShape(db: DatabaseSync): void {
  const sectionColumns = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('sections')")
      .all()
      .map((row) => String((row as Record<string, unknown>)['name'])),
  );
  if (!sectionColumns.has('title')) {
    db.exec(`
      CREATE TABLE sections_v3 (
        id INTEGER PRIMARY KEY,
        title INTEGER NOT NULL DEFAULT ${DEFAULT_TITLE},
        citation TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('section', 'appendix')),
        heading TEXT NOT NULL,
        chapter TEXT,
        subchapter TEXT,
        part TEXT,
        subpart TEXT,
        subject_group TEXT,
        path TEXT NOT NULL,
        text TEXT NOT NULL,
        markdown TEXT NOT NULL,
        issue_date TEXT NOT NULL,
        UNIQUE (title, citation)
      );
      INSERT INTO sections_v3 (
        id, title, citation, kind, heading, chapter, subchapter, part, subpart,
        subject_group, path, text, markdown, issue_date
      )
        SELECT id, ${DEFAULT_TITLE}, citation, kind, heading, chapter, subchapter, part,
               subpart, subject_group, path, text, markdown, issue_date
        FROM sections;
      DROP TABLE sections;
      ALTER TABLE sections_v3 RENAME TO sections;
      INSERT INTO sections_fts(sections_fts) VALUES ('rebuild');
      ${FTS_TRIGGER_SQL}
    `);
  }
  const edgeColumns = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info('section_references')")
      .all()
      .map((row) => String((row as Record<string, unknown>)['name'])),
  );
  if (!edgeColumns.has('citing_title')) {
    // v2 file: SCHEMA_SQL's IF NOT EXISTS kept the table at its old shape.
    db.exec(
      `ALTER TABLE section_references ADD COLUMN citing_title INTEGER NOT NULL DEFAULT ${DEFAULT_TITLE}`,
    );
  }
}

/**
 * The sort key that puts a HEADING match ahead of a body-only match.
 *
 * bm25 weighs term frequency WITHIN a column, so a section whose body
 * repeats the phrase ten times outranks a section whose heading IS the
 * phrase — which is not what delivery log §13 row 4 promises ("citation/heading
 * matches outrank body-only hits"). The key counts how many of the
 * query's content terms the heading carries (the term itself, or the
 * corpus phrase a synonym stands for) and sorts on it before the score.
 *
 * The SQL text is assembled from a fixed shape; every value binds as a
 * parameter, so no user input reaches the statement.
 */
function headingMatchKey(terms: readonly QueryTerm[]): { clause: string; params: string[] } {
  const content = contentTerms(terms);
  // The heading must carry the query's terms as a PHRASE, not merely one of
  // them: counting the terms that appear promotes any heading that happens
  // to contain a generic word ("rating", "service", "recipients") above the
  // provision that actually answers the question — measured, that cost the
  // holdout three of its exact-citation hits.
  const alternatives: string[] = [];
  const phrase = content.map((term) => term.term).join(' ');
  if (phrase !== '') alternatives.push(phrase);
  for (const term of content) {
    for (const expansion of term.expansions) alternatives.push(expansion);
  }
  const params: string[] = [];
  const tests = alternatives.map((alternative) => {
    params.push(alternative.toLowerCase());
    return 'instr(lower(s.heading), ?) > 0';
  });
  if (tests.length === 0) return { clause: '', params: [] };
  return { clause: `(CASE WHEN ${tests.join(' OR ')} THEN 1 ELSE 0 END) DESC, `, params };
}

/** True for SQLITE_BUSY/SQLITE_LOCKED failures (concurrent writer). */
function isBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { errcode?: unknown; message?: unknown };
  if (err.errcode === 5 || err.errcode === 6) return true;
  return (
    typeof err.message === 'string' &&
    /database is locked|database table is locked|SQLITE_BUSY/i.test(err.message)
  );
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toSectionRow(row: Record<string, unknown>): SectionRow {
  return {
    title: Number(row['title'] ?? DEFAULT_TITLE),
    citation: String(row['citation']),
    kind: row['kind'] === 'appendix' ? 'appendix' : 'section',
    heading: String(row['heading']),
    chapter: nullableString(row['chapter']),
    subchapter: nullableString(row['subchapter']),
    part: nullableString(row['part']),
    subpart: nullableString(row['subpart']),
    subjectGroup: nullableString(row['subject_group']),
    path: String(row['path']),
    text: String(row['text']),
    // The escaping is idempotent, so applying it here also covers sections
    // that were indexed before the rule existed.
    markdown: escapeMarkdownLinks(String(row['markdown'])),
    issueDate: String(row['issue_date']),
  };
}

/** The tables this schema creates, the FTS5 shadow tables of `sections_fts` included. */
const OWN_TABLES: ReadonlySet<string> = new Set([
  'meta',
  'sections',
  'section_references',
  ...['', '_data', '_idx', '_content', '_docsize', '_config'].map((tail) => `sections_fts${tail}`),
]);

/**
 * Refuse a SQLite file that belongs to something else.
 *
 * `CREATE TABLE IF NOT EXISTS` is silent about a table that already exists
 * with another shape. Opening some other program's database (a wrong
 * `CFR_INDEX_PATH`, a file received from someone else) would stamp our schema
 * version over it, and the next sync's `DELETE FROM sections` would wipe a
 * table that was never ours. An empty file is ours to create; a file with
 * tables must hold only ours.
 *
 * It runs BEFORE any pragma that writes (the journal mode rewrites the file
 * header), so a file that is refused is left byte for byte as it was.
 */
function refuseForeignDatabase(db: DatabaseSync): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String((row as Record<string, unknown>)['name']));
  // A file whose creation was interrupted holds only SOME of our tables, so
  // the test is that every table is ours, not that all of them are there.
  if (tables.some((name) => !OWN_TABLES.has(name))) {
    throw new StoreError('the file is a SQLite database, but not a cfr-free index');
  }
  if (tables.includes('sections')) {
    const columns = new Set(
      db
        .prepare("SELECT name FROM pragma_table_info('sections')")
        .all()
        .map((row) => String((row as Record<string, unknown>)['name'])),
    );
    if (!columns.has('citation') || !columns.has('markdown')) {
      throw new StoreError('the file is a SQLite database, but not a cfr-free index');
    }
  }
}

function tightenPermissions(target: string, kind: 'file' | 'directory'): void {
  try {
    // statSync, not lstatSync: a symlinked index path names the file SQLite
    // opens, so the mode has to be tightened on the file the link resolves
    // to. lstatSync would describe the link itself and skip the chmod.
    const stat = statSync(target);
    if (kind === 'file' && stat.isFile()) chmodSync(target, 0o600);
    if (kind === 'directory' && stat.isDirectory()) chmodSync(target, 0o700);
  } catch {
    // Sidecars can disappear on close, and some filesystems lack POSIX modes.
  }
}

function ensureDirectoryPermissions(filePath: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const defaultDirectory = defaultIndexDirectory();
  if (directory === defaultDirectory) tightenPermissions(defaultDirectory, 'directory');
}

function readOnlyDatabaseTarget(filePath: string, mode: true | 'live'): string {
  const resolved = realpathSync(filePath);
  const target = pathToFileURL(resolved);
  target.searchParams.set('mode', 'ro');
  // SQLite's ordinary read-only mode can create WAL/SHM files. Immutable
  // mode avoids those writes but ignores journals, so require a standalone
  // snapshot before using it.
  if (mode === true) {
    if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(resolved + suffix))) {
      throw new StoreError('index has SQLite journal sidecars — use a standalone cfr-free export');
    }
    target.searchParams.set('immutable', '1');
  }
  return target.href;
}

function assertQuickCheck(db: DatabaseSync): void {
  const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
  const result = check ? String(Object.values(check)[0] ?? '') : '';
  if (result !== 'ok') throw new StoreError(`integrity check failed: ${result || 'no result'}`);
}

function openDatabase(filePath: string, options: StoreOpenOptions): DatabaseSync {
  const readOnly = options.readOnly ?? false;
  const onDisk = filePath !== ':memory:';
  if (!readOnly && onDisk) ensureDirectoryPermissions(filePath);

  const db = readOnly
    ? new DatabaseSync(readOnlyDatabaseTarget(filePath, readOnly), { readOnly: true })
    : new DatabaseSync(filePath);
  try {
    // The file is an INPUT: `export` exists so an index can be handed to
    // someone else, and `CFR_INDEX_PATH` can name any file. Views and
    // triggers stored in a schema we did not write must not be allowed to
    // call SQL functions on our behalf, so the schema is not trusted. Set
    // before anything reads it.
    db.exec('PRAGMA trusted_schema = OFF');
    refuseForeignDatabase(db);
    if (!readOnly && onDisk) tightenPermissions(filePath, 'file');
    // A read-only open must not rewrite a delete-mode snapshot's
    // header just to prefer WAL; that mutation belongs to the owner/sync.
    if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // Pinned explicitly (node:sqlite currently defaults it on, but the
    // section_references ON DELETE CASCADE wipe depends on it — never let
    // that hinge on a driver default).
    db.exec('PRAGMA foreign_keys = ON');
    // Wait for a concurrent writer (e.g. a second sync) instead of failing
    // instantly with a cryptic SQLITE_BUSY.
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    assertQuickCheck(db);
    if (readOnly) {
      ensureReadOnlySchemaVersion(db);
      // A read-only open must also hold the OBJECTS a read path
      // needs: the version stamp alone does not prove the file is usable.
      assertUsableSchema(db);
    } else {
      db.exec(SCHEMA_SQL);
      ensureSchemaVersion(db, options.allowSchemaUpgrade ?? false);
      if (onDisk) {
        tightenPermissions(`${filePath}-wal`, 'file');
        tightenPermissions(`${filePath}-shm`, 'file');
      }
    }
    return db;
  } catch (error) {
    // Do not hold the file (or its descriptor) open after a refusal.
    try {
      db.close();
    } catch {
      // already closed, or never opened
    }
    throw error;
  }
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Statement>();
  private readonly filePath: string;

  private constructor(db: DatabaseSync, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  /**
   * Open (creating if needed) the index at `filePath` and ensure the schema.
   *
   * @throws {StoreError} when the file fails its integrity check.
   */
  static open(filePath: string, options: StoreOpenOptions = {}): Store {
    try {
      return new Store(openDatabase(filePath, options), filePath);
    } catch (error) {
      if (error instanceof StoreError) {
        throw new StoreError(`cannot open index at ${filePath}: ${error.message}`);
      }
      throw new StoreError(
        `cannot open index at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  get path(): string {
    return this.filePath;
  }

  private stmt(sql: string): Statement {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  /**
   * Run `fn` inside a single DEFERRED transaction — a READ snapshot.
   *
   * A deferred transaction takes no lock until it reads, and then holds a
   * consistent view of the database for its whole life: every statement
   * inside sees the SAME revision, even if a writer commits in between.
   * Under WAL a reader never blocks a writer, so a verification can read a
   * live index without stopping a sync.
   *
   * This is what makes a multi-statement read coherent: the counts, the
   * metadata and the row hashes a verification compares all describe one
   * revision, instead of a mix of two.
   */
  readSnapshot<T>(fn: () => T): T {
    try {
      this.db.exec('BEGIN DEFERRED');
    } catch (error) {
      if (isBusyError(error)) {
        throw new StoreError(
          'index is locked by another cfr-free process (a sync appears to be running) — wait for it to finish and retry',
        );
      }
      throw error;
    }
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Rollback is best-effort: the connection may already be clean.
      }
      throw error;
    }
  }

  /** Run `fn` inside a single IMMEDIATE transaction (rollback on throw). */
  transaction(fn: () => void): void {
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (isBusyError(error)) {
        throw new StoreError(
          'index is locked by another cfr-free process (a sync appears to be running) — wait for it to finish and retry',
        );
      }
      throw error;
    }
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Rollback is best-effort: the connection may already be clean.
      }
      if (isBusyError(error)) {
        throw new StoreError(
          'index write was interrupted by another cfr-free process — wait for it to finish and retry',
        );
      }
      throw error;
    }
  }

  /**
   * Atomically replace the entire index contents.
   *
   * Delegates to {@link replaceAllWithBaseline} with a no-op baseline.
   */
  replaceAll(
    sections: readonly RawSection[],
    issueDate: string,
    meta: Readonly<Record<string, string>>,
  ): void {
    this.replaceAllWithBaseline(sections, issueDate, meta, () => undefined);
  }

  /**
   * Atomically replace the entire index while running `baseline` INSIDE the
   * same IMMEDIATE transaction, BEFORE the wipe.
   *
   * Delegates to {@link replaceTitleWithBaseline}'s shared machinery with a
   * whole-index scope: every row is wiped and reinserted, and the rows keep
   * their own `section.title` stamps (or the {@link DEFAULT_TITLE} default).
   *
   * @deprecated New write paths that serve a multi-title index should prefer
   * {@link replaceTitleWithBaseline}, which preserves the other titles' rows
   * and meta. Retained for single-title fixture seeds and the demo store.
   */
  replaceAllWithBaseline<T>(
    sections: readonly RawSection[],
    issueDate: string,
    meta: Readonly<Record<string, string>>,
    baseline: (store: Store) => T,
  ): T {
    return this.replaceScoped(null, sections, issueDate, meta, baseline);
  }

  /**
   * Atomically replace ONE title's slice of the index while running
   * `baseline` INSIDE the same IMMEDIATE transaction, BEFORE the wipe.
   *
   * The scope is exactly `sections WHERE title = ?`: rows, edges (citing_id
   * cascades) and the title's own meta are replaced, while every other
   * title's rows and meta are preserved untouched — a Title 32 sync can
   * never wipe a Title 38 index. The inserted rows are stamped with `title`
   * (NOT each section's own stamp: the caller names the authority this
   * rebuild serves), and `title.<N>.issue_date` is upserted alongside the
   * passed meta.
   *
   * The baseline callback reads the OUTGOING slice (previous per-title issue
   * date, per-title text hashes) only after the write lock is held, exactly
   * as {@link replaceAllWithBaseline} does for the whole index; its return
   * value is handed back and any meta it writes rides the same COMMIT.
   */
  replaceTitleWithBaseline<T>(
    title: number,
    sections: readonly RawSection[],
    issueDate: string,
    meta: Readonly<Record<string, string>>,
    baseline: (store: Store) => T,
  ): T {
    return this.replaceScoped(title, sections, issueDate, meta, baseline);
  }

  /**
   * The shared rebuild transaction behind both public replacement methods.
   *
   * `scope` is `null` for the whole index ({@link replaceAllWithBaseline})
   * or one title number ({@link replaceTitleWithBaseline}). Ordering:
   * callback first, then DELETE → INSERT → meta upserts — the baseline must
   * see pre-wipe rows, and everything it reads is pinned by BEGIN IMMEDIATE
   * until COMMIT.
   */
  private replaceScoped<T>(
    scope: number | null,
    sections: readonly RawSection[],
    issueDate: string,
    meta: Readonly<Record<string, string>>,
    baseline: (store: Store) => T,
  ): T {
    let result!: T;
    this.transaction(() => {
      result = baseline(this);
      // The scoped wipe clears only this title's rows; their edges cascade
      // with them (PRAGMA foreign_keys is pinned ON in open()).
      if (scope === null) {
        this.db.exec('DELETE FROM sections');
      } else {
        this.stmt('DELETE FROM sections WHERE title = ?').run(scope);
      }
      const insert = this.stmt(INSERT_SECTION_SQL);
      const insertReference = this.stmt(INSERT_SECTION_REFERENCE_SQL);
      for (const section of sections) {
        const title = scope ?? section.title ?? DEFAULT_TITLE;
        const { lastInsertRowid } = insert.run(
          title,
          section.citation,
          section.kind,
          section.heading,
          section.chapter,
          section.subchapter,
          section.part,
          section.subpart,
          section.subjectGroup,
          section.path,
          section.text,
          section.markdown,
          issueDate,
        );
        // Reverse-reference edges, materialized in the SAME transaction as
        // the sections they describe (extractReferences is the exact pass
        // the service runs on read, so both directions stay consistent).
        // citing_title stamps the edge with the citing row's authority.
        const citingId = Number(lastInsertRowid);
        for (const cited of extractReferences(section.text)) {
          insertReference.run(citingId, title, cited);
        }
      }
      const upsert = this.stmt(UPSERT_META_SQL);
      for (const [key, value] of Object.entries(meta)) upsert.run(key, value);
      if (scope !== null) {
        // The scoped rebuild records its own authority's issue date; the
        // other titles' meta keys are left exactly as they were.
        upsert.run(`title.${scope}.issue_date`, issueDate);
      } else {
        // Per-title issue dates alongside the legacy Title-38 `issue_date` key
        // (meta keys `title.<N>.issue_date`); legacy readers keep working until
        // the wire PR moves them onto the per-title keys.
        for (const title of new Set(sections.map((section) => section.title ?? DEFAULT_TITLE))) {
          upsert.run(`title.${title}.issue_date`, issueDate);
        }
      }
    });
    return result;
  }

  /**
   * How many rows one title's slice holds (default {@link DEFAULT_TITLE}).
   *
   * The count is title-scoped because the drift check compares it with the
   * structure expectations recorded for THAT title: an all-titles count
   * against one title's expectations reports a healthy multi-title index as
   * degraded.
   */
  countSections(title: number = DEFAULT_TITLE): number {
    const row = this.stmt('SELECT count(*) AS n FROM sections WHERE title = ?').get(title) as
      Record<string, unknown> | undefined;
    return row ? Number(row['n'] ?? 0) : 0;
  }

  /**
   * How many rows the whole store holds, every title included.
   *
   * The export path uses this: a snapshot copy carries EVERY title's rows,
   * so the count it reports must be the count of what it wrote, not one
   * title's slice.
   */
  countAllSections(): number {
    const row = this.stmt('SELECT count(*) AS n FROM sections').get() as
      Record<string, unknown> | undefined;
    return row ? Number(row['n'] ?? 0) : 0;
  }

  /**
   * How many rows the whole store holds, and every title it holds, in ONE
   * statement.
   *
   * The export path uses this: an export carries EVERY title's rows, so the
   * report that describes it must name the titles and the count of the SAME
   * revision — and two statements could straddle a concurrent sync.
   */
  storeSummary(): { readonly provisions: number; readonly titles: number[] } {
    const rows = this.stmt(
      'SELECT title, count(*) AS n FROM sections GROUP BY title ORDER BY title',
    ).all() as Record<string, unknown>[];
    const titles = rows.map((row) => Number(row['title']));
    const provisions = rows.reduce((sum, row) => sum + Number(row['n'] ?? 0), 0);
    return { provisions, titles };
  }

  /**
   * Per-kind provision counts for one title (default {@link DEFAULT_TITLE})
   * — the verification read path. `SUM(kind = …)` yields NULL for a title
   * with no rows, so the counts fall back to 0.
   */
  countProvisions(title: number = DEFAULT_TITLE): { sections: number; appendices: number } {
    const row = this.stmt(
      `SELECT SUM(kind = 'section') AS sections, SUM(kind = 'appendix') AS appendices
       FROM sections WHERE title = ?`,
    ).get(title) as Record<string, unknown> | undefined;
    return {
      sections: Number(row?.['sections'] ?? 0),
      appendices: Number(row?.['appendices'] ?? 0),
    };
  }

  /**
   * Every indexed row (section + appendix) in citation order — the export
   * read path. Same SELECT/row mapping as {@link getSection}, applied to
   * the whole table.
   *
   * Materializes the corpus once: at Title 38 scale that is 2 970 rows /
   * ~16 MB of text+markdown (measured on the live index), which the export
   * writers serialize immediately. Unlike `captureTextHashes` (folded into
   * a hash map, so it batches to bound memory), callers here need the text
   * itself, so the rows are returned in one array by design.
   *
   * The rows carry their own `title`, so a multi-title store's export says
   * which authority every provision belongs to instead of blending them.
   */
  allSections(): SectionRow[] {
    const rows = this.stmt(SELECT_ALL_SECTIONS_SQL).all() as Record<string, unknown>[];
    return rows.map(toSectionRow);
  }

  /**
   * Write a consistent snapshot of the index (including WAL content) to
   * `target` via `VACUUM INTO`. The target must not already exist.
   */
  backupTo(target: string): void {
    try {
      this.db.prepare('VACUUM INTO ?').run(target);
    } catch (error) {
      throw new StoreError(
        `cannot export index to ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getMeta(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as
      Record<string, unknown> | undefined;
    return row ? String(row['value']) : null;
  }

  /**
   * @deprecated Production code should pass meta via `replaceAll(sections, issueDate, meta)`.
   * Retained as a public method for test fixtures only. Will be removed in a future major.
   */
  setMeta(key: string, value: string): void {
    this.stmt(UPSERT_META_SQL).run(key, value);
  }

  /**
   * Look up one section/appendix by canonical citation, scoped to one title
   * (default {@link DEFAULT_TITLE}). The title scope keeps a citation that
   * exists in several titles from silently resolving to the wrong authority.
   */
  getSection(
    citation: string,
    kind: SectionKind,
    title: number = DEFAULT_TITLE,
  ): SectionRow | null {
    const sql =
      kind === 'appendix'
        ? 'SELECT * FROM sections WHERE kind = ? AND citation = ? COLLATE NOCASE AND title = ?'
        : 'SELECT * FROM sections WHERE kind = ? AND citation = ? AND title = ?';
    const row = this.stmt(sql).get(kind, citation, title) as Record<string, unknown> | undefined;
    return row ? toSectionRow(row) : null;
  }

  /** Whether any indexed row (section or appendix) of `title` (default
   * {@link DEFAULT_TITLE}) carries this citation. */
  hasSection(citation: string, title: number = DEFAULT_TITLE): boolean {
    const row = this.stmt(
      'SELECT 1 FROM sections WHERE citation = ? COLLATE NOCASE AND title = ? LIMIT 1',
    ).get(citation, title);
    return row !== undefined;
  }

  /**
   * Every stored row that carries this citation, ACROSS every title.
   *
   * Used to pin citations in all-title searches and to find unambiguous
   * matches for untitled reads that missed Title 38. Rows come back in
   * title order.
   *
   * The kind is honoured exactly as {@link getSection} honours it (a
   * section's citation is matched exactly, an appendix's case-insensitively),
   * so a lookup here finds what a read of that kind would find.
   */
  sectionsForCitation(citation: string, kind: SectionKind): SectionRow[] {
    const sql =
      kind === 'appendix'
        ? 'SELECT * FROM sections WHERE kind = ? AND citation = ? COLLATE NOCASE ORDER BY title'
        : 'SELECT * FROM sections WHERE kind = ? AND citation = ? ORDER BY title';
    const rows = this.stmt(sql).all(kind, citation) as Record<string, unknown>[];
    return rows.map(toSectionRow);
  }

  /**
   * Citations of indexed sections of `title` (default {@link DEFAULT_TITLE})
   * whose text references `citation` — the reverse of the forward
   * `references` list on a section read. Sorted lexicographically by citing
   * citation (deterministic wire output); empty array when nothing cites it.
   * `citation` is bound as a parameter and matched exactly against the
   * lowercase form extractReferences emits; the edge scope is the citing
   * row's title, so a lookup never blends two authorities' edges.
   */
  citedBy(citation: string, title: number = DEFAULT_TITLE): string[] {
    const rows = this.stmt(CITED_BY_SQL).all(citation, title) as Record<string, unknown>[];
    return rows.map((row) => String(row['citation']));
  }

  /**
   * Structural Citation Support for one citation of `title` (default
   * {@link DEFAULT_TITLE}): the (G, P, I) diagnostic vector computed over the
   * materialized edges, scoped to one authority exactly like {@link citedBy}.
   * Query-independent and deterministic: the same index always yields the
   * same vector. Zero is a real value — a section nothing cites reports
   * (0, 0, 0).
   *
   * `total` is I(s) — distinct citing sections, self-citations excluded;
   * `part` is P(s) — those sharing the cited section's part; and
   * `subjectGroup` is G(s) — those sharing its part AND subject group. A
   * missing or empty `part`/`subject_group` on either side never wildcard-
   * matches: that citing section counts toward `total` only.
   */
  citationSupport(citation: string, title: number = DEFAULT_TITLE): CitationSupport {
    const row = this.stmt(CITATION_SUPPORT_SQL).get(citation, title) as
      Record<string, unknown> | undefined;
    return {
      subjectGroup: row === undefined ? 0 : Number(row['subject_group'] ?? 0),
      part: row === undefined ? 0 : Number(row['part'] ?? 0),
      total: row === undefined ? 0 : Number(row['total'] ?? 0),
    };
  }

  /**
   * SHA-256 of every section's text, keyed by citation. Read in bounded
   * rowid batches: materializing the whole corpus in one `.all()` would
   * roughly double sync's peak memory (text + map), which matters in the
   * memory-capped container image.
   */
  captureTextHashes(): Map<string, string> {
    const hashes = new Map<string, string>();
    const statement = this.stmt(
      'SELECT id, citation, text, heading FROM sections WHERE id > ? ORDER BY id LIMIT 500',
    );
    let cursor = -1;
    for (;;) {
      const rows = statement.all(cursor) as Record<string, unknown>[];
      if (rows.length === 0) break;
      for (const row of rows) {
        // TEXT AND HEADING: a heading-only amendment (a retitled section
        // with an unchanged body) is a change to the provision, and a
        // text-only hash reported it as "no change". The baseline is this
        // live table, so there is no hash-compatibility transition: the
        // previous index's rows carry their headings.
        hashes.set(
          String(row['citation']),
          hashContent(String(row['text']), String(row['heading'])),
        );
        cursor = Number(row['id']);
      }
    }
    return hashes;
  }

  /**
   * SHA-256 of every provision's text+heading for ONE title, optionally
   * scoped to one part — the offline snapshot-comparison read path. Same
   * batched read as {@link captureTextHashes}; the citation key is unique
   * per title, so the map is unambiguous within its scope.
   */
  snapshotTextHashes(title: number, part?: string): Map<string, string> {
    const sql =
      part === undefined
        ? `SELECT id, citation, text, heading FROM sections
           WHERE title = ? AND id > ? ORDER BY id LIMIT 500`
        : `SELECT id, citation, text, heading FROM sections
           WHERE title = ? AND part = ? AND id > ? ORDER BY id LIMIT 500`;
    const hashes = new Map<string, string>();
    const statement = this.stmt(sql);
    let cursor = -1;
    for (;;) {
      const rows = (
        part === undefined ? statement.all(title, cursor) : statement.all(title, part, cursor)
      ) as Record<string, unknown>[];
      if (rows.length === 0) break;
      for (const row of rows) {
        hashes.set(
          String(row['citation']),
          hashContent(String(row['text']), String(row['heading'])),
        );
        cursor = Number(row['id']);
      }
    }
    return hashes;
  }

  /**
   * The row for one citation of one title, either kind. `UNIQUE (title,
   * citation)` bounds the answer to a single row, so a kind-agnostic lookup
   * is unambiguous — the offline snapshot comparison resolves the kind from
   * the row it gets back.
   */
  getProvision(citation: string, title: number = DEFAULT_TITLE): SectionRow | null {
    const row = this.stmt(
      'SELECT * FROM sections WHERE citation = ? COLLATE NOCASE AND title = ? LIMIT 1',
    ).get(citation, title) as Record<string, unknown> | undefined;
    return row ? toSectionRow(row) : null;
  }

  private countMatches(ftsQuery: string, scope: SearchScope): number {
    const row = this.stmt(COUNT_MATCHES_SQL(scope.clause)).get(ftsQuery, ...scope.params) as
      Record<string, unknown> | undefined;
    return row ? Number(row['n'] ?? 0) : 0;
  }

  /**
   * Ranked full-text search.
   *
   * The CANDIDATE SET is the OR tier: every section that matches at least
   * one query term. The AND tier is no longer a candidate tier — requiring
   * EVERY term excluded the provision that answers the question from the
   * results altogether (§ 4.85 "Evaluation of hearing impairment." carries
   * neither "rated" nor "loss", so "how is hearing loss rated" never saw it),
   * and no ranking rule can surface a row that was never a candidate.
   *
   * The AND tier survives as a RANKING boost: a row that matches every
   * query term outranks a row that matches only some. The order is
   *
   *   1. the heading-phrase key (SPEC §4.1) DESC,
   *   2. the AND-tier membership DESC,
   *   3. the exception demotion ASC (gated off when the query itself
   *      asks about exceptions),
   *   4. bm25 ASC (lower is better),
   *   then `s.citation` ASC as the deterministic tie-break.
   *
   * `total` is the size of the candidate set — what the pagination walks.
   * Optional `part`/`kind`/`chapter` filters are exact column matches
   * applied to both the count and the ranked rows.
   */
  search(query: SearchQuery): SearchOutcome {
    const perPage = Math.max(1, query.perPage);
    const offset = (Math.max(1, query.page) - 1) * perPage;
    const filters = presentFilters(query);
    const title = query.title ?? DEFAULT_TITLE;
    const scope = scopeClause(title, filters);

    // ONE parse of the query feeds both tiers: the candidate query (OR) and
    // the AND-tier membership query (AND) are the same fragments joined
    // differently, so a query with no usable terms has no candidate set.
    // The builder is the SAME one `toFtsQuery` uses, so the hits and the
    // `inResults` membership check can never disagree (CR-15).
    const terms = queryTerms(query.query);
    const queries = buildFtsQueries(terms);
    if (queries === null) {
      return { hits: [], total: 0, page: query.page, perPage, matchMode: 'or' };
    }
    const { or: orQuery, and: andQuery } = queries;

    const total = this.countMatches(orQuery, scope);
    if (total === 0) {
      return { hits: [], total: 0, page: query.page, perPage, matchMode: 'or' };
    }

    const key = headingMatchKey(terms);
    const demotion = asksAboutExceptions(terms) ? '' : `${EXCEPTION_DEMOTION_KEY}, `;
    const sql = SELECT_MATCHES_SQL(scope.clause, `${key.clause}${AND_TIER_KEY}, ${demotion}`);
    const rows = this.stmt(sql).all(
      andQuery,
      orQuery,
      ...scope.params,
      ...key.params,
      perPage,
      offset,
    );

    const hits = rows.map((row) => {
      const record = row as Record<string, unknown>;
      const hit = {
        title: Number(record['title'] ?? DEFAULT_TITLE),
        citation: String(record['citation']),
        heading: String(record['heading']),
        part: nullableString(record['part']),
        path: String(record['path']),
        snippet: tidySnippet(String(record['snippet'] ?? '')),
        issueDate: String(record['issue_date']),
        score: Number(record['score'] ?? 0),
      };
      return { ...hit, matches: visibleMatches(terms, hit) };
    });
    return { hits, total, page: query.page, perPage, matchMode: 'or' };
  }

  /**
   * Whether an exact citation participates in the FTS result set for this
   * query/mode — used by the service to adjust `total` when it prepends a
   * direct citation hit that FTS itself did not return.
   *
   * The mode MUST mirror the tier the candidate set came from: the search
   * runs the OR tier, so a caller asking "is this citation among the
   * results?" has to ask about the OR tier, or the pin's `total` adjustment
   * counts a citation the results already contain.
   */
  hasSearchMatch(
    mode: MatchMode,
    rawQuery: string,
    citation: string,
    title: number = DEFAULT_TITLE,
  ): boolean {
    const ftsQuery = toFtsQuery(rawQuery, mode);
    if (ftsQuery === null) return false;
    const row = this.stmt(DIRECT_MATCH_SQL).get(ftsQuery, citation, title);
    return row !== undefined;
  }

  /**
   * Every part present in ONE title's slice of the index, with per-kind
   * counts.
   *
   * The counts are scoped to a title (default {@link DEFAULT_TITLE}): the
   * store holds every enabled title's rows, and a part number can appear
   * in more than one of them. A combined count would report a Title 38
   * part's sections under Title 38's structure tree.
   */
  listParts(title: number = DEFAULT_TITLE): {
    part: string;
    sections: number;
    appendices: number;
  }[] {
    const rows = this.stmt(
      `
      SELECT part,
             SUM(kind = 'section') AS sections,
             SUM(kind = 'appendix') AS appendices
      FROM sections
      WHERE title = ? AND part IS NOT NULL AND part != ''
      GROUP BY part
      ORDER BY CAST(part AS INTEGER), part
    `,
    ).all(title) as Record<string, unknown>[];
    return rows.map((row) => ({
      part: String(row['part']),
      sections: Number(row['sections'] ?? 0),
      appendices: Number(row['appendices'] ?? 0),
    }));
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
