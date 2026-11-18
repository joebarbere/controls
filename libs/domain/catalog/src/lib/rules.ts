import { CAMEL_ID_PATTERN, Extensions, FiniteNumber, Int, SafeString } from '@controls/save-format';
import * as z from 'zod';
import { CatalogSource } from './sources';

/*
 * Inspector rule sets (catalogue v3, P4 decision D13, ADR 0020): the `content/rules/` family, one file
 * per rule-set version (`<ruleSet>.v<version>.json`), mirrored into `builtin-rules.generated.ts` and
 * loaded by `parseCatalog` like a table. **Check kinds are code** (the inspector's registry in
 * `@controls/inspector`, which validates each rule's `check.params` against its kind); **rule sets are
 * data**: an id, an article by number, a short paraphrase in our own words, a severity, a check and
 * its parameters, and sources.
 *
 * Never NEC text and never a code table (realism charter, ADR 0003): an article is cited by number
 * only, the paraphrase is ours, and a number a check needs is a rule parameter with its own source, or
 * read from the catalogue entry it judges (a conductor's own published rating), never a gauge-to-amps
 * or fill-allowance table.
 *
 * Rule ids are **append-only** across a rule set's versions, like colour ids (load-checked): findings
 * name them, and later phases (P5 scoring) will. A rule the inspector doesn't check yet keeps
 * `check: null` and is listed as not implemented, so the inspector never claims a full inspection.
 */

const Label = (max: number) => SafeString.min(1).max(max);

/** A rule set's name (`nec`): lower camelCase. */
export const RuleSetName = z
  .string()
  .max(32)
  .regex(CAMEL_ID_PATTERN)
  .meta({ id: 'RuleSetName', description: 'An inspector rule set name: lower camelCase.' });

/** A rule id (`smallConductorOcpd`): lower camelCase, unique within its rule set and append-only. */
export const RuleId = z
  .string()
  .max(32)
  .regex(CAMEL_ID_PATTERN)
  .meta({ id: 'RuleId', description: 'An inspector rule id: lower camelCase, append-only within its rule set.' });

/**
 * An article reference, by number only: `240.4(D)`, `250.148(C)`, `210.12(B)`, `100`, `314.16(B)(1)`.
 * Never text.
 */
export const ARTICLE_PATTERN = /^\d{2,3}(?:\.\d{1,3}(?:\([A-Za-z0-9]{1,4}\)){0,3})?$/;
export const ArticleNumber = z.string().max(32).regex(ARTICLE_PATTERN);

/** How a finding is presented: a code `violation`, a `warning`, or a `report` with no pass or fail (Q1: fill). */
export const RuleSeverity = z.enum(['violation', 'warning', 'report']);
export type RuleSeverity = z.infer<typeof RuleSeverity>;

/** A check parameter: a finite number, a boolean or a short id string. */
export const RuleParam = z.union([FiniteNumber, z.boolean(), SafeString.min(1).max(64)]);

/** The longest paraphrase: a short sentence or two in our own words (never the code's text). */
export const MAX_PARAPHRASE = 300;

/** Most rules one rule-set version holds. */
export const MAX_RULES = 256;

/** One inspector rule. */
export const InspectorRule = z.strictObject({
  id: RuleId,
  /** The article it cites, by number, in the rule set's `edition`. */
  article: ArticleNumber,
  /** A short title for the panel (`Small conductor on too large a breaker`). */
  title: Label(80),
  /** What the rule asks for, paraphrased in our own words; never the code's text. */
  paraphrase: Label(MAX_PARAPHRASE),
  severity: RuleSeverity,
  /**
   * The check the inspector runs: a check kind of `@controls/inspector`'s registry and its parameters
   * (validated there, against the kind). `null`: listed, not checked (the panel says so).
   */
  check: z
    .strictObject({
      kind: z.string().max(32).regex(CAMEL_ID_PATTERN),
      params: z.record(z.string().max(32).regex(CAMEL_ID_PATTERN), RuleParam),
    })
    .nullable(),
});
export type InspectorRule = z.infer<typeof InspectorRule>;

/** One rule-set version: `content/rules/<ruleSet>.v<version>.json`. */
export const RuleSetDocument = z
  .strictObject({
    ruleSet: RuleSetName,
    version: Int.min(1),
    title: Label(80),
    /** The code edition every article is cited in (`NFPA 70-2023`). */
    edition: Label(40),
    rules: z.array(InspectorRule).max(MAX_RULES),
    sources: z.array(CatalogSource).min(1),
    extensions: Extensions,
  })
  .meta({
    title: 'Controls inspector rule set, catalogue format v3',
    description:
      'One file in content/rules/ (ADR 0020). Zod in @controls/catalog is authoritative; this JSON Schema omits source coverage, the append-only rule ids and each check kind’s parameters (validated by @controls/inspector).',
  });
export type RuleSetDocument = z.infer<typeof RuleSetDocument>;

/**
 * A region's pinned rule set (`RegionProfile.inspectorRules`): a rule-set name and version that must
 * resolve in the catalogue.
 */
export interface RuleSetRef {
  readonly ruleSet: string;
  readonly version: number;
}

/**
 * The coverage paths a rule set needs (`sources.ts`): `rules.<id>.article` (the article and the
 * paraphrase of it) and `rules.<id>.check.params.<name>` for each parameter.
 */
export function requiredRulePaths(document: RuleSetDocument): string[] {
  return document.rules.flatMap((rule) => [
    `rules.${rule.id}.article`,
    ...Object.keys(rule.check?.params ?? {}).map((name) => `rules.${rule.id}.check.params.${name}`),
  ]);
}
