import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import { CHANGE_LIST_CAP, CORPUS_RECEIPT_LIMIT } from '../core/changes.js';
import { diffIssues } from '../core/diff.js';
import type { EcfrApi } from '../core/ecfr.js';
import { redlineSection } from '../core/redline.js';
import { ARCHIVE_FLOOR } from '../core/archive.js';
import { historicalSection } from '../core/historical.js';
import { PART_NUMBER_PATTERN } from '../core/part-number.js';
import {
  compareSnapshots,
  SNAPSHOT_RESPONSE_CHAR_BUDGET,
  SUMMARY_MAX_LINES,
} from '../core/snapshot-compare.js';
import { DEFAULT_TITLE } from '../core/titles.js';
import {
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  type CFRService,
} from '../core/service.js';
import { UNTRUSTED_DATA_NOTE } from './posture.js';
import { renderToolText, runTool } from './tool-result.js';

/**
 * MCP tool registrations. Every tool is read-only (never destructive,
 * idempotent). Seven read the local index with zero network access during
 * tool calls — search, section, browse, status, parts, health, and the
 * offline comparison of two stored snapshots (`compare_snapshots`);
 * `get_section_at`, `diff_issues` and `redline` are the deliberate network
 * exceptions — read-only everywhere, but each fetches from eCFR on demand (a
 * point-in-time revision, or two issue dates' full-title XML; see their
 * registrations below), which is why the server registers them only when an
 * eCFR client is injected.
 */

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// get_section_at, diff_issues and redline read from the live eCFR versioner — openWorld stays true while the other hints stay read-only.
const DIFF_ANNOTATIONS = {
  ...READ_ONLY_ANNOTATIONS,
  openWorldHint: true,
} as const;

/**
 * The MCP wire's size bound on ONE provision's body, in characters.
 *
 * `diff_issues` bounds its citation lists at {@link CHANGE_LIST_CAP} and
 * `compare_snapshots` its change entries at the same cap, each reporting a
 * `truncated` flag; a provision is one text, so the bound is a
 * character count. 100 000 characters ≈ 25k tokens: a large provision
 * (§ 4.130 is tens of KB) still fits a context, and a pathological one
 * cannot blow it. The parser's own guard (MAX_SECTION_CHARS = 400 000 in
 * src/core/xml.ts) is the upstream ceiling — this is the wire's, and it
 * applies to the MCP surface only: the HTTP API and the export command
 * serve the whole corpus on purpose.
 */
export const PROVISION_TEXT_CAP = 100_000;

/**
 * Cut one provision body at {@link PROVISION_TEXT_CAP} characters and
 * report whether it was cut. The cut never splits a surrogate pair: half a
 * character is not a character.
 */
function capProvision(body: string): { body: string; truncated: boolean } {
  if (body.length <= PROVISION_TEXT_CAP) return { body, truncated: false };
  let cut = body.slice(0, PROVISION_TEXT_CAP);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { body: cut, truncated: true };
}

const searchOutputSchema = z.object({
  query: z.string(),
  page: z.number(),
  perPage: z.number(),
  total: z.number(),
  matchMode: z.enum(['and', 'or']),
  indexIssueDate: z.string().nullable(),
  indexStale: z.boolean(),
  notice: z.string().nullable(),
  matchedTerms: z.array(z.string()),
  unmatchedTerms: z.array(z.string()),
  hits: z.array(
    z.object({
      title: z
        .number()
        .describe('the CFR title this hit belongs to — every hit names its own authority'),
      citation: z.string(),
      citationDisplay: z.string(),
      sourceUrl: z.string(),
      sourceUrlAtIndexDate: z.string(),
      direct: z.boolean(),
      heading: z.string(),
      part: z.string().nullable(),
      partTitle: z.string().nullable(),
      path: z.string(),
      snippet: z.string(),
      score: z.number(),
      matches: z.array(z.string()),
      inResults: z.boolean(),
    }),
  ),
});

const sectionOutputSchema = z.object({
  title: z.number().describe('the CFR title this provision belongs to'),
  citation: z.string(),
  kind: z.enum(['section', 'appendix']),
  heading: z.string(),
  chapter: z.string().nullable(),
  part: z.string().nullable(),
  subpart: z.string().nullable(),
  path: z.string(),
  issueDate: z.string(),
  markdown: z.string(),
  text: z.string(),
  sourceUrl: z.string(),
  sourceUrlAtIndexDate: z.string(),
  references: z.array(z.object({ citation: z.string(), available: z.boolean() })),
  citedBy: z.array(z.string()),
  citationSupport: z
    .object({
      subjectGroup: z
        .number()
        .describe('distinct citing sections in the same part and subject group'),
      part: z.number().describe('distinct citing sections in the same part'),
      total: z.number().describe('distinct citing sections overall (self-citations excluded)'),
    })
    .describe(
      'Structural Citation Support diagnostics — distinct citing sections, narrowed by shared structure. ' +
        'Diagnostic output only: never a search-ranking input and never a candidate-set filter.',
    ),
  indexStale: z.boolean(),
  notice: z.string().nullable(),
  truncated: z
    .boolean()
    .describe(
      `true when the provision body was cut at the ${PROVISION_TEXT_CAP}-character cap — the text below is incomplete`,
    ),
});

const structureEntrySchema = z.object({
  type: z.string(),
  identifier: z.string(),
  label: z.string(),
});

const browseOutputSchema = z.object({
  node: structureEntrySchema,
  path: z.array(structureEntrySchema),
  children: z.array(structureEntrySchema),
});

const statusOutputSchema = z.object({
  issueDate: z.string().nullable(),
  syncedAt: z.string().nullable(),
  sections: z.number(),
  appendices: z.number(),
  stale: z.boolean(),
  maxAgeDays: z.number(),
  parserVersion: z.string().nullable(),
  structureDrift: z.boolean().nullable(),
  corpusHash: z.string().nullable(),
  lastChanges: z
    .object({
      fromIssueDate: z.string().nullable(),
      toIssueDate: z.string(),
      changed: z.number(),
      added: z.number(),
      removed: z.number(),
      changedCitations: z.array(z.string()),
      addedCitations: z.array(z.string()),
      removedCitations: z.array(z.string()),
      baseline: z.boolean(),
      parserChanged: z.boolean(),
      recordedAt: z.string(),
    })
    .nullable(),
});

const listPartsOutputSchema = z.object({
  parts: z.array(
    z.object({
      part: z.string(),
      title: z.string().nullable(),
      sections: z.number(),
      appendices: z.number(),
    }),
  ),
});

const healthOutputSchema = z.object({
  status: z.enum(['empty', 'degraded', 'stale', 'ready']),
  issueDate: z.string().nullable(),
  syncedAt: z.string().nullable(),
  stale: z.boolean(),
});

const dateArgSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('eCFR issue date, YYYY-MM-DD');

/**
 * The point-in-time read's payload: the REQUESTED date and the text as it
 * stood then. eCFR does not report which issue date it served, so no
 * served-revision date is claimed.
 */
const historicalOutputSchema = z.object({
  requestedDate: z.string(),
  citation: z.string(),
  kind: z.enum(['section', 'appendix']),
  heading: z.string(),
  chapter: z.string().nullable(),
  part: z.string().nullable(),
  subpart: z.string().nullable(),
  path: z.string(),
  text: z.string(),
  markdown: z.string(),
  sourceUrl: z.string(),
  sourceUrlAtRequestedDate: z.string(),
  truncated: z
    .boolean()
    .describe(
      `true when the provision body was cut at the ${PROVISION_TEXT_CAP}-character cap — the text below is incomplete`,
    ),
});

const changeReportOutputSchema = z.object({
  fromIssueDate: z.string(),
  toIssueDate: z.string(),
  changed: z
    .array(z.string())
    .describe(`citations whose content changed — text or heading — capped at ${CHANGE_LIST_CAP}`),
  added: z
    .array(z.string())
    .describe(`citations added at the to-date — capped at ${CHANGE_LIST_CAP}`),
  removed: z
    .array(z.string())
    .describe(`citations removed by the to-date — capped at ${CHANGE_LIST_CAP}`),
  truncated: z
    .boolean()
    .describe(`true when any citation list was cut at the ${CHANGE_LIST_CAP}-citation cap`),
  notice: z
    .string()
    .describe(
      'the limit on what the two dates mean: eCFR serves the revision in force on the ' +
        'requested date and does not report which issue date that is, so the dates are ' +
        'selectors and not a stamp of the revision served',
    ),
});

/**
 * Mirrors the core's SectionRedline (src/core/redline.ts) verbatim — the core
 * is the contract, so the wire adds nothing and caps nothing (the core's own
 * MAX_REDLINE_LINES coarse fallback is the only bound). `fromText`/`toText`
 * are optional because the core omits them when the provision did not exist on
 * that date.
 */
const redlineOutputSchema = z.object({
  fromIssueDate: z.string(),
  toIssueDate: z.string(),
  citation: z.string(),
  status: z.enum(['changed', 'added', 'removed', 'unchanged']),
  fromText: z.string().optional(),
  toText: z.string().optional(),
  hunks: z.array(
    z.object({
      fromLine: z.number().nullable(),
      toLine: z.number().nullable(),
      type: z.enum(['same', 'add', 'del']),
      text: z.string(),
    }),
  ),
  coarse: z.boolean(),
  notice: z
    .string()
    .describe(
      'the limit on what the two dates mean: eCFR serves the revision in force on the ' +
        'requested date and does not report which issue date that is, so the dates are ' +
        'selectors and not a stamp of the revision served',
    ),
});

type SearchOutput = z.infer<typeof searchOutputSchema>;
type SectionOutput = z.infer<typeof sectionOutputSchema>;
type BrowseOutput = z.infer<typeof browseOutputSchema>;
type StatusOutput = z.infer<typeof statusOutputSchema>;
type ListPartsOutput = z.infer<typeof listPartsOutputSchema>;
type HealthOutput = z.infer<typeof healthOutputSchema>;
type ChangeReportOutput = z.infer<typeof changeReportOutputSchema>;
type RedlineOutput = z.infer<typeof redlineOutputSchema>;

const changeSummarySchema = z.object({
  hunks: z.array(
    z.object({
      fromLine: z.number().nullable(),
      toLine: z.number().nullable(),
      type: z.enum(['same', 'add', 'del']),
      text: z.string(),
    }),
  ),
  truncated: z
    .boolean()
    .describe('true when the sections differ in lines this summary does not show'),
});

/**
 * One provision that differs between the two stored snapshots. Both issue
 * dates and a dated source URL per side travel on EVERY change, so an entry
 * stands alone as a citable claim about one revision transition.
 */
const snapshotChangeSchema = z.object({
  citation: z.string(),
  kind: z.enum(['section', 'appendix']),
  heading: z
    .string()
    .describe(
      'the provision’s heading, bounded at 1,000 characters; a heading of that length or more ' +
        'is marked with an ellipsis. When a retitle’s difference lies beyond the bound, the two ' +
        'clipped headings are identical on the wire and `headingChanged` is the only signal',
    ),
  headingChanged: z
    .boolean()
    .describe(
      'true when the provision was retitled — possibly with an unchanged body; decided on the ' +
        'raw headings, so it stays true when the difference lies beyond the heading bound',
    ),
  previousHeading: z
    .string()
    .nullable()
    .describe(
      'the from-side heading when the provision was retitled; bounded like `heading`, and ' +
        'therefore identical to it when the difference lies beyond the bound',
    ),
  chapter: z.string().nullable(),
  part: z.string().nullable(),
  subpart: z.string().nullable(),
  path: z.string(),
  fromIssueDate: z.string(),
  toIssueDate: z.string(),
  fromSourceUrl: z
    .string()
    .nullable()
    .describe(
      'the dated eCFR permalink at the from snapshot\u2019s issue date; null for an addition',
    ),
  toSourceUrl: z
    .string()
    .nullable()
    .describe('the dated eCFR permalink at the to snapshot\u2019s issue date; null for a removal'),
  imageContent: z
    .boolean()
    .describe(
      'true when either side\u2019s text carries an image-content marker — the summary is not complete coverage',
    ),
  summary: changeSummarySchema,
});

const snapshotComparisonOutputSchema = z.object({
  from: z.object({ path: z.string(), issueDate: z.string() }),
  to: z.object({ path: z.string(), issueDate: z.string() }),
  part: z.string().nullable(),
  added: z.array(snapshotChangeSchema),
  removed: z.array(snapshotChangeSchema),
  changed: z.array(snapshotChangeSchema),
  truncated: z
    .boolean()
    .describe(
      `true when any category list was cut — at the ${CHANGE_LIST_CAP}-entry cap or at the ` +
        `${SNAPSHOT_RESPONSE_CHAR_BUDGET}-character response budget`,
    ),
});

/** Register all tools on the server; `deps.ecfr` gates the three eCFR-backed tools (get_section_at, diff_issues, redline). */
export function registerTools(
  server: McpServer,
  service: CFRService,
  logger: Logger,
  deps?: { readonly ecfr?: EcfrApi },
): void {
  server.registerTool(
    'search_regulations',
    {
      title: 'Search CFR regulations',
      description:
        'Full-text search across the local CFR index using ranked keyword matching. ' +
        'The search runs in Title 38 (VA) by default; `title` selects another title ' +
        '(e.g. 32 for National Defense) or `all` for every stored title — every hit carries ' +
        'the title it belongs to, so two authorities are never blended into one unlabeled list. ' +
        'Returns section citations, headings, relevance snippets, bm25 scores (lower is better) ' +
        'and the query terms visible in each hit. ' +
        'The CANDIDATE SET is every provision matching AT LEAST ONE query term, so a provision ' +
        'that answers part of the question stays in the results instead of being excluded by the ' +
        'words it does not use; `total` counts those candidates (plus the pinned citation when ' +
        'the candidate set did not already hold it). ' +
        "The hits are ordered by: (1) a hit whose HEADING carries the query's content terms as a " +
        'phrase (or the corpus phrase a synonym stands for), (2) a hit matching EVERY query term ' +
        'ahead of one matching only some, (3) bm25, lower is better. ' +
        'Use `part` to scope results to a single CFR part (e.g. "4" for ratings, "17" for prosthetics), ' +
        '`kind` to restrict results to one provision kind ("section" or "appendix"), and ' +
        '`chapter` to scope to one chapter by its Roman-numeral identifier (e.g. "I"; exact, case-sensitive). ' +
        'Follow up with get_section to read a hit in full. ' +
        'If the query itself is a citation (e.g. "4.130" or "38 CFR 4.16"), matching ' +
        'sections in scope are pinned to the top of page 1 (totals include pins on every page) ' +
        "and marked `direct: true`. A citation that names a title pins only that title's section. The pinned hit's " +
        '`inResults` flag reports whether it also matched the ranked results. ' +
        'Quoted spans (e.g. "exact regulatory language") are emitted as FTS5 phrase queries — the last token gets a prefix wildcard (so "language" also matches "languages"); earlier tokens are matched exactly. ' +
        'Hits are ranked by LEXICAL OVERLAP with the query, not by legal authority: the first hit is the provision sharing the most words with the query, which is often not the provision that governs the question. ' +
        "Read each hit's heading and fetch its full text with get_section before you cite it. " +
        "Each response also carries matchedTerms and unmatchedTerms: the query's content words (stopwords, single characters and bare numerals removed), split into those the returned hits answered and those they did not. " +
        'A non-empty unmatchedTerms means the returned text does not speak to that part of your question — the governing provision may be a later hit, may be reachable only under different wording, or may not be in this index. ' +
        'Never cite a provision you have not read in full, and never state that Title 38 does not address a question on the basis of this response alone. ' +
        UNTRUSTED_DATA_NOTE,
      inputSchema: {
        query: z
          .string()
          .min(SEARCH_QUERY_MIN_LENGTH)
          .max(SEARCH_QUERY_MAX_LENGTH)
          .describe('search terms, e.g. "traumatic brain injury compensation"'),
        page: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .describe('1-based result page (default 1)'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('results per page (default 10, max 20)'),
        part: z
          .string()
          .regex(PART_NUMBER_PATTERN)
          .optional()
          .describe('restrict to one CFR part number'),
        kind: z
          .enum(['section', 'appendix'])
          .optional()
          .describe('restrict to one provision kind: section or appendix'),
        chapter: z
          .string()
          .min(1)
          .max(8)
          .regex(/^[IVXLCDM]+$/)
          .optional()
          .describe('restrict to one chapter, exact case-sensitive Roman numeral (e.g. "I")'),
        title: z
          .union([z.number().int().min(1).max(50), z.literal('all')])
          .optional()
          .describe(
            `the CFR title to search in (default ${DEFAULT_TITLE} — Veterans Benefits); "all" ` +
              'searches every stored title and labels every hit with its own title',
          ),
      },
      outputSchema: searchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool(logger, 'search_regulations', async () => {
        const response = service.search({
          query: args.query,
          page: args.page,
          perPage: args.per_page,
          part: args.part,
          kind: args.kind,
          chapter: args.chapter,
          title: args.title,
        });
        const structuredContent: SearchOutput = {
          ...response,
          matchedTerms: [...response.matchedTerms],
          unmatchedTerms: [...response.unmatchedTerms],
          hits: response.hits.map((hit) => ({ ...hit, matches: [...hit.matches] })),
        };
        return {
          content: [{ type: 'text', text: renderToolText(structuredContent) }],
          structuredContent,
        };
      }),
  );

  server.registerTool(
    'get_section',
    {
      title: 'Read a CFR section',
      description:
        'Fetch the full text of one CFR section or appendix as markdown. Accepts flexible citations: ' +
        '"4.125", "§ 4.125", "38 CFR 4.125", or appendix names like "Appendix A to Part 4". ' +
        'Returns heading, hierarchy path, issue date, the CFR title the provision belongs to, ' +
        'and an ecfr.gov permalink. ' +
        'A read without a title in the request or citation checks Title 38 only. ' +
        'A miss returns not_found with title hints for any other stored matches. ' +
        `Also returns \`citationSupport\` — Structural Citation Support diagnostics: how many distinct ` +
        'sections in this title cite this one, overall and narrowed to the same part and subject group. ' +
        'That vector is diagnostic output only — it never affects search ranking or candidate sets. ' +
        `The body is capped at ${PROVISION_TEXT_CAP} characters; a body that was cut sets \`truncated: true\`, ` +
        'and the truncated text is incomplete — read the rest from the sourceUrl. ' +
        UNTRUSTED_DATA_NOTE,
      inputSchema: {
        citation: z.string().min(1).max(120).describe('the citation to read, e.g. "38 CFR 4.125"'),
        title: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            'the CFR title to read within. If omitted, a citation that names a title reads that title. ' +
              'An untitled citation reads Title 38 only.',
          ),
      },
      outputSchema: sectionOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool(logger, 'get_section', async () => {
        const section = service.getSection(args.citation, args.title);
        const text = capProvision(section.text);
        const markdown = capProvision(section.markdown);
        const result: SectionOutput = {
          ...section,
          text: text.body,
          markdown: markdown.body,
          truncated: text.truncated || markdown.truncated,
          references: section.references.map((reference) => ({ ...reference })),
          citedBy: [...section.citedBy],
        };
        return {
          content: [{ type: 'text', text: renderToolText(result, ['markdown', 'text']) }],
          structuredContent: result,
        };
      }),
  );

  server.registerTool(
    'browse_title38',
    {
      title: 'Browse the CFR structure',
      description:
        'Navigate the Title 38 hierarchy (title → chapter → part → subpart → subject group) and list what exists at a level. ' +
        'With no arguments, returns the chapters. Use this to discover valid parts/subparts before searching. ' +
        'Most sections live inside a subject group: pass the subject_group identifier you saw in a ' +
        'previous response to list the sections it holds. ' +
        UNTRUSTED_DATA_NOTE,
      inputSchema: {
        chapter: z.string().max(20).optional().describe('chapter identifier, e.g. "I"'),
        part: z.string().max(20).optional().describe('part number, e.g. "4"'),
        subpart: z.string().max(20).optional().describe('subpart letter, e.g. "B" (requires part)'),
        subject_group: z
          .string()
          .max(40)
          .optional()
          .describe('subject-group identifier, e.g. "ECFRd158704dcab040e" (requires part)'),
      },
      outputSchema: browseOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool(logger, 'browse_title38', async () => {
        const response = service.browse({
          chapter: args.chapter,
          part: args.part,
          subpart: args.subpart,
          subjgrp: args.subject_group,
        });
        const structuredContent: BrowseOutput = {
          node: response.node,
          path: [...response.path],
          children: [...response.children],
        };
        return {
          content: [{ type: 'text', text: renderToolText(structuredContent) }],
          structuredContent,
        };
      }),
  );

  server.registerTool(
    'index_status',
    {
      title: 'Local index freshness',
      description:
        'Report how current the local Title 38 index is: eCFR issue date, last sync time, row counts, the ' +
        'corpus receipt hash (a sha256 over the sorted per-provision (citation, text+heading) pairs at ' +
        'rebuild time, null on older indexes — ' +
        CORPUS_RECEIPT_LIMIT +
        ') and ' +
        'whether the index is stale relative to CFR_MAX_AGE_DAYS. Check this before relying on search results.',
      outputSchema: statusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      runTool(logger, 'index_status', async () => {
        const status = service.status();
        const result: StatusOutput = {
          ...status,
          lastChanges:
            status.lastChanges === null
              ? null
              : {
                  ...status.lastChanges,
                  changedCitations: [...status.lastChanges.changedCitations],
                  addedCitations: [...status.lastChanges.addedCitations],
                  removedCitations: [...status.lastChanges.removedCitations],
                },
        };
        return {
          content: [{ type: 'text', text: renderToolText(result) }],
          structuredContent: result,
        };
      }),
  );

  server.registerTool(
    'list_parts',
    {
      title: 'List CFR parts in the local index',
      description:
        'Enumerate every Title 38 CFR part present in the local index, with its structure-tree title ' +
        'and section/appendix counts. Use this to discover which parts are searchable. ' +
        UNTRUSTED_DATA_NOTE,
      inputSchema: {},
      outputSchema: listPartsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      runTool(logger, 'list_parts', async () => {
        const parts = service.listParts();
        const structuredContent: ListPartsOutput = {
          parts: parts.map((row) => ({ ...row })),
        };
        return {
          content: [{ type: 'text', text: renderToolText(structuredContent) }],
          structuredContent,
        };
      }),
  );

  server.registerTool(
    'health',
    {
      title: 'Index readiness',
      description:
        'One-call readiness verdict for the local index: "ready" (query away), "stale" (older than ' +
        'CFR_MAX_AGE_DAYS — verify results against the current eCFR), "degraded" (structure drift — ' +
        'provisions may be missing; verify against the current eCFR), or "empty" (no index yet — ' +
        'run `cfr-free sync`). Clients should gate queries on this before spending tool calls.',
      outputSchema: healthOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      runTool(logger, 'health', async () => {
        const structuredContent: HealthOutput = service.health();
        return {
          content: [{ type: 'text', text: renderToolText(structuredContent) }],
          structuredContent,
        };
      }),
  );

  server.registerTool(
    'compare_snapshots',
    {
      title: 'Compare two stored snapshots of the index',
      description:
        'Offline comparison of two STORED snapshots of the Title 38 index (SQLite files, typically ' +
        'copies kept with `cfr-free export <path>`): which provisions were added, removed or changed ' +
        'between the revision the `from_snapshot` file holds and the revision the `to_snapshot` file ' +
        'holds. The comparison reads the two files and never contacts eCFR or fetches anything — ' +
        'obtaining a snapshot is a separate, explicit step (`cfr-free sync` to refresh the index, ' +
        '`cfr-free export <path>` to store a copy). Each snapshot names the eCFR issue date it was ' +
        'built from, so unlike the date-based `diff_issues` tool these dates are RECORDED revision ' +
        'stamps, and every change carries both of them, its citation, its hierarchy path, a dated ' +
        'ecfr.gov permalink for each side (the link a reader can open to verify that exact revision), ' +
        'and a short line-level summary of the differing text (add/del hunks with 1-based anchors ' +
        'into each side; each hunk and each entry summary is character-bounded, and `truncated: true` ' +
        'when text or differing lines exist beyond the shown bound — including a very long provision, ' +
        'over ' +
        `${SUMMARY_MAX_LINES} lines on either side, which falls back to one excerpt block per side). ` +
        'The response is bounded: the three ' +
        'category lists share a ' +
        `${SNAPSHOT_RESPONSE_CHAR_BUDGET}-character budget, split into three equal shares, so a ` +
        'comparison of two wholesale rebuilds is cut rather than megabytes long, and ' +
        '`truncated: true` says so (a single pathological entry — one the corpus does not bound — ' +
        'is always shown, so the response can exceed the budget by one entry per category); ' +
        'narrow the comparison with `part` to one CFR part (a single part can still exceed the ' +
        'budget — `truncated: true` says that too). A retitle with an ' +
        'unchanged body is reported as a change (`headingChanged: true`, empty text summary); a ' +
        '`imageContent: true` flag marks a provision whose rating-table graphics are not in the text. ' +
        'Optional `part` restricts the comparison to one CFR part. Both snapshots must be REGULAR ' +
        'files — a directory, a device or a FIFO is refused before the file is opened, because ' +
        'opening a FIFO blocks the server — and both must record an issue date; identical ' +
        'paths, a missing file, or a file that is not a cfr-free snapshot are rejected as errors ' +
        'before any comparison. Every such error names the side and what to do; the server keeps ' +
        'its own paths and the raw SQLite diagnostics in its log. ' +
        UNTRUSTED_DATA_NOTE,
      inputSchema: {
        from_snapshot: z
          .string()
          .min(1)
          .max(500)
          .describe('path to the earlier stored snapshot, e.g. "snapshots/2026-01-01.sqlite"'),
        to_snapshot: z
          .string()
          .min(1)
          .max(500)
          .describe('path to the later stored snapshot, e.g. "snapshots/2026-06-01.sqlite"'),
        part: z
          .string()
          .regex(PART_NUMBER_PATTERN)
          .optional()
          .describe('restrict the comparison to one CFR part number'),
      },
      outputSchema: snapshotComparisonOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) =>
      runTool(logger, 'compare_snapshots', async () => {
        const comparison = compareSnapshots({ logger }, args.from_snapshot, args.to_snapshot, {
          part: args.part,
        });
        const structuredContent = {
          from: comparison.from,
          to: comparison.to,
          part: comparison.part,
          added: comparison.added,
          removed: comparison.removed,
          changed: comparison.changed,
          truncated: comparison.truncated,
        };
        return {
          content: [{ type: 'text', text: renderToolText(structuredContent) }],
          structuredContent,
        };
      }),
  );

  // Registered only when an eCFR client is injected: without one there is no
  // honest way to serve a point-in-time read, diff or redline, so the tools
  // stay off the server's tools/list instead of existing as guaranteed
  // failures.
  const ecfr = deps?.ecfr;
  if (ecfr !== undefined) {
    server.registerTool(
      'get_section_at',
      {
        title: 'Read one provision as it stood at a date',
        description:
          'One Title 38 provision as it stood at a requested date (YYYY-MM-DD, required). ' +
          'eCFR serves the revision IN FORCE on that date, so a date that is not itself an ' +
          'issue date resolves to the revision that was in force then; the upstream does not ' +
          'report which issue date it served, so the response names the REQUESTED date and ' +
          'never a served-revision date. Fetched from eCFR on demand — there is no ' +
          'local index for a point-in-time read; a short-lived in-memory memo may ' +
          'serve a document this process fetched moments ago, and concurrent readers ' +
          "of the same date share one fetch. eCFR's point-in-time archive starts at " +
          `${ARCHIVE_FLOOR}; a date before that is rejected as invalid_input. Use this for ` +
          'date-of-claim and CUE questions ("what did this section say when the claim was ' +
          'filed?"); for the CURRENT text use get_section. ' +
          `The body is capped at ${PROVISION_TEXT_CAP} characters; a body that was cut sets \`truncated: true\`, ` +
          'and the truncated text is incomplete — read the rest from the sourceUrlAtRequestedDate. ' +
          UNTRUSTED_DATA_NOTE,
        inputSchema: {
          // at_date is a REQUESTED date, not an issue date: eCFR serves the
          // revision in force then and never reports which issue date it
          // served, so inheriting dateArgSchema's "issue date" wording would
          // tell MCP clients the wrong thing. Same format check, its own
          // description (tools/list wire text — covered by a test).
          at_date: dateArgSchema.describe(
            `date at which to read the provision, YYYY-MM-DD (eCFR serves the revision in force then; its archive starts ${ARCHIVE_FLOOR})`,
          ),
          citation: z
            .string()
            .min(1)
            .max(120)
            .describe('the citation to read, e.g. "38 CFR 4.130"'),
        },
        outputSchema: historicalOutputSchema,
        annotations: DIFF_ANNOTATIONS,
      },
      async (args) =>
        runTool(logger, 'get_section_at', async () => {
          const section = await historicalSection({ ecfr, logger }, args.at_date, args.citation);
          const text = capProvision(section.text);
          const markdown = capProvision(section.markdown);
          const structuredContent = {
            requestedDate: section.requestedDate,
            citation: section.citation,
            kind: section.kind,
            heading: section.heading,
            chapter: section.chapter,
            part: section.part,
            subpart: section.subpart,
            path: section.path,
            text: text.body,
            markdown: markdown.body,
            sourceUrl: section.sourceUrl,
            sourceUrlAtRequestedDate: section.sourceUrlAtRequestedDate,
            truncated: text.truncated || markdown.truncated,
          };
          return {
            content: [
              { type: 'text', text: renderToolText(structuredContent, ['markdown', 'text']) },
            ],
            structuredContent,
          };
        }),
    );

    server.registerTool(
      'diff_issues',
      {
        title: 'Diff two eCFR issue dates',
        description:
          'Provision-level diff of Title 38 between two eCFR issue dates: which citations changed, ' +
          'which were added, and which were removed between `from_date` and `to_date` ' +
          '(both YYYY-MM-DD, both required — this tool has no default-to; for ' +
          '"what changed since my index was built" run `cfr-free diff <from>` locally, ' +
          'which resolves `to` from the index issue date). Fetched from eCFR on ' +
          "demand: both dates' full-title XML is hashed per citation on the fly — " +
          'there is no local index for a point-in-time diff; a short-lived in-memory ' +
          'memo may serve a document this process fetched moments ago, and concurrent ' +
          'readers of the same date share one fetch. ' +
          `Each citation list is capped at ${CHANGE_LIST_CAP} entries; \`truncated: true\` means at least ` +
          'one list was cut. Identical dates or an impossible calendar date (e.g. month 13) are ' +
          'rejected as errors before any fetch.',
        inputSchema: {
          from_date: dateArgSchema,
          to_date: dateArgSchema,
        },
        outputSchema: changeReportOutputSchema,
        annotations: DIFF_ANNOTATIONS,
      },
      async (args) =>
        runTool(logger, 'diff_issues', async () => {
          const diff = await diffIssues({ ecfr, logger }, args.from_date, args.to_date);
          const structuredContent: ChangeReportOutput = {
            fromIssueDate: diff.fromIssueDate,
            toIssueDate: diff.toIssueDate,
            changed: [...diff.changed.slice(0, CHANGE_LIST_CAP)],
            added: [...diff.added.slice(0, CHANGE_LIST_CAP)],
            removed: [...diff.removed.slice(0, CHANGE_LIST_CAP)],
            truncated:
              diff.changed.length > CHANGE_LIST_CAP ||
              diff.added.length > CHANGE_LIST_CAP ||
              diff.removed.length > CHANGE_LIST_CAP,
            notice: diff.notice,
          };
          return {
            content: [{ type: 'text', text: renderToolText(structuredContent) }],
            structuredContent,
          };
        }),
    );

    server.registerTool(
      'redline',
      {
        title: 'Line redline of one provision between two eCFR issue dates',
        description:
          'Line-level redline of one Title 38 provision between two eCFR issue dates: which lines of ' +
          '`citation` changed, were added, or were removed between `from_date` and `to_date` (both ' +
          'YYYY-MM-DD, both required — this tool has no default-to). The dates are SELECTORS — eCFR ' +
          'serves the revision in force on the requested date; they are not a verified stamp of which ' +
          "issue date was served. Returns the status (changed/added/removed/unchanged), both sides' raw " +
          "text, and one hunk per line (same/add/del with 1-based anchors into each side's text). " +
          'Identical or impossible dates (e.g. month 13) are rejected as errors before any fetch; a ' +
          'citation missing from BOTH dates is a not_found error after the fetches. Fetched ' +
          "from eCFR on demand: both dates' full-title XML is read on demand — there " +
          'is no local index for a point-in-time redline; a short-lived in-memory ' +
          'memo may serve a document this process fetched moments ago, and concurrent ' +
          'readers of the same date share one fetch. ' +
          "When either side exceeds the core's line cap the per-line walk is replaced by two whole-text " +
          "coarse blocks (`coarse: true`) — passed through uncapped here, the core's own bound. " +
          UNTRUSTED_DATA_NOTE,
        inputSchema: {
          from_date: dateArgSchema,
          to_date: dateArgSchema,
          citation: z
            .string()
            .min(1)
            .max(120)
            .describe('the citation to redline, e.g. "38 CFR 4.125" (≤ 120 chars)'),
        },
        outputSchema: redlineOutputSchema,
        annotations: DIFF_ANNOTATIONS,
      },
      async (args) =>
        runTool(logger, 'redline', async () => {
          const redline = await redlineSection(
            { ecfr, logger },
            args.from_date,
            args.to_date,
            args.citation,
          );
          // Passthrough verbatim: the core's SectionRedline IS the wire contract —
          // no wire-layer caps (the core's coarse fallback at MAX_REDLINE_LINES is
          // the only bound).
          const structuredContent: RedlineOutput = {
            fromIssueDate: redline.fromIssueDate,
            toIssueDate: redline.toIssueDate,
            citation: redline.citation,
            status: redline.status,
            fromText: redline.fromText,
            toText: redline.toText,
            hunks: redline.hunks.map((hunk) => ({ ...hunk })),
            coarse: redline.coarse,
            notice: redline.notice,
          };
          return {
            content: [{ type: 'text', text: renderToolText(structuredContent) }],
            structuredContent,
          };
        }),
    );
  }
}
