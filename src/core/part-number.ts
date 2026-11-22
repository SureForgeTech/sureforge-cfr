/**
 * The shape of a CFR part filter, and its canonical spelling.
 *
 * A part identifier is a plain number ("4"), and a caller may write it with
 * leading zeros ("04"). The index holds the canonical form — today the
 * eCFR XML writes part identifiers as plain integers — so an unnormalized
 * filter matches NO row: a search answers "no hits" and a comparison
 * answers "nothing changed" for a part that did change.
 *
 * One account of the spelling, used wherever a caller's part becomes a
 * filter.
 */

/** A part filter is one to three digits. */
export const PART_NUMBER_PATTERN = /^\d{1,3}$/;

/**
 * The canonical spelling of a part filter: the number without leading
 * zeros, so "04" names part 4.
 *
 * A value that is not a part number is returned unchanged: the caller's own
 * rule decides what to do with it.
 */
export function normalizePartNumber(raw: string): string {
  return PART_NUMBER_PATTERN.test(raw) ? String(Number.parseInt(raw, 10)) : raw;
}
