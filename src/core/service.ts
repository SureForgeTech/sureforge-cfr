import { z } from 'zod';
import { ServiceError } from './errors.js';
import { normalizeCitation, normalizeTitledCitation } from './citations.js';
import { datedSourceUrlFor, sourceUrlFor } from './urls.js';
import { extractReferences } from './references.js';
import { normalizePartNumber, PART_NUMBER_PATTERN } from './part-number.js';
import { syncChangesSchema, type SyncChanges } from './changes.js';
import { diffIssues, type IssueDiff } from './diff.js';
import { redlineSection, type SectionRedline } from './redline.js';
import type { EcfrApi } from './ecfr.js';
import type { Logger } from '../logger.js';
import {
  browse as browseStructure,
  parseStructure,
  type BrowseResult,
  type StructureNode,
} from './structure.js';
import {
  contentTerms,
  hitWords,
  queryTerms,
  termResponded,
  type MatchMode,
  type QueryTerm,
  visibleMatches,
} from './query.js';
import { DEFAULT_TITLE, Store, type SearchHit, type SectionRow, type TitleScope } from './store.js';

/**
 * Application facade shared by the MCP server and the HTTP API. All input
 * validation happens here so both surfaces behave identically.
 */

/**
 * The query length the index accepts. Exported so the CLI can refuse a
 * query the service would reject BEFORE it opens the index: a rejected
 * query must not cost a 2-3 MB sync (a rejected input is the user's
 * mistake, and it must not be billed to the network).
 */
export const SEARCH_QUERY_MIN_LENGTH = 3;
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * The title a read is scoped to: one title number, or the literal `all`.
 *
 * The wire forms differ — an MCP client sends a number, an HTTP client a
 * query string, a CLI user a flag — so the SERVICE owns the parse: every
 * surface hands the raw value over and this schema decides what it means.
 * A canonical decimal STRING is accepted (that is what a query string carries), and
 * `all` is accepted only where the surface allows it (a search); a section
 * read refuses it afterwards, with a message that says why.
 */
const titleScopeSchema = z.preprocess(
  (value) => (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value),
  z.union([z.literal('all'), z.number().int().min(1).max(50)]),
);

const searchInputSchema = z.object({
  query: z.string().trim().min(SEARCH_QUERY_MIN_LENGTH).max(SEARCH_QUERY_MAX_LENGTH),
  page: z.number().int().min(1).max(10_000).default(1),
  perPage: z.number().int().min(1).max(20).default(10),
  part: z
    .string()
    .regex(PART_NUMBER_PATTERN)
    // The canonical spelling: "04" names part 4. Without it the filter
    // matches no row, and the search answers "no hits" for a part that
    // holds hits.
    .transform(normalizePartNumber)
    .optional(),
  kind: z.enum(['section', 'appendix']).optional(),
  chapter: z
    .string()
    .min(1)
    .max(8)
    .regex(/^[IVXLCDM]+$/)
    .optional(),
  title: titleScopeSchema.optional(),
});

/** The title a read names, parsed on its own (a section read takes no query). */
const titleInputSchema = z.object({ title: titleScopeSchema.optional() });

export interface SearchInput {
  readonly query: string;
  readonly page?: number | undefined;
  readonly perPage?: number | undefined;
  readonly part?: string | undefined;
  readonly kind?: 'section' | 'appendix' | undefined;
  readonly chapter?: string | undefined;
  /**
   * The CFR title the search runs in: a title number, or the literal `all`
   * (every stored title — a search-only scope). Absent means Title 38, the
   * wire-compatible default.
   */
  readonly title?: number | string | undefined;
}

/** A search hit dressed for human/legal consumption. */
export interface PresentedHit extends Omit<SearchHit, 'issueDate'> {
  /**
   * The CFR title this hit belongs to — inherited from the store's row, so
   * a hit in a cross-title search says which authority it came from.
   */
  readonly title: number;
  /** Paste-ready legal citation, e.g. `38 C.F.R. § 4.130`. */
  readonly citationDisplay: string;
  /** Permalink to the provision on ecfr.gov. */
  readonly sourceUrl: string;
  /**
   * The same provision at the index's issue date — the URL that proves which
   * revision the text was read at. `sourceUrl` is the CURRENT text.
   */
  readonly sourceUrlAtIndexDate: string;
  /** True when this row was pinned because the query *is* this citation. */
  readonly direct: boolean;
  /** True when the section matched the ranked search. For non-pin hits
   * this is always true (they came from the search). For pin hits
   * (`direct: true`) it reports whether the pin also appeared in the
   * ranked results. */
  readonly inResults: boolean;
  /** Part title from the index's structure tree, without the "Part N—" prefix;
   * null when the hit has no part, the part has no title, or the map is empty. */
  readonly partTitle: string | null;
}

export interface SearchResponse {
  readonly query: string;
  readonly page: number;
  readonly perPage: number;
  /**
   * Size of the CANDIDATE SET — every provision matching at least one query
   * term, plus the pinned citation when the candidate set did not already
   * hold it. The increment is identical on every page.
   */
  readonly total: number;
  /**
   * The tier the candidate set came from. The OR tier is the only candidate
   * tier, so this reports `or`; the field stays for wire compatibility.
   */
  readonly matchMode: MatchMode;
  readonly hits: readonly PresentedHit[];
  /** Issue date of the local index backing these results. */
  readonly indexIssueDate: string | null;
  /** True when the local index is older than CFR_MAX_AGE_DAYS. */
  readonly indexStale: boolean;
  /** Stale-index warning and out-of-scope citation guidance, when applicable. */
  readonly notice: string | null;
  /**
   * The query's content terms that the returned hits answered.
   *
   * A term counts as answered when a hit's text carries the term's words,
   * or every word of one of the corpus phrases the term stands for — the
   * same reading the search itself used.
   */
  readonly matchedTerms: readonly string[];
  /**
   * The query's content terms that NO returned hit answered.
   *
   * This says what the RESULTS did not speak to — never what Title 38
   * covers. A term can be unmatched because the governing provision sits
   * outside the returned window, because it uses other words, or because
   * the corpus does not discuss it at all.
   */
  readonly unmatchedTerms: readonly string[];
}

/**
 * Split the query's content terms into those the returned hits answered and
 * those they did not.
 *
 * The test is the same one the per-hit `matches` uses, so the response can
 * never claim a term was missing that the search actually looked for.
 */
function grounding(
  terms: readonly QueryTerm[],
  hits: readonly PresentedHit[],
): { matchedTerms: string[]; unmatchedTerms: string[] } {
  const words = hits.map((hit) => hitWords(hit));
  const matchedTerms: string[] = [];
  const unmatchedTerms: string[] = [];
  for (const term of contentTerms(terms)) {
    const answered = words.some((hit) => termResponded(term, hit));
    (answered ? matchedTerms : unmatchedTerms).push(term.term);
  }
  return { matchedTerms, unmatchedTerms };
}

const citationInputSchema = z.string().trim().min(1).max(120);

const browseInputSchema = z.object({
  chapter: z.string().trim().min(1).max(20).optional(),
  part: z.string().trim().min(1).max(20).optional(),
  subpart: z.string().trim().min(1).max(20).optional(),
  // A subject group's identifier is the eCFR's own node id (e.g.
  // "ECFRd158704dcab040e") — 18 chars in the 2026-10-16 corpus.
  subjgrp: z.string().trim().min(1).max(40).optional(),
});

export interface BrowseInput {
  readonly chapter?: string | undefined;
  readonly part?: string | undefined;
  readonly subpart?: string | undefined;
  readonly subjgrp?: string | undefined;
}

export interface SectionDetail {
  /**
   * The CFR title this provision belongs to.
   *
   * A read never blends two authorities: the title says which one this
   * text is (multi-title design, 2026-11-13).
   */
  readonly title: number;
  readonly citation: string;
  readonly kind: 'section' | 'appendix';
  readonly heading: string;
  readonly chapter: string | null;
  readonly part: string | null;
  readonly subpart: string | null;
  readonly path: string;
  readonly issueDate: string;
  readonly markdown: string;
  readonly text: string;
  readonly sourceUrl: string;
  /**
   * The same provision at the revision THIS index was built from — the
   * eCFR point-in-time URL for the index's issue date. `sourceUrl` points
   * at the CURRENT text (for navigation and verification); this one points
   * at the text the index actually holds, so a reader (or an agent) can
   * open exactly the words that were quoted.
   */
  readonly sourceUrlAtIndexDate: string;
  /** Citations referenced from this text, with local-availability flags. */
  readonly references: ReadonlyArray<{ readonly citation: string; readonly available: boolean }>;
  /**
   * Citations of indexed sections whose text references this one (reverse
   * direction of `references`, served from the materialized edge table).
   * Sorted lexicographically; empty array when nothing cites it.
   */
  readonly citedBy: ReadonlyArray<string>;
  /**
   * Structural Citation Support (SCS) diagnostics — the query-independent
   * vector (G, P, I) from docs/research/ranking-instrument-design-2026-11-01.md
   * §3.1: distinct citing sections overall (`total`), restricted to the same
   * part (`part`), and further to the same subject group (`subjectGroup`).
   * Diagnostic output only: search ranking and candidate sets never read it.
   */
  readonly citationSupport: {
    readonly subjectGroup: number;
    readonly part: number;
    readonly total: number;
  };
  /** True when the local index backing this read is older than CFR_MAX_AGE_DAYS. */
  readonly indexStale: boolean;
  /** Warning to surface when the index is stale; null otherwise. */
  readonly notice: string | null;
}

export interface IndexStatus {
  readonly issueDate: string | null;
  readonly syncedAt: string | null;
  readonly sections: number;
  readonly appendices: number;
  readonly stale: boolean;
  readonly maxAgeDays: number;
  readonly parserVersion: string | null;
  /** True when parsed counts differ from the structure tree; null when never recorded. */
  readonly structureDrift: boolean | null;
  /** What the most recent sync changed at the provision level; null before any sync. */
  readonly lastChanges: SyncChanges | null;
  /**
   * The corpus receipt (SPEC §4): sha256 over the whole corpus's
   * per-provision content hashes at rebuild time. Null on indexes built
   * before the receipt existed.
   */
  readonly corpusHash: string | null;
}

/** Coarse readiness enum for MCP clients gating queries on one call. */
export interface HealthReport {
  readonly status: 'empty' | 'degraded' | 'stale' | 'ready';
  readonly issueDate: string | null;
  readonly syncedAt: string | null;
  readonly stale: boolean;
}

/** One part present in the local index. */
export interface PartSummary {
  readonly part: string;
  readonly title: string | null;
  readonly sections: number;
  readonly appendices: number;
}

/** Strip a leading `Part <id>—` prefix from a structure label for display. */
function partTitle(identifier: string, label: string): string {
  const prefix = `Part ${identifier}`;
  if (label.startsWith(prefix)) {
    const rest = label.slice(prefix.length).replace(/^[—–\-:.\s]+/, '');
    if (rest.length > 0) return rest;
  }
  return label;
}

function collectPartTitles(node: StructureNode, into: Map<string, string>): void {
  if (node.type === 'part') into.set(node.identifier, partTitle(node.identifier, node.label));
  for (const child of node.children) collectPartTitles(child, into);
}

/**
 * Plain-language guidance for a rejected input, keyed by the field AND by
 * the rule that was broken.
 *
 * The validation library's own phrasing — "Too small: expected string to
 * have >=3 characters" — is developer-facing. The people reading this tool
 * are claims practitioners, so a rejected input says what to type instead.
 *
 * The rule matters as much as the field. `page` can be the wrong type
 * (`?page=1.5`) or out of range (`?page=0`), and a hint that always
 * states the range answers a question the request did not ask. Each entry
 * therefore names the rule it explains, and an input that breaks a rule
 * with no entry keeps the library's own wording.
 */
type Hints = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * The guidance for a title, shared by the search and the section read.
 *
 * The rule is one: a title is a CFR title NUMBER (1-50), or the literal
 * `all` — and `all` is a search-only scope, so a read that names it is
 * refused with its own message further down.
 */
const TITLE_HINTS: Readonly<Record<string, string>> = {
  invalid_union: 'the title must be a CFR title number (1-50) or `all`',
  too_small: 'the title number starts at 1',
  too_big: 'the title number may be at most 50',
};

const SEARCH_HINTS: Hints = {
  query: {
    too_small: `the query needs at least ${SEARCH_QUERY_MIN_LENGTH} characters`,
    too_big: `the query may be at most ${SEARCH_QUERY_MAX_LENGTH} characters`,
  },
  page: {
    invalid_type: 'the page number must be a whole number',
    too_small: 'the page number starts at 1',
    too_big: 'the page number may be at most 10000',
  },
  perPage: {
    invalid_type: 'the number of results per page must be a whole number',
    too_small: 'the number of results per page starts at 1',
    too_big: 'the number of results per page may be at most 20',
  },
  part: { invalid_format: 'the part must be a number such as 4' },
  kind: { invalid_value: 'the kind must be `section` or `appendix`' },
  chapter: {
    too_small: 'the chapter must be at least one character',
    too_big: 'the chapter may be at most 8 characters',
    invalid_format: 'the chapter must be a Roman numeral such as I, II or IV',
  },
  title: TITLE_HINTS,
};

/**
 * The same, for the fields `browse` accepts. Separate from the search
 * guidance because the two schemas differ: search's `chapter` must be a
 * Roman numeral of at most 8 characters, while browse's is the identifier
 * the hierarchy prints, capped only by length.
 */
const BROWSE_HINTS: Hints = {
  chapter: {
    too_small: 'the chapter must be at least one character',
    too_big: 'the chapter may be at most 20 characters — the hierarchy prints it as I or II',
  },
  part: {
    too_small: 'the part must be at least one character',
    too_big: 'the part may be at most 20 characters — the hierarchy prints it as 4',
  },
  subpart: {
    too_small: 'the subpart must be at least one character',
    too_big: 'the subpart may be at most 20 characters — the hierarchy prints it as B',
  },
  subjgrp: {
    too_small: 'the subject group must be at least one character',
    too_big:
      'the subject group may be at most 40 characters — it is the eCFR node id, such as ECFRd158704dcab040e',
  },
};

/**
 * Guidance for the citation a section read accepts. The schema caps its
 * length; whether it names a real provision is a separate check with its
 * own message.
 */
const CITATION_HINTS: Hints = {
  input: {
    too_small: 'the citation must be at least one character',
    too_big: 'the citation may be at most 120 characters',
  },
  title: TITLE_HINTS,
};

/**
 * Validate a search input against the schema the service uses.
 *
 * Exported so the CLI can refuse a bad flag BEFORE the index is opened: a
 * rejected flag is the reader's mistake, and it must not be billed to a
 * 2-3 MB sync — the same rule the query length follows.
 *
 * The errors are the service's plain-language ones, so the CLI and the API
 * cannot drift in what they say about a rejected search.
 */
export function validateSearchInput(input: SearchInput): z.infer<typeof searchInputSchema> {
  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) toServiceError(parsed.error, SEARCH_HINTS);
  return parsed.data;
}

function toServiceError(error: unknown, hints: Hints): never {
  if (error instanceof z.ZodError) {
    const details = error.issues
      .map((issue) => {
        const field = issue.path.join('.') || 'input';
        // The hint must state the rule that was broken — a field can break
        // more than one — so the lookup is by rule as well as by field.
        return hints[field]?.[issue.code] ?? `${field}: ${issue.message}`;
      })
      .join('; ');
    throw new ServiceError(`invalid input: ${details}`, 'invalid_input');
  }
  throw error;
}

/**
 * Permalink to the SAME provision at a DATED revision on ecfr.gov — the
 * `/on/<date>/…` form, which keeps the date in the canonical path (the
 * `/current/` form drops it).
 *
 * Verified 2026-10-20 against the live site: both forms answer 302 to a
 * canonical path that PRESERVES the date, e.g.
 *   /on/2026-10-16/title-38/section-4.125
 *     -> /on/2026-10-16/title-38/chapter-I/part-4/subpart-B/subject-group-…/section-4.125
 * The appendix form needs the citation URL-ENCODED (the unencoded form
 * answers 404):
 *   /on/2026-10-16/title-38/appendix-Appendix%20A%20to%20Part%204
 *     -> /on/2026-10-16/title-38/chapter-I/part-4/appendix-Appendix%20A%20to%20Part%204
 *
 * The URL shapes themselves live in `src/core/urls.ts` (CR-16), shared with
 * the point-in-time read in `src/core/historical.ts`.
 */

/** Sections are numeric citations; everything else is an appendix name. */
function kindForCitation(citation: string): 'section' | 'appendix' {
  return /^\d/.test(citation) ? 'section' : 'appendix';
}

/**
 * Paste-ready display form for hits.
 *
 * Title 38 keeps its published form (`38 C.F.R. § 4.130`): that string is a
 * frozen contract — SPEC §6 and the tests that pin it. Every other title
 * uses the plain form (`32 CFR § 70.1`). The display form must NAME the
 * authority, because two authorities are never blended into one unlabeled
 * list (multi-title design, 2026-11-13). Title 38 appendices keep their
 * bare names. Other appendices carry their title prefix.
 */
function displayCitation(kind: 'section' | 'appendix', citation: string, title: number): string {
  if (kind === 'appendix') return title === DEFAULT_TITLE ? citation : `${title} CFR ${citation}`;
  if (title === DEFAULT_TITLE) return `38 C.F.R. § ${citation}`;
  return `${title} CFR § ${citation}`;
}

/** Strip trailing paragraph designators: `3.350(a)(4)` → `3.350`. */
function stripParagraphSuffix(query: string): string {
  // Loop with a flat anchored pattern instead of one nested quantifier —
  // identical behavior, and linear-time for ReDoS checkers.
  let stripped = query.trim();
  for (;;) {
    const next = stripped.replace(/\s*\([a-z0-9]{1,4}\)$/i, '');
    if (next === stripped) return next;
    stripped = next;
  }
}

/**
 * A citation, with the CFR title it NAMES when it names one.
 *
 * `32 CFR § 70.1` names Title 32; `4.125` uses the request's scope.
 */
interface ResolvedCitation {
  readonly kind: 'section' | 'appendix';
  readonly citation: string;
  readonly title: number | undefined;
}

/**
 * The provision a citation names, and the authority it names with it.
 *
 * The title-named parser runs FIRST: a citation that names its title is
 * the form the product prints, and it settles the authority on its own.
 */
function parseCitation(input: string): ResolvedCitation | null {
  const titled = normalizeTitledCitation(input);
  if (titled !== null) return titled;
  const plain = normalizeCitation(input);
  return plain === null ? null : { ...plain, title: undefined };
}

/** First sentence(s) of a section's text, capped at ~200 chars on a boundary. */
function excerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 200) return clean;
  const window = clean.slice(0, 200);
  const stop = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
  );
  if (stop >= 100) return clean.slice(0, stop + 1);
  const word = window.lastIndexOf(' ');
  return `${window.slice(0, word > 0 ? word : 200)}…`;
}

/** Stale-index warning shared by search and section reads. */
function noticeFor(status: IndexStatus, scope: TitleScope): string | null {
  if (!status.stale) return null;
  const title = scope === 'all' ? '<title>' : scope;
  return (
    `local index is stale (issue date ${status.issueDate ?? 'unknown'}, ` +
    `synced ${status.syncedAt ?? 'never'}, limit ${status.maxAgeDays} days) — ` +
    'verify against the current eCFR before relying on this text; for the version ' +
    'in force on a past date (e.g. the date of claim) use the eCFR point-in-time ' +
    `URL /on/<YYYY-MM-DD>/title-${title}/section-<citation>`
  );
}

/**
 * Read-only operations over the local index.
 *
 * The index holds every enabled CFR title's rows; every read is scoped to
 * the title the caller names or defaults to Title 38. Search can also span
 * all stored titles (multi-title design, 2026-11-13).
 */
export class CFRService {
  private readonly store: Store;
  private readonly maxAgeDays: number;
  /**
   * Optional point-in-time stack (batch-7 D2 diff, batch-8 E1 redline):
   * injected by `serve`/`mcp`, absent in plain index readers and tests — the
   * facades below fail closed without it.
   */
  private readonly ecfr: EcfrApi | undefined;
  private readonly logger: Logger | undefined;
  /**
   * Memoised part-number → display-title maps, one per title: a title's
   * structure tree names ITS parts, and a Title 32 part 70 is not Title
   * 38's part 70.
   */
  private partTitles: Map<number, Map<string, string>> = new Map();

  constructor(store: Store, maxAgeDays: number, ecfr?: EcfrApi, logger?: Logger) {
    this.store = store;
    this.maxAgeDays = maxAgeDays;
    this.ecfr = ecfr;
    this.logger = logger;
  }

  search(input: SearchInput): SearchResponse {
    const { query, page, perPage, part, kind, chapter, title } = validateSearchInput(input);
    // The scope is the SERVICE's decision: an absent title means Title 38
    // (the wire-compatible default), `all` means every stored title.
    const scope: TitleScope = title ?? DEFAULT_TITLE;
    const outcome = this.store.search({ query, page, perPage, part, kind, chapter, title: scope });
    const citation = parseCitation(stripParagraphSuffix(query));
    const citedTitle = citation?.title;
    const scopeNotice =
      scope !== 'all' && citedTitle !== undefined && citedTitle !== scope
        ? `The citation names Title ${citedTitle}, outside the Title ${scope} search scope. Pass title=${citedTitle} to search that title.`
        : null;
    const pins =
      citation === null || scopeNotice !== null
        ? []
        : this.directHits(query, citation, { part, kind, chapter }, scope);

    let hits = outcome.hits.map((hit) => this.presentHit(hit, false));
    let total = outcome.total;
    if (pins.length > 0) {
      // The pin-adjusted total must be identical on every page: the union of
      // all pages is what `total` describes, and each pin is part of that
      // union whether FTS found it or not.
      total += pins.filter((pin) => !pin.inResults).length;
      // Later pages drop their natural copy of the pinned provisions: they
      // were already shown on page 1, so keeping them would duplicate the
      // hit across the pagination sequence. A pin is identified by its
      // (title, citation) PAIR: the same citation in two titles is two
      // provisions, and dropping one of them would hide a title's copy.
      const pinned = new Set(pins.map((pin) => `${pin.title}:${pin.citation}`));
      hits = hits.filter((hit) => !pinned.has(`${hit.title}:${hit.citation}`));
      if (page === 1) hits = [...pins, ...hits];
    }

    const status = this.status();
    const groundingTerms = grounding(queryTerms(query), hits);
    return {
      query,
      page,
      perPage,
      total,
      matchMode: outcome.matchMode,
      hits,
      indexIssueDate: status.issueDate,
      indexStale: status.stale,
      notice: [noticeFor(status, scope), scopeNotice].filter(Boolean).join('. ') || null,
      matchedTerms: groundingTerms.matchedTerms,
      unmatchedTerms: groundingTerms.unmatchedTerms,
    };
  }

  /**
   * Pin the exact provision(s) when the query itself is a citation —
   * adjudicators paste `38 CFR 4.130(a)` constantly, and keyword noise above
   * the exact section would be a correctness failure.
   *
   * A titled citation pins only its own title's copy and only if that title
   * is in scope. An untitled citation pins every copy in scope.
   *
   * Computed on every page so the pin-adjusted `total` stays consistent
   * across the pagination sequence; only page 1 prepends the hits
   * themselves. Honors the part/kind/chapter filters; `total` only counts a
   * pin when FTS did not already return it.
   */
  private directHits(
    query: string,
    normalized: ResolvedCitation,
    filters: {
      readonly part: string | undefined;
      readonly kind: 'section' | 'appendix' | undefined;
      readonly chapter: string | undefined;
    },
    scope: TitleScope,
  ): (PresentedHit & { readonly inResults: boolean })[] {
    const pinScope = normalized.title ?? scope;
    const rows =
      pinScope === 'all'
        ? this.store.sectionsForCitation(normalized.citation, normalized.kind)
        : [this.store.getSection(normalized.citation, normalized.kind, pinScope)].filter(
            (row): row is SectionRow => row !== null,
          );
    const pins: (PresentedHit & { readonly inResults: boolean })[] = [];
    for (const row of rows) {
      if (filters.part !== undefined && row.part !== filters.part) continue;
      if (filters.kind !== undefined && row.kind !== filters.kind) continue;
      if (filters.chapter !== undefined && row.chapter !== filters.chapter) continue;
      // The membership check MUST use the tier the candidate set came from —
      // the OR tier, the only candidate tier. Asking about the AND tier would
      // report a pinned citation as "not in the results" when the candidate
      // set holds it, and the pin would then be counted twice in `total`.
      const inResults = this.store.hasSearchMatch('or', query, row.citation, row.title);
      const snippet = excerpt(row.text);
      const hit = this.presentHit(
        {
          title: row.title,
          citation: row.citation,
          heading: row.heading,
          part: row.part,
          path: row.path,
          snippet,
          issueDate: row.issueDate,
          // Fabricated bm25, strictly better than any real score, so array order
          // and score order agree; `direct: true` is the reliable client signal.
          score: -1_000_000,
          matches: visibleMatches(queryTerms(query), {
            citation: row.citation,
            heading: row.heading,
            snippet,
          }),
        },
        true,
        inResults,
      );
      pins.push({ ...hit, inResults });
    }
    return pins;
  }

  /** Attach display citation, source URL, direct flag, and inResults to a raw hit. */
  private presentHit(hit: SearchHit, direct: boolean, inResults = true): PresentedHit {
    const { issueDate, ...rest } = hit;
    const kind = kindForCitation(hit.citation);
    const partTitleValue =
      hit.part === null || hit.part === undefined
        ? null
        : (this.partTitleMap(hit.title).get(hit.part) ?? null);
    return {
      ...rest,
      citationDisplay: displayCitation(kind, hit.citation, hit.title),
      sourceUrl: sourceUrlFor(hit.citation, kind, hit.title),
      sourceUrlAtIndexDate: datedSourceUrlFor(hit.citation, kind, issueDate, hit.title),
      direct,
      inResults,
      partTitle: partTitleValue,
    };
  }

  /**
   * Actionable not-found guidance: a section-shaped citation that missed the
   * index may be reserved, removed, or simply outside the title it was
   * looked for in — so say that, link the provision on eCFR, and surface
   * indexed sections that mention it (neighbors like `4.151a` frequently
   * explain the gap).
   *
   * The title it names is the one the read asked for; a read that named
   * none keeps the Title-38 wording, which is the published guidance for
   * the mission title.
   */
  private notFoundMessage(citation: string, title: number | undefined): string {
    // Phrase, not tokenized: `"4 150"` matches sections that actually
    // reference the citation, while bare tokens (`"4"* AND "150"*`) rank
    // unrelated sections that merely contain both fragments.
    const mentions = this.store
      .search({ query: `"${citation}"`, page: 1, perPage: 5, title: title ?? DEFAULT_TITLE })
      .hits.map((hit) => hit.citation)
      .filter((found) => found.toLowerCase() !== citation.toLowerCase());
    const base =
      title === undefined
        ? `no indexed content for citation ${citation} — it may be reserved, removed, ` +
          'or outside Title 38 as of the local issue date'
        : `no indexed content for citation ${citation} in Title ${title} — it may be reserved, ` +
          `removed, or outside Title ${title} as of the local issue date`;
    const verify = `verify it on eCFR: ${sourceUrlFor(
      citation,
      kindForCitation(citation),
      title ?? DEFAULT_TITLE,
    )}`;
    if (mentions.length === 0) return `${base}; ${verify}`;
    return `${base}; ${verify}. Indexed sections that mention it: ${mentions.join(', ')}`;
  }

  /**
   * The title a read names, parsed by the same rule the search uses.
   *
   * `undefined` means the read named no title (see {@link resolveSection}).
   */
  private parseTitle(value: number | string | undefined): TitleScope | undefined {
    const parsed = titleInputSchema.safeParse({ title: value });
    if (!parsed.success) toServiceError(parsed.error, CITATION_HINTS);
    return parsed.data.title;
  }

  /**
   * The provision a citation names, resolved against the titles the store
   * holds.
   *
   * A read searches exactly one title, defaulting to Title 38. On an untitled
   * miss, other stored titles can supply hints for a more specific request.
   *
   * `all` is refused: a read answers with ONE provision, and "every
   * stored title" would be a search scope, not an answer.
   */
  private resolveSection(
    citation: string,
    kind: 'section' | 'appendix',
    title: TitleScope | undefined,
  ): SectionRow {
    if (title === 'all') {
      throw new ServiceError(
        'a section read names ONE title — `all` is a search-only scope; ' +
          'pass the title you want (e.g. `title=32`)',
        'invalid_input',
      );
    }
    const row = this.store.getSection(citation, kind, title ?? DEFAULT_TITLE);
    if (row !== null) return row;
    let message = this.notFoundMessage(citation, title);
    if (title === undefined) {
      const titles = new Set(
        this.store.sectionsForCitation(citation, kind).map((row) => row.title),
      );
      for (const otherTitle of titles) {
        message += `. Title ${otherTitle} holds ${citation}; pass title=${otherTitle}`;
      }
    }
    throw new ServiceError(message, 'not_found');
  }

  /**
   * Fetch one section by citation (`4.125`, `§ 4.125`, `38 CFR 4.125`, …).
   *
   * The authority is settled by PRECEDENCE: the title the caller names
   * wins; a citation that names its own title (`32 CFR § 70.1`) settles it
   * next; and an untitled citation reads within Title 38 only.
   */
  getSection(citationInput: string, titleInput?: number | string | undefined): SectionDetail {
    const parsed = citationInputSchema.safeParse(citationInput);
    if (!parsed.success) toServiceError(parsed.error, CITATION_HINTS);
    const normalized = parseCitation(parsed.data);
    if (normalized === null) {
      throw new ServiceError(
        `unrecognized citation: ${JSON.stringify(citationInput)} (expected e.g. "4.125" or "38 CFR 4.125")`,
        'invalid_input',
      );
    }
    const requested = this.parseTitle(titleInput);
    if (
      requested !== undefined &&
      requested !== 'all' &&
      normalized.title !== undefined &&
      requested !== normalized.title
    ) {
      throw new ServiceError(
        `the citation names Title ${normalized.title} but the read asked for Title ${requested} — ` +
          'name one title',
        'invalid_input',
      );
    }
    const scope = requested === undefined ? normalized.title : requested;
    const row = this.resolveSection(normalized.citation, normalized.kind, scope);
    const status = this.status();
    return {
      title: row.title,
      citation: row.citation,
      kind: row.kind,
      heading: row.heading,
      chapter: row.chapter,
      part: row.part,
      subpart: row.subpart,
      path: row.path,
      issueDate: row.issueDate,
      markdown: row.markdown,
      text: row.text,
      sourceUrl: sourceUrlFor(row.citation, row.kind, row.title),
      sourceUrlAtIndexDate: datedSourceUrlFor(row.citation, row.kind, row.issueDate, row.title),
      references: extractReferences(row.text).map((citation) => ({
        citation,
        // Check availability within the provision's title because cross-title edges are out of scope.
        available: this.store.hasSection(citation, row.title),
      })),
      // Reverse edges keyed by the section's canonical (lowercase) citation —
      // the exact form extractReferences() stored at rebuild time. The edges
      // are the SECTION's title's edges: a cross-title edge never exists.
      citedBy: this.store.citedBy(row.citation, row.title),
      // Citation support uses the same title-scoped edges as citedBy.
      citationSupport: this.store.citationSupport(row.citation, row.title),
      indexStale: status.stale,
      notice: noticeFor(status, row.title),
    };
  }

  /** Navigate the structure tree; empty query returns the chapters. */
  browse(input: BrowseInput = {}): BrowseResult {
    const parsed = browseInputSchema.safeParse(input);
    if (!parsed.success) toServiceError(parsed.error, BROWSE_HINTS);
    if (parsed.data.subpart !== undefined && parsed.data.part === undefined) {
      throw new ServiceError("subpart navigation requires 'part'", 'invalid_input');
    }
    // A subject group hangs off a part (directly) or off a subpart, so the
    // part is the one level it always needs.
    if (parsed.data.subjgrp !== undefined && parsed.data.part === undefined) {
      throw new ServiceError("subject-group navigation requires 'part'", 'invalid_input');
    }
    const structureJson = this.store.getMeta('structure_json');
    if (structureJson === null) {
      throw new ServiceError('index has no structure data — run `cfr-free sync`', 'not_found');
    }
    let structure;
    try {
      structure = parseStructure(JSON.parse(structureJson));
    } catch {
      throw new ServiceError('stored structure is unreadable — run `cfr-free sync`', 'not_found');
    }
    return browseStructure(structure, parsed.data);
  }

  /**
   * Freshness report for the local index.
   *
   * Every number here describes the SERVING title (Title 38): the issue
   * date, the row counts and the structure-drift check are that title's
   * own. A multi-title store holds other authorities' rows too, and
   * counting them here would report a healthy index as drifted.
   */
  status(): IndexStatus {
    const issueDate = this.store.getMeta('issue_date');
    const syncedAt = this.store.getMeta('synced_at');
    const sections = this.store.countSections(DEFAULT_TITLE);
    const appendices = Number(this.store.getMeta('appendices_count') ?? '0');
    let stale = true;
    if (syncedAt !== null) {
      const ageMs = Date.now() - Date.parse(syncedAt);
      stale = !Number.isFinite(ageMs) || ageMs > this.maxAgeDays * 24 * 60 * 60 * 1000;
    }
    return {
      issueDate,
      syncedAt,
      sections,
      appendices,
      stale,
      maxAgeDays: this.maxAgeDays,
      parserVersion: this.store.getMeta('parser_version'),
      structureDrift: this.structureDrift(sections),
      lastChanges: this.lastChanges(),
      corpusHash: this.store.getMeta('corpus_hash'),
    };
  }

  /** Parsed sync-change record; corrupted meta degrades to null, never throws. */
  private lastChanges(): SyncChanges | null {
    const raw = this.store.getMeta('last_changes');
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    // A syntactically valid record is not necessarily a VALID one: the
    // schema is what makes the doc comment true (CR-20).
    const result = syncChangesSchema.safeParse(parsed);
    return result.success ? (result.data as SyncChanges) : null;
  }

  /**
   * One-call readiness verdict for MCP clients: `empty` (no index yet),
   * `degraded` (structure drift — live rows disagree with the structure
   * tree, so provisions may be missing), `stale` (aged past
   * CFR_MAX_AGE_DAYS), or `ready` (query away). Precedence is
   * empty → degraded → stale → ready: incomplete data is the less safe
   * failure, and the `stale` boolean below still reports age alongside.
   */
  health(): HealthReport {
    const status = this.status();
    const state: HealthReport['status'] =
      status.sections === 0
        ? 'empty'
        : status.structureDrift === true
          ? 'degraded'
          : status.stale
            ? 'stale'
            : 'ready';
    return {
      status: state,
      issueDate: status.issueDate,
      syncedAt: status.syncedAt,
      stale: status.stale,
    };
  }

  /**
   * Compare the live row total against the structure-tree expectations
   * recorded at sync time. Null when an old index predates the expectation
   * meta. Catches both parse drift (warned at sync) and vanished rows.
   */
  private structureDrift(sections: number): boolean | null {
    const expectedSectionsRaw = this.store.getMeta('structure_expected_sections');
    const expectedAppendicesRaw = this.store.getMeta('structure_expected_appendices');
    if (expectedSectionsRaw === null || expectedAppendicesRaw === null) return null;
    const expectedSections = Number(expectedSectionsRaw);
    const expectedAppendices = Number(expectedAppendicesRaw);
    if (!Number.isFinite(expectedSections) || !Number.isFinite(expectedAppendices)) return true;
    return sections !== expectedSections + expectedAppendices;
  }

  /**
   * Build (once per title) and return the memoised part-number →
   * display-title map for ONE title.
   *
   * Each title carries its own structure tree (`title.<N>.structure_json`);
   * the legacy global key is Title 38's, so it is the fallback there. A
   * Title 32 hit must not be labeled with Title 38's part title: the two
   * titles' part numbers are different parts.
   *
   * An EMPTY map is memoised too: a missing or unreadable structure must
   * not be re-parsed on every search.
   */
  private partTitleMap(title: number): Map<string, string> {
    const cached = this.partTitles.get(title);
    if (cached !== undefined) return cached;
    const titles = new Map<string, string>();
    try {
      const structureJson =
        this.store.getMeta(`title.${title}.structure_json`) ??
        (title === DEFAULT_TITLE ? this.store.getMeta('structure_json') : null);
      if (structureJson !== null) {
        collectPartTitles(parseStructure(JSON.parse(structureJson)), titles);
      }
    } catch {
      // Unreadable or missing structure: degrade silently to an empty map.
    }
    this.partTitles.set(title, titles);
    return titles;
  }

  /** Parts present in the index, joined with titles from the structure tree. */
  listParts(): PartSummary[] {
    const titles = this.partTitleMap(DEFAULT_TITLE);
    return this.store.listParts().map((row) => ({
      part: row.part,
      title: titles.get(row.part) ?? null,
      sections: row.sections,
      appendices: row.appendices,
    }));
  }

  /**
   * Point-in-time diff of two eCFR issue dates (`/api/v1/diff`): a thin
   * facade over `diffIssues` so the HTTP surface shares the core's exact
   * validation and error semantics. BOTH dates are required — no default-to
   * resolution happens here (the store's `issue_date` lookup is the CLI's
   * convenience, deliberately not threaded behind this facade). Nothing is
   * prefetched: each call fetches both dates' full-title XML from eCFR,
   * through the client's own per-process document memo (see `ecfr.ts` —
   * short-lived, in memory, shared by concurrent readers of the same date).
   *
   * Every `serve`/`mcp` entrypoint injects the client and logger together;
   * the guard fails closed for test-constructed services without the diff
   * stack, so the route answers a clean mapped error instead of a crash.
   *
   * @throws {ServiceError} (`unavailable`) when no eCFR client was
   *   injected — a deployment fault, not the reader's argument;
   *   (`invalid_input`) when a date is malformed/impossible or the two dates
   *   are identical; upstream fetch failures surface as `HttpError`, or as
   *   `SemaphoreOverflowError` when the upstream fetch queue is full (the
   *   HTTP layer maps that to `503 upstream_busy`).
   */
  async diffBetween(fromDate: string, toDate: string): Promise<IssueDiff> {
    const { ecfr, logger } = this;
    if (ecfr === undefined || logger === undefined) {
      throw new ServiceError('diff unavailable — no eCFR client injected', 'unavailable');
    }
    return diffIssues({ ecfr, logger }, fromDate, toDate);
  }

  /**
   * Facade over `redlineSection` (batch-8 E1), mirroring `diffBetween`: the
   * guard fails closed without the injected client and logger, delegating to
   * the core otherwise. BOTH dates are required on the wire (no default-to
   * resolution); the core owns every validation (malformed/impossible/identical
   * dates, non-citation) and the `not_found` tripwire for a citation missing
   * from BOTH dates. Nothing is prefetched: each call fetches both dates'
   * full-title XML from eCFR, through the client's own per-process document
   * memo (see `ecfr.ts` — short-lived, in memory, shared by concurrent
   * readers of the same date).
   *
   * Every `serve`/`mcp` entrypoint injects the client and logger together;
   * the guard fails closed for test-constructed services without the redline
   * stack, so both wire surfaces answer a clean mapped error instead of a
   * crash.
   *
   * @throws {ServiceError} (`unavailable`) when no eCFR client was
   *   injected — a deployment fault, not the reader's argument;
   *   (`invalid_input`) when a date is malformed/impossible, the two dates
   *   are identical, or the citation is not recognizable; (`not_found`) when
   *   the citation is missing from BOTH dates' parse results; upstream fetch
   *   failures surface as `HttpError`, or as `SemaphoreOverflowError` when
   *   the upstream fetch queue is full (the HTTP layer maps that to
   *   `503 upstream_busy`).
   */
  async redlineBetween(
    fromDate: string,
    toDate: string,
    citation: string,
  ): Promise<SectionRedline> {
    const { ecfr, logger } = this;
    if (ecfr === undefined || logger === undefined) {
      throw new ServiceError('redline unavailable — no eCFR client injected', 'unavailable');
    }
    return redlineSection({ ecfr, logger }, fromDate, toDate, citation);
  }
}
