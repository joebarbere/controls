/*
 * The palette's fuzzy matcher (plan F1.3). Small and dependency-free: a query matches a text when
 * its characters appear in order (case-insensitive). The score prefers matches at the start of the
 * text and of words (after a space or punctuation, or at a camelCase hump) and consecutive runs,
 * and it charges for gaps, so "pl ob" ranks "Place object" above "Open command palette".
 */

/** A successful match: higher `score` is better; `indices` are the matched positions in the text. */
export interface FuzzyMatch {
  readonly score: number;
  readonly indices: readonly number[];
}

const START_BONUS = 8;
const WORD_BONUS = 6;
const RUN_BONUS = 4;
const GAP_PENALTY = 0.5;
const MAX_GAP_CHARGE = 10;

const SEPARATORS = new Set([' ', '.', '-', '_', ':', '/', '(', ')']);

function isWordStart(text: string, j: number): boolean {
  if (j === 0) return true;
  const prev = text[j - 1];
  if (SEPARATORS.has(prev)) return true;
  const ch = text[j];
  return ch !== ch.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
}

/**
 * Matches `query` against `text` as an ordered subsequence (case-insensitive). Returns `null` if it
 * doesn't match. An empty query matches everything with score 0. Dynamic programming over the
 * query × text grid, so the best-scoring placement wins, not the first greedy one.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const m = q.length;
  const n = t.length;
  if (m === 0) return { score: 0, indices: [] };
  if (m > n) return null;

  const charScore = (j: number) => 1 + (j === 0 ? START_BONUS : isWordStart(text, j) ? WORD_BONUS : 0);
  const score: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-Infinity));
  const from: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-1));

  for (let j = 0; j < n; j++) {
    if (t[j] === q[0]) score[0][j] = charScore(j) - Math.min(j, MAX_GAP_CHARGE) * (GAP_PENALTY / 2);
  }
  for (let i = 1; i < m; i++) {
    for (let j = i; j < n; j++) {
      if (t[j] !== q[i]) continue;
      let best = -Infinity;
      let bestK = -1;
      for (let k = i - 1; k < j; k++) {
        const prev = score[i - 1][k];
        if (prev === -Infinity) continue;
        const gap = j - k - 1;
        const step = gap === 0 ? RUN_BONUS : -Math.min(gap, MAX_GAP_CHARGE) * GAP_PENALTY;
        if (prev + step > best) {
          best = prev + step;
          bestK = k;
        }
      }
      if (bestK >= 0) {
        score[i][j] = best + charScore(j);
        from[i][j] = bestK;
      }
    }
  }

  let end = -1;
  for (let j = 0; j < n; j++) if (score[m - 1][j] > (end < 0 ? -Infinity : score[m - 1][end])) end = j;
  if (end < 0) return null;
  const indices = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; j = from[i][j], i--) indices[i] = j;
  return { score: score[m - 1][end], indices };
}

/** A searchable field and how much a match in it counts. */
export interface FuzzyField {
  readonly text: string;
  readonly weight: number;
}

/**
 * Scores a whole query against several fields (for a command: title, category and id). The query is
 * split on whitespace and **every** word must match at least one field; each word counts its best
 * weighted field score. Returns `null` if any word matches nothing, and 0 for an empty query.
 */
export function fuzzyScore(query: string, fields: readonly FuzzyField[]): number | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const word of words) {
    let best: number | null = null;
    for (const field of fields) {
      const match = fuzzyMatch(word, field.text);
      if (match && (best === null || match.score * field.weight > best)) best = match.score * field.weight;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}
