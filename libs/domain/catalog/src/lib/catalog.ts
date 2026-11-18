import { type CatalogRef, type DeviceStateValue, summariseIssues, type ValidationIssue } from '@controls/save-format';
import type * as z from 'zod';
import {
  type ConductorColour,
  type ConductorSpec,
  type DeviceControl,
  DeviceDefinition,
  type EnclosureMount,
  type EnclosureSpec,
  type PinTerminal,
  type TerminalMethodSpec,
} from './device';
import { type ConductorPhysics, conductorPhysics } from './conductor';
import {
  conductorTauMinS,
  conductorThermal,
  leadThermalLine,
  maxFinConductanceWPerK,
  thermalTauAllowed,
} from './conductor-thermal';
import { AccessoryDefinition, CableDefinition, ToolDefinition } from './families';
import { awgInRange, gaugeRow } from './gauge';
import { LeadParams, type ModelKindDef, MODEL_KINDS, type StateKeyDef } from './model-kinds';
import { THERMAL_MIN_TAU_S } from './thermal-constants';
import {
  ACCESSORY_PREFIX,
  entryType,
  FAMILY_PREFIXES,
  mountType,
  nemaConfig,
  type ToolStep,
  terminationMethod,
} from './registries';
import { racewayEntryProblems } from './raceway';
import { requiredRulePaths, RuleSetDocument } from './rules';
import { checkCoverage } from './sources';
import { type ColourRow, TableDocument, type TableRef, tableKind } from './tables';

/*
 * A loaded, validated catalogue (plan P2 decision D4, ADR 0013; catalogue format v2, ADR 0016). Domain
 * code resolves a saved `CatalogRef` through it: the world commands (`entity.place` initial bags,
 * `lead.connect` terminals, `device.operate` controls; from world v3 the wire, cable, enclosure and
 * tool commands), the load check and the netlist compiler.
 *
 * One id namespace holds every family (devices, cables, tools, accessories), told apart by id prefix,
 * so a ref names at most one entry. Tables are not entries: entries pin their rows by
 * `{ table, version, key }`.
 */

/** The family a catalogue entry belongs to (one id namespace, ADR 0015). */
export type CatalogFamily = 'device' | 'cable' | 'tool' | 'accessory';

export interface Catalog {
  /** `catalogVersion`: recorded in every save's manifest (ADR 0004). */
  readonly version: number;
  /** Every device entry (placed devices, enclosures, leads, conductors), sorted by id, then version. */
  readonly devices: readonly DeviceDefinition[];
  /** The device entry a ref names, or `undefined`. */
  device(ref: CatalogRef): DeviceDefinition | undefined;
  /** The model kind of the device entry a ref names, or `undefined` (unknown ref). */
  kindOf(ref: CatalogRef): ModelKindDef | undefined;
  /** Every cable assembly, sorted by id, then version. */
  readonly cables: readonly CableDefinition[];
  cable(ref: CatalogRef): CableDefinition | undefined;
  /** Every tool, sorted by id, then version. */
  readonly tools: readonly ToolDefinition[];
  tool(ref: CatalogRef): ToolDefinition | undefined;
  /** Every accessory (ferrules, lugs), sorted by id, then version. */
  readonly accessories: readonly AccessoryDefinition[];
  accessory(ref: CatalogRef): AccessoryDefinition | undefined;
  /** Which family the entry a ref names belongs to, or `undefined` (unknown ref). */
  family(ref: CatalogRef): CatalogFamily | undefined;
  /** Every table version, sorted by table name, then version. */
  readonly tables: readonly TableDocument[];
  /** A table version, or `undefined`. */
  table(name: string, version: number): TableDocument | undefined;
  /** A pinned row, or `undefined`. Its shape is its table kind's row schema (checked at load). */
  tableRow(ref: TableRef): Readonly<Record<string, unknown>> | undefined;
  /** The colour ids of the newest colour table (append-only, so a superset of every older one), sorted. */
  readonly colourIds: readonly string[];
  /** A colour of the newest colour table, or `undefined`. */
  colour(id: string): ColourRow | undefined;
  /** Every inspector rule-set version (catalogue v3), sorted by name, then version. */
  readonly ruleSets: readonly RuleSetDocument[];
  /** A rule-set version, or `undefined`. */
  ruleSet(name: string, version: number): RuleSetDocument | undefined;
}

/** What a catalogue is built from: each family's documents (untrusted JSON, already `JSON.parse`d). */
export interface CatalogInput {
  readonly devices?: readonly unknown[];
  readonly cables?: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly accessories?: readonly unknown[];
  readonly tables?: readonly unknown[];
  /** Inspector rule sets (`content/rules/`, catalogue v3). */
  readonly rules?: readonly unknown[];
}

/** The keys a {@link CatalogInput} may have; any other is refused. */
export const CATALOG_INPUT_KEYS = ['devices', 'cables', 'tools', 'accessories', 'tables', 'rules'] as const;

export type CatalogResult =
  | { readonly ok: true; readonly catalog: Catalog }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Reported at most this many catalogue issues. */
const MAX_ISSUES = 50;

const refKey = (id: string, version: number): string => `${id}@${version}`;
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
const byIdThenVersion = (a: { id: string; version: number }, b: { id: string; version: number }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version;

type Add = (path: string, message: string) => void;

/**
 * The largest outer-insulation radius over conductor radius a conductor entry may have (ADR 0018
 * §3.2, numerical): the engine's `lnRatio` is pinned against `Math.log` up to 8.
 */
export const MAX_INSULATION_RADIUS_RATIO = 8;

/** The fields of a termination method spec that need a source (`terminals.<id>.methods.<method>.<field>`). */
const METHOD_SOURCED_FIELDS = [
  'ratedConductors',
  'maxConductors',
  'awgRange',
  'stranding',
  'stripLengthMm',
  'alRated',
  'entryMm',
  'exitAxis',
  'clampType',
  'clampDepthMm',
  'contactOhm',
  'heatPathWPerK',
  'hotSpotHeatCapacityJPerK',
] as const;

/**
 * Validates catalogue documents and builds a {@link Catalog}. Never throws. `input` is either the
 * device documents alone (catalogue v1's call) or every family's. On top of each document's schema it
 * checks:
 *
 * - tables: a known table kind, unique `(table, version)`, rows of its row shape and key grammar,
 *   every sourced field covered, colour ids append-only across the colour table's versions;
 * - devices: unique `(id, version)`; the model kind exists and its parameters pass; terminals exactly
 *   the kind's, with registered, unique methods whose torque matches the method; a connection kind has
 *   no size, terminals or mounts and an entity kind has a size; categories match the kind; mount and
 *   entry types registered, ids unique across terminals, mounts and entries; an enclosure kind's
 *   entries carry enclosure data and a conductor kind's conductor data, and nothing else does; pinned
 *   table rows exist in the right table; colours are in the colour table, `bare` only on a bare
 *   conductor; controls drive commanded keys of a matching type and range; full source coverage;
 * - cables: indices in order, conductor refs pinned to conductor entries, colours and insulation that
 *   match them, a jacket row and colour; tools: capabilities consistent with holes, dies, torque and
 *   bore size, unique hole and die ids; accessories: the id prefix of their kind; full coverage;
 * - one namespace: devices use no family prefix, conductors use `conductor.` and only they.
 *
 * `kinds` defaults to {@link MODEL_KINDS}; tests pass synthetic kinds.
 */
export function parseCatalog(
  version: number,
  input: readonly unknown[] | CatalogInput,
  kinds: Readonly<Record<string, ModelKindDef>> = MODEL_KINDS,
): CatalogResult {
  const sourcesOf: CatalogInput = isDocumentArray(input) ? { devices: input } : input;
  const issues: ValidationIssue[] = [];
  if (!Number.isSafeInteger(version) || version < 1) {
    issues.push({ path: 'version', message: 'catalogVersion must be an integer of at least 1' });
  }
  // A misspelt family (`tool:` for `tools:`) would otherwise drop its documents silently.
  for (const key of Object.keys(sourcesOf)) {
    if (!(CATALOG_INPUT_KEYS as readonly string[]).includes(key)) {
      issues.push({ path: key, message: `Not a catalogue family (expected one of ${CATALOG_INPUT_KEYS.join(', ')})` });
    }
  }

  const tables = parseTables(sourcesOf.tables ?? [], issues);
  const colourTable = newest(tables, 'colours');
  const colours = new Map<string, ColourRow>(
    colourTable ? Object.entries(colourTable.rows).map(([id, row]) => [id, row as ColourRow]) : [],
  );
  const tableByKey = new Map(tables.map((t) => [refKey(t.table, t.version), t]));
  const resolveRow = (ref: TableRef): Readonly<Record<string, unknown>> | undefined => {
    const table = tableByKey.get(refKey(ref.table, ref.version));
    return table ? own(table.rows, ref.key) : undefined;
  };
  const context: Context = { kinds, colours, resolveRow };

  const kindByKey = new Map<string, ModelKindDef>();
  const devices = parseFamily('', sourcesOf.devices ?? [], DeviceDefinition, issues, (device, add) => {
    const kind = own(kinds, device.model.kind);
    if (!kind) {
      add('model.kind', 'Unknown model kind');
      return false;
    }
    checkDevice(device, kind, context, add);
    kindByKey.set(refKey(device.id, device.version), kind);
    return true;
  });
  const deviceByKey = new Map(devices.map((d) => [refKey(d.id, d.version), d]));
  const cables = parseFamily('cables', sourcesOf.cables ?? [], CableDefinition, issues, (cable, add) => {
    checkCable(cable, deviceByKey, context, add);
    return true;
  });
  const tools = parseFamily('tools', sourcesOf.tools ?? [], ToolDefinition, issues, (tool, add) => {
    checkTool(tool, add);
    return true;
  });
  const accessories = parseFamily(
    'accessories',
    sourcesOf.accessories ?? [],
    AccessoryDefinition,
    issues,
    (accessory, add) => {
      checkAccessory(accessory, add);
      return true;
    },
  );
  const ruleSets = parseRuleSets(sourcesOf.rules ?? [], issues);
  checkSupersededBy(devices, deviceByKey, issues);
  // The thermal time-constant check reads resolved rows and parsed params: only on an otherwise valid catalogue.
  if (issues.length === 0) checkThermalTimeConstants(devices, kindByKey, resolveRow, issues);
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };

  const index = <T extends { id: string; version: number }>(entries: readonly T[]) =>
    new Map(entries.map((entry) => [refKey(entry.id, entry.version), entry]));
  const cableByKey = index(cables);
  const toolByKey = index(tools);
  const accessoryByKey = index(accessories);
  const ruleSetByKey = new Map(ruleSets.map((set) => [refKey(set.ruleSet, set.version), set]));
  const colourIds = [...colours.keys()].sort();
  const catalog: Catalog = {
    version,
    devices,
    device: (ref) => deviceByKey.get(refKey(ref.id, ref.version)),
    kindOf: (ref) => kindByKey.get(refKey(ref.id, ref.version)),
    cables,
    cable: (ref) => cableByKey.get(refKey(ref.id, ref.version)),
    tools,
    tool: (ref) => toolByKey.get(refKey(ref.id, ref.version)),
    accessories,
    accessory: (ref) => accessoryByKey.get(refKey(ref.id, ref.version)),
    family: (ref) => {
      const key = refKey(ref.id, ref.version);
      if (deviceByKey.has(key)) return 'device';
      if (cableByKey.has(key)) return 'cable';
      if (toolByKey.has(key)) return 'tool';
      if (accessoryByKey.has(key)) return 'accessory';
      return undefined;
    },
    tables,
    table: (name, v) => tableByKey.get(refKey(name, v)),
    tableRow: resolveRow,
    colourIds,
    colour: (id) => colours.get(id),
    ruleSets,
    ruleSet: (name, v) => ruleSetByKey.get(refKey(name, v)),
  };
  return { ok: true, catalog: Object.freeze(catalog) };
}

/**
 * Inspector rule sets (catalogue v3, ADR 0020): the schema, a unique `(ruleSet, version)`, unique rule
 * ids, full source coverage, and rule ids append-only across a rule set's versions.
 */
function parseRuleSets(documents: readonly unknown[], issues: ValidationIssue[]): RuleSetDocument[] {
  const ruleSets: RuleSetDocument[] = [];
  const seen = new Set<string>();
  documents.forEach((document, index) => {
    const at = `rules[${index}]`;
    const parsed = RuleSetDocument.safeParse(document);
    if (!parsed.success) {
      for (const issue of summariseIssues(parsed.error.issues)) {
        issues.push({ path: issue.path === '(root)' ? at : `${at}.${issue.path}`, message: issue.message });
      }
      return;
    }
    const set = parsed.data;
    const add: Add = (path, message) => issues.push({ path: `${at} ${set.ruleSet}@${set.version}: ${path}`, message });
    const key = refKey(set.ruleSet, set.version);
    if (seen.has(key)) add('ruleSet', 'Duplicate rule set (same name and version)');
    seen.add(key);
    const ids = set.rules.map((r) => r.id);
    if (new Set(ids).size !== ids.length) add('rules', 'Rule ids must be unique within a rule set');
    for (const issue of checkCoverage(set.sources, requiredRulePaths(set))) add(issue.path, issue.message);
    ruleSets.push(set);
  });
  ruleSets.sort((a, b) => (a.ruleSet < b.ruleSet ? -1 : a.ruleSet > b.ruleSet ? 1 : a.version - b.version));
  // Rule ids are append-only across a rule set's versions (ADR 0020), like colour ids.
  for (let i = 1; i < ruleSets.length; i++) {
    const [before, after] = [ruleSets[i - 1], ruleSets[i]];
    if (before.ruleSet !== after.ruleSet) continue;
    const kept = new Set(after.rules.map((r) => r.id));
    const missing = before.rules.map((r) => r.id).filter((id) => !kept.has(id));
    if (missing.length > 0) {
      issues.push({
        path: `rules ${after.ruleSet}@${after.version}: rules`,
        message: `Rule ids are append-only: missing ${missing.sort().join(', ')} of version ${before.version}`,
      });
    }
  }
  return ruleSets;
}

/**
 * `supersededBy` (catalogue v3, ADR 0019 C12) names another device entry of this catalogue, and
 * following it never comes back to where it started.
 */
function checkSupersededBy(
  devices: readonly DeviceDefinition[],
  deviceByKey: ReadonlyMap<string, DeviceDefinition>,
  issues: ValidationIssue[],
): void {
  for (const device of devices) {
    const next = device.supersededBy;
    if (next === null) continue;
    const at = `${device.id}@${device.version}: supersededBy`;
    if (!deviceByKey.has(refKey(next.id, next.version))) {
      issues.push({ path: at, message: `${next.id}@${next.version} isn't a device entry of this catalogue` });
      continue;
    }
    const visited = new Set([refKey(device.id, device.version)]);
    for (let ref: DeviceDefinition['supersededBy'] = next; ref !== null;) {
      const key = refKey(ref.id, ref.version);
      if (visited.has(key)) {
        issues.push({ path: at, message: 'supersededBy loops back to an entry it replaces' });
        break;
      }
      visited.add(key);
      ref = deviceByKey.get(key)?.supersededBy ?? null;
    }
  }
}

function isDocumentArray(input: readonly unknown[] | CatalogInput): input is readonly unknown[] {
  return Array.isArray(input);
}

interface Context {
  readonly kinds: Readonly<Record<string, ModelKindDef>>;
  readonly colours: ReadonlyMap<string, ColourRow>;
  readonly resolveRow: (ref: TableRef) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * Parses one family's documents: the schema, a unique `(id, version)`, then `check` (which returns
 * whether the entry is kept). Device issue paths keep catalogue v1's `[index]` form.
 */
function parseFamily<T extends { id: string; version: number }>(
  family: string,
  documents: readonly unknown[],
  schema: z.ZodType<T>,
  issues: ValidationIssue[],
  check: (entry: T, add: Add) => boolean,
): T[] {
  const entries: T[] = [];
  const seen = new Set<string>();
  documents.forEach((document, index) => {
    const at = `${family}[${index}]`;
    const parsed = schema.safeParse(document);
    if (!parsed.success) {
      for (const issue of summariseIssues(parsed.error.issues)) {
        issues.push({ path: issue.path === '(root)' ? at : `${at}.${issue.path}`, message: issue.message });
      }
      return;
    }
    const entry = parsed.data;
    const add: Add = (path, message) => issues.push({ path: `${at} ${entry.id}@${entry.version}: ${path}`, message });
    const key = refKey(entry.id, entry.version);
    if (seen.has(key)) add('id', 'Duplicate catalogue entry (same id and version)');
    seen.add(key);
    if (check(entry, add)) entries.push(entry);
  });
  return entries.sort(byIdThenVersion);
}

function parseTables(documents: readonly unknown[], issues: ValidationIssue[]): TableDocument[] {
  const tables: TableDocument[] = [];
  const seen = new Set<string>();
  documents.forEach((document, index) => {
    const at = `tables[${index}]`;
    const parsed = TableDocument.safeParse(document);
    if (!parsed.success) {
      for (const issue of summariseIssues(parsed.error.issues)) {
        issues.push({ path: issue.path === '(root)' ? at : `${at}.${issue.path}`, message: issue.message });
      }
      return;
    }
    const table = parsed.data;
    const add: Add = (path, message) =>
      issues.push({ path: `${at} ${table.table}@${table.version}: ${path}`, message });
    const key = refKey(table.table, table.version);
    if (seen.has(key)) add('table', 'Duplicate table (same name and version)');
    seen.add(key);
    const kind = tableKind(table.table);
    if (!kind) {
      add('table', 'Unknown table');
      return;
    }
    const required: string[] = [];
    for (const [rowKey, row] of Object.entries(table.rows)) {
      if (!kind.keys.safeParse(rowKey).success) add(`rows.${rowKey}`, `Not a valid ${kind.name} key`);
      const rowParsed = kind.row.safeParse(row);
      if (!rowParsed.success) {
        for (const issue of summariseIssues(rowParsed.error.issues)) add(`rows.${rowKey}.${issue.path}`, issue.message);
      }
      for (const field of kind.sourced) required.push(`rows.${rowKey}.${field}`);
    }
    if (Object.keys(table.rows).length === 0) add('rows', 'A table has at least one row');
    for (const issue of checkCoverage(table.sources, required)) add(issue.path, issue.message);
    tables.push(table);
  });
  tables.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.version - b.version));
  // Colour ids are append-only across versions (ADR 0015): every version holds every older one's ids.
  const colourVersions = tables.filter((t) => t.table === 'colours');
  for (let i = 1; i < colourVersions.length; i++) {
    const missing = Object.keys(colourVersions[i - 1].rows).filter((id) => !(id in colourVersions[i].rows));
    if (missing.length > 0) {
      issues.push({
        path: `tables colours@${colourVersions[i].version}: rows`,
        message: `Colour ids are append-only: missing ${missing.sort().join(', ')} of version ${colourVersions[i - 1].version}`,
      });
    }
  }
  return tables;
}

/** The newest version of a table, or `undefined`. `tables` is sorted. */
function newest(tables: readonly TableDocument[], name: string): TableDocument | undefined {
  return tables.filter((t) => t.table === name).at(-1);
}

function checkDevice(device: DeviceDefinition, kind: ModelKindDef, context: Context, add: Add): void {
  const params = kind.params.safeParse(device.model.params);
  if (!params.success) {
    for (const issue of summariseIssues(params.error.issues)) add(`model.params.${issue.path}`, issue.message);
  }
  checkNamespace(device, add);
  checkTerminals(device, kind, add);
  checkCategory(device, kind, add);
  checkMounts(device, kind, add);
  for (const [path, message] of racewayEntryProblems(device)) add(path, message);
  checkEnclosure(device, kind, add);
  checkHostMounts(device, kind, add);
  checkOutletsAndPlug(device, kind, add);
  checkConductor(device, kind, context, add);
  checkControls(device.controls, kind, add);
  for (const issue of checkCoverage(device.sources, requiredDevicePaths(device))) add(issue.path, issue.message);
}

function checkNamespace(device: DeviceDefinition, add: Add): void {
  for (const [family, prefixes] of Object.entries(FAMILY_PREFIXES)) {
    if (family === 'conductor') continue;
    for (const prefix of prefixes) {
      if (device.id.startsWith(prefix)) add('id', `"${prefix}" ids belong to the ${family} family`);
    }
  }
  const conductorId = FAMILY_PREFIXES.conductor.some((p) => device.id.startsWith(p));
  if (conductorId !== (device.conductor !== null)) {
    add('id', 'Conductor entries, and only they, have ids starting with "conductor."');
  }
}

function checkTerminals(device: DeviceDefinition, kind: ModelKindDef, add: Add): void {
  const ids = device.terminals.map((t) => t.id);
  if (new Set(ids).size !== ids.length) add('terminals', 'Terminal ids must be unique');
  const families = kind.terminalFamilies ?? [];
  const numbered = new Set<string>();
  for (const family of families) {
    // An entry numbers a family's terminals 1 … n, with no gap, for one n in [min, max] (catalogue v3).
    let n = 0;
    while (ids.includes(`${family.prefix}${n + 1}`)) n++;
    for (let i = 1; i <= n; i++) numbered.add(`${family.prefix}${i}`);
    if (n < family.min || n > family.max) {
      add(
        'terminals',
        `Model kind ${kind.kind} numbers ${family.prefix}1 … ${family.prefix}n with n from ${family.min} to ${family.max}`,
      );
    }
  }
  const sorted = ids.filter((id) => !numbered.has(id)).sort();
  if (sorted.join('\n') !== [...kind.terminals].join('\n')) {
    const also = families.map((f) => `, ${f.prefix}1 … ${f.prefix}n`).join('');
    add('terminals', `Model kind ${kind.kind} needs exactly the terminals [${kind.terminals.join(', ')}${also}]`);
  }
  for (const terminal of device.terminals) {
    if ((terminal.access === 'land') !== terminal.methods.length > 0) {
      add(
        `terminals.${terminal.id}.access`,
        'A terminal is "land" exactly when it has termination methods ("clip" or "none" without them)',
      );
    }
    if (kind.sealedTerminals?.includes(terminal.id) === true && terminal.access !== 'none') {
      add(
        `terminals.${terminal.id}.access`,
        `Model kind ${kind.kind}'s ${terminal.id} is out of reach: its access must be "none"`,
      );
    }
  }
  if (kind.placement === 'connection') {
    if (device.sizeMm !== null) add('sizeMm', 'A connection kind has no body: sizeMm must be null');
  } else if (device.sizeMm === null) {
    add('sizeMm', 'A placed device needs a size');
  }
  for (const terminal of device.terminals) {
    const seen = new Set<string>();
    terminal.methods.forEach((spec, index) => {
      const path = `terminals.${terminal.id}.methods[${index}]`;
      const method = terminationMethod(spec.method);
      if (!method) {
        add(path, `Unknown termination method "${spec.method}"`);
        return;
      }
      if (seen.has(spec.method)) add(path, 'A terminal lists each method once');
      seen.add(spec.method);
      if (method.clampTorque !== spec.drives.length > 0) {
        add(
          path,
          method.clampTorque
            ? `A ${spec.method} method needs the drive types of its screw (drives)`
            : `A ${spec.method} method has no screw: drives must be empty`,
        );
      }
      if (method.clampTorque !== (spec.torqueNm !== null)) {
        add(
          path,
          method.clampTorque
            ? `A ${spec.method} method needs its marked torqueNm`
            : `A ${spec.method} method has no clamp torque: torqueNm must be null`,
        );
      }
      if (!method.clampTypes.includes(spec.clampType)) {
        add(
          path,
          `A ${spec.method} method holds the conductor by ${method.clampTypes.join(' or ')}, not ${spec.clampType}`,
        );
      }
      const cap = spec.multiConductor;
      if (cap !== null) {
        if (spec.maxConductors < 2) add(path, 'A multiConductor cap needs maxConductors of at least 2');
        if (!awgInRange(cap.awgRange.smallest, spec.awgRange) || !awgInRange(cap.awgRange.largest, spec.awgRange)) {
          add(path, "multiConductor.awgRange must lie inside the method's awgRange");
        }
      }
      const combination = spec.combination;
      if ((combination !== null) !== (spec.method === 'twistOn')) {
        add(path, 'A combination goes with a twistOn method, and only with it (ADR 0018 §4.4)');
      } else if (combination !== null) {
        if (combination.maxConductors !== spec.maxConductors) {
          add(path, "combination.maxConductors must equal the method's maxConductors");
        }
        if (
          !awgInRange(combination.awg.smallest, spec.awgRange) ||
          !awgInRange(combination.awg.largest, spec.awgRange)
        ) {
          add(path, "combination.awg must lie inside the method's awgRange");
        }
        // The minimum total is checked only once the splice holds minConductors (a splice is built one
        // conductor at a time). If minConductors of the thinnest size could fall below it, whether a
        // landing is refused would depend on the order the conductors were landed in, so it may not.
        const thinnest = gaugeRow(combination.awg.smallest)?.areaUm2 ?? 0;
        if (combination.totalAreaUm2.min > combination.minConductors * thinnest) {
          add(
            path,
            'combination.totalAreaUm2.min must not exceed minConductors × the thinnest size’s areaUm2 (refusals would depend on landing order)',
          );
        }
      }
    });
  }
}

function checkCategory(device: DeviceDefinition, kind: ModelKindDef, add: Add): void {
  const connectionCategory = device.category === 'lead' || device.category === 'conductor';
  if (connectionCategory !== (kind.placement === 'connection')) {
    add('category', 'Category "lead" or "conductor" goes with connection kinds, and only with them');
  }
  if ((device.category === 'conductor') !== (kind.requires === 'conductor')) {
    add('category', 'Category "conductor" goes with conductor kinds, and only with them');
  }
  if ((device.category === 'enclosure') !== (kind.requires === 'enclosure')) {
    add('category', 'Category "enclosure" goes with enclosure kinds, and only with them');
  }
  if ((device.category === 'splice') !== (kind.kind === 'splice.twistOn')) {
    add('category', 'Category "splice" goes with the splice.twistOn kind, and only with it');
  }
  if ((device.category === 'raceway') !== (kind.raceway !== undefined)) {
    add('category', 'Category "raceway" goes with raceway kinds, and only with them');
  }
  if ((device.category === 'terminalBlock') !== kind.kind.startsWith('terminalBlock.')) {
    add('category', 'Category "terminalBlock" goes with the terminalBlock.* kinds, and only with them');
  }
  if (
    kind.kind === 'splice.twistOn' &&
    !device.terminals.every((t) => t.methods.every((m) => m.method === 'twistOn'))
  ) {
    add('terminals', 'A twist-on splice lands conductors by twistOn only (ADR 0018 §4.4)');
  }
}

function checkMounts(device: DeviceDefinition, kind: ModelKindDef, add: Add): void {
  if (kind.placement === 'connection' && device.mounts.length > 0) add('mounts', 'A connection mounts on nothing');
  const types = device.mounts.map((m) => m.type);
  if (new Set(types).size !== types.length) add('mounts', 'Each mount type is declared once');
  for (const type of types) if (!mountType(type)) add(`mounts.${type}`, 'Unknown mount type');
  const terminals = new Set(device.terminals.map((t) => t.id));
  for (const fit of device.mounts) {
    const type = mountType(fit.type);
    if (type === undefined) continue;
    // Catalogue v3: a single mount takes an anchor (alongMm, crossMm); a linear one a cross offset only.
    if (fit.crossMm !== 0 && type.occupancy === 'area') {
      add(`mounts.${fit.type}`, 'crossMm places a device on a linear or single mount only: it must be 0 here');
    }
    if (fit.alongMm !== 0 && type.occupancy !== 'single') {
      add(`mounts.${fit.type}`, "alongMm anchors a device on a single mount only: on this mount it is the player's");
    }
    const ids = fit.contacts.map((c) => c.id);
    if (new Set(ids).size !== ids.length) add(`fits.${fit.type}.contacts`, 'Contact ids must be unique within a fit');
    for (const contact of fit.contacts) {
      const at = `fits.${fit.type}.contacts.${contact.id}`;
      if (!terminals.has(contact.terminal)) add(at, `No terminal "${contact.terminal}" on this entry`);
      if (!type.hostContacts.includes(contact.host)) {
        add(
          at,
          `A ${fit.type} mount offers the host contacts [${type.hostContacts.join(', ')}], not "${contact.host}"`,
        );
      }
      if (contact.positionOffset !== 0 && !type.bus)
        add(at, 'positionOffset steps along a bus only: it must be 0 here');
    }
  }
}

/**
 * The mounts a device offers (catalogue v3): an enclosure's `enclosure.mounts`, or a non-enclosure
 * device's `hostMounts` (a lampholder's `e26`). What `checkMount`, snapping and the compiler read.
 */
export function offeredMounts(device: DeviceDefinition): readonly EnclosureMount[] {
  return device.enclosure?.mounts ?? device.hostMounts;
}

/** One host mount's contacts and bus pattern (catalogue v3), for an enclosure's mounts or `hostMounts`. */
function checkHostMount(mount: EnclosureMount, terminals: ReadonlySet<string>, add: Add): void {
  const at = `mounts.${mount.id}`;
  const type = mountType(mount.type);
  if (type === undefined) {
    add(at, `Unknown mount type "${mount.type}"`);
    return;
  }
  const ids = mount.contacts.map((c) => c.id);
  if (new Set(ids).size !== ids.length) add(at, 'Each host contact is offered once');
  for (const contact of mount.contacts) {
    if (!type.hostContacts.includes(contact.id)) {
      add(at, `A ${mount.type} mount offers the host contacts [${type.hostContacts.join(', ')}], not "${contact.id}"`);
    }
    if (!terminals.has(contact.terminal)) add(at, `No terminal "${contact.terminal}" on this entry`);
  }
  if (type.bus !== (mount.bus !== null)) {
    add(at, type.bus ? `A ${mount.type} mount needs its bus pattern` : 'Only a bus mount has a bus pattern');
  }
  const bus = mount.bus;
  if (bus === null) return;
  if (mount.contacts.length > 0) add(at, "A bus mount's stabs reach their legs through its bus pattern, not contacts");
  for (const leg of bus.legs) if (!terminals.has(leg)) add(`${at}.bus`, `No terminal "${leg}" on this entry`);
  if (bus.legs[0] === bus.legs[1]) add(`${at}.bus`, 'A bus alternates between two different legs');
  if ((bus.stabs - 1) * bus.pitchMm > mount.extentMm) add(`${at}.bus`, "The last stab lies beyond the mount's extent");
}

function checkEnclosure(device: DeviceDefinition, kind: ModelKindDef, add: Add): void {
  const enclosure: EnclosureSpec | null = device.enclosure;
  if ((enclosure !== null) !== (kind.requires === 'enclosure')) {
    add('enclosure', `Enclosure data goes with enclosure kinds, and only with them (${kind.kind})`);
  }
  if (kind.requires === 'enclosure') {
    const openEntries = own(kind.keys, 'openEntries');
    if (openEntries?.owner !== 'commanded' || openEntries.type !== 'number') {
      add('model.kind', `Enclosure kind ${kind.kind} must declare the commanded number key openEntries`);
    }
  }
  if (enclosure === null) return;
  const ids = [
    ...device.terminals.map((t) => t.id),
    ...enclosure.mounts.map((m) => m.id),
    ...enclosure.entries.map((e) => e.id),
  ];
  if (new Set(ids).size !== ids.length)
    add('enclosure', 'Terminal, mount and entry ids must be unique within the entry');
  const terminals = new Set(device.terminals.map((t) => t.id));
  for (const mount of enclosure.mounts) checkHostMount(mount, terminals, add);
  for (const entry of enclosure.entries) {
    if (!entryType(entry.type)) add(`entries.${entry.id}`, `Unknown entry type "${entry.type}"`);
  }
  // Panel spaces (catalogue v3): each a stab of one of this enclosure's bus mounts, each once.
  const seen = new Set<string>();
  enclosure.spaces.forEach((space, i) => {
    const at = `spaces[${i}]`;
    const bus = enclosure.mounts.find((m) => m.id === space.mount)?.bus ?? null;
    if (bus === null) add(at, `"${space.mount}" isn't a bus mount of this enclosure`);
    else if (space.index >= bus.stabs) add(at, `Mount ${space.mount} has ${bus.stabs} stabs (indices from 0)`);
    const key = `${space.mount}#${space.index}`;
    if (seen.has(key)) add(at, 'Each stab is one space');
    seen.add(key);
  });
  if (enclosure.markedVolumeMm3 !== null && enclosure.interiorVolumeMm3 === null) {
    add('enclosure.markedVolumeMm3', 'A marked volume goes with an interior volume (a box, not a backplate)');
  }
}

/**
 * A non-enclosure device's offered mounts (catalogue v3, `hostMounts`): only where there is no
 * enclosure block, never on a connection, with ids unique among the entry's terminals.
 */
function checkHostMounts(device: DeviceDefinition, kind: ModelKindDef, add: Add): void {
  if (device.hostMounts.length === 0) return;
  if (device.enclosure !== null)
    add('hostMounts', 'An enclosure offers its mounts in enclosure.mounts: hostMounts must be []');
  if (kind.placement === 'connection') add('hostMounts', 'A connection offers no mounts');
  const ids = [...device.terminals.map((t) => t.id), ...device.hostMounts.map((m) => m.id)];
  if (new Set(ids).size !== ids.length) add('hostMounts', 'Terminal and mount ids must be unique within the entry');
  const terminals = new Set(device.terminals.map((t) => t.id));
  for (const mount of device.hostMounts) checkHostMount(mount, terminals, add);
}

/**
 * Receptacle outlets and an appliance plug (catalogue v3, ADR 0019 C6): configurations of the right
 * form, every pin of the configuration mapped once to a methodless terminal; no connection has either,
 * and an entry with a plug fits no mount (a relaxable rule, ADR 0019).
 */
function checkOutletsAndPlug(device: DeviceDefinition, kind: ModelKindDef, add: Add): void {
  if (kind.placement === 'connection' && (device.outlets.length > 0 || device.plug !== null)) {
    add('outlets', 'A connection has no outlets and no plug');
  }
  const ids = device.outlets.map((o) => o.id);
  if (new Set(ids).size !== ids.length) add('outlets', 'Outlet ids must be unique within the entry');
  for (const outlet of device.outlets) {
    checkPins(`outlets.${outlet.id}`, outlet.config, 'receptacle', outlet.pins, device, add);
  }
  const plug = device.plug;
  if (plug === null) return;
  checkPins('plug', plug.config, 'plug', plug.pins, device, add);
  if (gaugeRow(plug.cordAwg) === undefined) add('plug.cordAwg', `No gauge ${plug.cordAwg} in the gauge table`);
  if (device.mounts.length > 0) add('plug', 'An entry with a plug fits no mount (ADR 0019)');
}

function checkPins(
  at: string,
  config: string,
  form: 'plug' | 'receptacle',
  pins: readonly PinTerminal[],
  device: DeviceDefinition,
  add: Add,
): void {
  const def = nemaConfig(config);
  if (def === undefined || def.form !== form) {
    add(`${at}.config`, `"${config}" isn't a ${form} configuration of NEMA_CONFIGS`);
    return;
  }
  const named = pins.map((p) => p.pin);
  if ([...named].sort().join() !== [...def.pins].sort().join()) {
    add(`${at}.pins`, `A ${config} has the pins [${def.pins.join(', ')}], each mapped once`);
  }
  const terminals = pins.map((p) => p.terminal);
  if (new Set(terminals).size !== terminals.length) add(`${at}.pins`, 'Each pin is its own terminal');
  for (const { pin, terminal } of pins) {
    const found = device.terminals.find((t) => t.id === terminal);
    if (found === undefined) add(`${at}.pins`, `Pin ${pin}: no terminal "${terminal}" on this entry`);
    else if (found.methods.length > 0)
      add(`${at}.pins`, `Pin ${pin}: a blade or slot terminal has no termination methods`);
  }
}

function checkConductor(device: DeviceDefinition, kind: ModelKindDef, context: Context, add: Add): void {
  const conductor = device.conductor;
  if ((conductor !== null) !== (kind.requires === 'conductor')) {
    add('conductor', `Conductor data goes with conductor kinds, and only with them (${kind.kind})`);
  }
  if (kind.requires === 'conductor' && kind.placement !== 'connection') {
    add('model.kind', `Conductor kind ${kind.kind} must be a connection kind`);
  }
  if (conductor === null) return;
  checkRow(conductor.material, 'materials', 'conductor.material', context, add);
  if (conductor.insulation !== null) checkRow(conductor.insulation, 'insulation', 'conductor.insulation', context, add);
  checkConductorLayers(conductor, context, add);
  const seen = new Set<string>();
  conductor.colours.forEach((colour, index) => {
    const path = `conductor.colours[${index}]`;
    checkColour(colour, path, context, add);
    const key = `${colour.base}/${colour.stripe ?? ''}`;
    if (seen.has(key)) add(path, 'Each colour is listed once');
    seen.add(key);
    const bare = colour.base === 'bare' || colour.stripe === 'bare';
    if (bare && conductor.insulation !== null) add(path, '"bare" is only valid on an uninsulated conductor');
  });
  if (conductor.insulation === null && !conductor.colours.every((c) => c.base === 'bare' && c.stripe === null)) {
    add('conductor.colours', 'An uninsulated conductor is made in "bare" only');
  }
}

/**
 * The insulation layers the thermal model reads (ADR 0018 §3.2): a jacket thickness exactly when the
 * pinned insulation row has a jacket layer, and an outer radius at most {@link MAX_INSULATION_RADIUS_RATIO}
 * times the conductor's (the range where the engine's `lnRatio` is pinned).
 */
function checkConductorLayers(conductor: ConductorSpec, context: Context, add: Add): void {
  const row = conductor.insulation === null ? undefined : context.resolveRow(conductor.insulation);
  if (row !== undefined && conductor.insulation?.table === 'insulation') {
    const jacketLayer = row['jacketThermalConductivityWPerMK'] !== null;
    if (jacketLayer !== (conductor.jacketThicknessMm !== null)) {
      add(
        'conductor.jacketThicknessMm',
        jacketLayer
          ? `${conductor.insulation.key} has a jacket layer: give its thickness`
          : `${conductor.insulation.key} is a single layer: jacketThicknessMm must be null`,
      );
    }
  }
  const gauge = gaugeRow(conductor.awg);
  if (gauge === undefined) return;
  const r0 = gauge.diameterMm / 2;
  const outer = r0 + (conductor.insulationThicknessMm ?? 0) + (conductor.jacketThicknessMm ?? 0);
  if (outer > MAX_INSULATION_RADIUS_RATIO * r0) {
    add(
      'conductor.insulationThicknessMm',
      `The insulation's outer radius is above ${MAX_INSULATION_RADIUS_RATIO}× the conductor's`,
    );
  }
}

function checkColour(colour: ConductorColour, path: string, context: Context, add: Add): void {
  for (const id of colour.stripe === null ? [colour.base] : [colour.base, colour.stripe]) {
    if (!context.colours.has(id)) add(path, `Colour "${id}" isn't in the catalogue's colour table`);
  }
  if (colour.stripe !== null && colour.stripe === colour.base) add(path, 'A stripe differs from its base colour');
}

function checkRow(ref: TableRef, table: string, path: string, context: Context, add: Add): void {
  if (ref.table !== table) add(path, `Must pin a row of the ${table} table`);
  else if (!context.resolveRow(ref)) add(path, `No row ${ref.key} in ${ref.table}@${ref.version}`);
}

function checkControls(controls: readonly DeviceControl[], kind: ModelKindDef, add: Add): void {
  const seen = new Set<string>();
  controls.forEach((control, index) => {
    const path = `controls[${index}]`;
    if (seen.has(control.id)) add(path, 'Duplicate control id');
    seen.add(control.id);
    const key: StateKeyDef | undefined = own(kind.keys, control.id);
    if (!key || key.owner !== 'commanded') {
      add(path, `A control drives a commanded state key of ${kind.kind}; "${control.id}" isn't one`);
      return;
    }
    const expected = { toggle: 'boolean', setpoint: 'number', selector: 'enum', momentary: 'counter' }[control.type];
    if (key.type !== expected) add(path, `A ${control.type} control needs a ${expected} key`);
    if (control.type === 'selector' && !control.options.every((o) => key.values?.includes(o))) {
      add(path, 'Selector options must be values of the key');
    }
    // A new device starts at its key's initial value, so that value must be one the control allows
    // (a 0–5 V supply can't start at a kind's 12 V): F2.4 save-format review. A button sets no value.
    if (control.type !== 'momentary' && key.type === expected && !checkControlValue(control, kind, key.initial).ok) {
      add(path, `The key's initial value (${String(key.initial)}) is outside this control's range`);
    }
  });
}

/** The coverage paths a device entry needs (`sources.ts`). */
export function requiredDevicePaths(device: DeviceDefinition): string[] {
  const required = Object.keys(device.model.params).map((name) => `model.params.${name}`);
  if (device.sizeMm !== null) required.push('sizeMm');
  if (device.terminals.length > 0) required.push('terminals');
  for (const terminal of device.terminals) {
    for (const spec of terminal.methods) required.push(...methodPaths(terminal.id, spec));
  }
  for (const mount of device.mounts) {
    // `fits.<type>` covers the fit's layout only, never its contacts' resistances (sources.ts).
    required.push(`fits.${mount.type}`);
    for (const contact of mount.contacts) required.push(`fits.${mount.type}.contacts.${contact.id}.contactOhm`);
  }
  for (const mount of device.hostMounts) required.push(`mounts.${mount.id}`);
  if (device.enclosure !== null) {
    for (const mount of device.enclosure.mounts) required.push(`mounts.${mount.id}`);
    for (const entry of device.enclosure.entries) required.push(`entries.${entry.id}`);
    if (device.enclosure.interiorVolumeMm3 !== null) required.push('interiorVolumeMm3');
    if (device.enclosure.markedVolumeMm3 !== null) required.push('markedVolumeMm3');
    required.push('material');
    if (device.enclosure.spaces.length > 0) required.push('spaces');
  }
  for (const outlet of device.outlets) {
    for (const field of ['config', 'positionMm', 'pins', 'contactOhm']) required.push(`outlets.${outlet.id}.${field}`);
  }
  if (device.plug !== null) {
    for (const field of ['config', 'cordAwg', 'cordLengthMm', 'cordExitMm', 'pins']) required.push(`plug.${field}`);
  }
  const conductor = device.conductor;
  if (conductor !== null) {
    required.push(
      'conductor.awg',
      'conductor.stranding',
      'conductor.strandCount',
      'conductor.material',
      'conductor.insulation',
      'conductor.colours',
    );
    if (conductor.insulationThicknessMm !== null) required.push('conductor.insulationThicknessMm');
    if (conductor.jacketThicknessMm !== null) required.push('conductor.jacketThicknessMm');
  }
  return required;
}

function methodPaths(terminal: string, spec: TerminalMethodSpec): string[] {
  const base = `terminals.${terminal}.methods.${spec.method}`;
  const fields: string[] = [...METHOD_SOURCED_FIELDS];
  if (spec.torqueNm !== null) fields.push('torqueNm');
  if (spec.drives.length > 0) fields.push('drives');
  if (spec.combination !== null) fields.push('combination');
  if (spec.multiConductor !== null) fields.push('multiConductor');
  return fields.map((field) => `${base}.${field}`);
}

function checkCable(
  cable: CableDefinition,
  devices: ReadonlyMap<string, DeviceDefinition>,
  context: Context,
  add: Add,
): void {
  cable.conductors.forEach((member, index) => {
    const path = `conductors.${index}`;
    if (member.index !== index) add(path, "A conductor's index is its position in conductors[]");
    const conductor = devices.get(refKey(member.conductor.id, member.conductor.version))?.conductor ?? null;
    if (conductor === null) {
      add(path, `${member.conductor.id}@${member.conductor.version} isn't a conductor entry of this catalogue`);
      return;
    }
    if (member.insulated !== (conductor.insulation !== null)) add(path, 'insulated must match the conductor entry');
    checkColour(member.colour, path, context, add);
    if (!conductor.colours.some((c) => c.base === member.colour.base && c.stripe === member.colour.stripe)) {
      add(path, "The conductor entry isn't made in that colour");
    }
  });
  checkRow(cable.jacket.material, 'insulation', 'jacket.material', context, add);
  if (!context.colours.has(cable.jacket.colour)) {
    add('jacket.colour', `Colour "${cable.jacket.colour}" isn't in the catalogue's colour table`);
  }
  const required = [
    ...cable.conductors.map((_, i) => `conductors.${i}`),
    ...['material', 'colour', 'thicknessMm', 'widthMm', 'heightMm'].map((field) => `jacket.${field}`),
  ];
  for (const issue of checkCoverage(cable.sources, required)) add(issue.path, issue.message);
}

function checkTool(tool: ToolDefinition, add: Add): void {
  const steps = tool.capabilities.map((c) => c.step);
  if (new Set(steps).size !== steps.length) add('capabilities', 'Each step is listed once');
  const can = (step: ToolStep) => steps.includes(step);
  const consistent: [boolean, boolean, string][] = [
    [can('strip'), tool.holes.length > 0, 'A tool has holes exactly when it can strip'],
    [can('crimp'), tool.dies.length > 0, 'A tool has dies exactly when it can crimp'],
    [can('torque'), tool.torque !== null, 'A tool has a torque range exactly when it can torque'],
    [can('bore'), tool.boreDiameterMm !== null, 'A tool has a bore diameter exactly when it can bore'],
    [can('drive'), tool.drives.length > 0, 'A tool has drive types exactly when it can drive'],
    [can('pull'), tool.pull !== null, 'A tool has a pull reach exactly when it can pull'],
  ];
  for (const [capable, has, message] of consistent) if (capable !== has) add('capabilities', message);
  // F3.4 part 2: an entry is opened by a punch of its size or by a hole saw whose hole fits it.
  if (can('openEntry') && tool.punches.length === 0 && tool.boreDiameterMm === null) {
    add('capabilities', 'A tool that can openEntry has punches or a bore diameter (a hole saw)');
  }
  if (tool.punches.length > 0 && !can('openEntry')) add('punches', 'A tool has punches only if it can openEntry');
  if (tool.punches.length > 0 && tool.boreDiameterMm !== null) {
    add('punches', 'A tool has punches or a bore diameter, not both');
  }
  const holeIds = tool.holes.map((h) => h.id);
  if (new Set(holeIds).size !== holeIds.length) add('holes', 'Hole ids must be unique');
  const dieIds = tool.dies.map((d) => d.id);
  if (new Set(dieIds).size !== dieIds.length) add('dies', 'Die ids must be unique');
  const required = [
    'capabilities',
    ...holeIds.map((id) => `holes.${id}`),
    ...dieIds.map((id) => `dies.${id}`),
    ...(tool.torque !== null ? ['torque'] : []),
    ...(tool.boreDiameterMm !== null ? ['boreDiameterMm'] : []),
    ...(tool.drives.length > 0 ? ['drives'] : []),
    ...(tool.punches.length > 0 ? ['punches'] : []),
    ...(tool.pull !== null ? ['pull.lengthMm', 'pull.maxBendDeg'] : []),
  ];
  for (const issue of checkCoverage(tool.sources, required)) add(issue.path, issue.message);
}

function checkAccessory(accessory: AccessoryDefinition, add: Add): void {
  const prefix = ACCESSORY_PREFIX[accessory.kind];
  if (!accessory.id.startsWith(prefix)) add('id', `A ${accessory.kind} id starts with "${prefix}"`);
  const required = ['awgRange', 'stranding', 'dies', 'barrelLengthMm'];
  if (accessory.studDiameterMm !== null) required.push('studDiameterMm');
  for (const issue of checkCoverage(accessory.sources, required)) add(issue.path, issue.message);
}

/** Thrown by {@link catalogOrThrow}. */
export class CatalogError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(`Invalid device catalogue: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'CatalogError';
  }
}

/** {@link parseCatalog}, throwing {@link CatalogError}: for catalogues built into the game. */
export function catalogOrThrow(
  version: number,
  input: readonly unknown[] | CatalogInput,
  kinds: Readonly<Record<string, ModelKindDef>> = MODEL_KINDS,
): Catalog {
  const result = parseCatalog(version, input, kinds);
  if (!result.ok) throw new CatalogError(result.issues);
  return result.catalog;
}

/** Whether `value` is a valid value for `control` of a device whose kind is `kind` (the `device.operate` check). */
export function checkControlValue(
  control: DeviceControl,
  kind: ModelKindDef,
  value: DeviceStateValue,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const key = kind.keys[control.id];
  switch (control.type) {
    case 'toggle':
      if (typeof value !== 'boolean') return { ok: false, message: `${control.label} takes true or false` };
      break;
    case 'setpoint':
      if (typeof value !== 'number' || value < control.min || value > control.max) {
        return {
          ok: false,
          message: `${control.label} takes a number from ${control.min} to ${control.max} ${control.unit}`,
        };
      }
      break;
    case 'selector':
      if (typeof value !== 'string' || !control.options.includes(value)) {
        return { ok: false, message: `${control.label} takes one of: ${control.options.join(', ')}` };
      }
      break;
    case 'momentary':
      // A button is pressed, never set (catalogue v3, D7): device.operate refuses it (`momentary` from world v4).
      return { ok: false, message: `${control.id} is a button: press it with device.press` };
  }
  return key.schema.safeParse(value).success
    ? { ok: true }
    : { ok: false, message: `${control.label} doesn't accept that value` };
}

/**
 * The load-time thermal time-constant check (ADR 0018 §3.4): the engine's connection thermal bank
 * integrates by forward Euler every 10 ms, so every node it builds must have τ ≥ `THERMAL_MIN_TAU_S`
 * (100 steps). Conservative lower bounds, computed from the data alone:
 *
 * - a conductor entry: C′ · R′_ins (the surface resistance → 0, the hottest possible bound), or for a
 *   bare conductor C′ / G′ at the top of its linear-α range;
 * - a lead: the same conductor bound from its six thermal params (and its insulation's outer radius at
 *   most {@link MAX_INSULATION_RADIUS_RATIO} × the conductor's, `lnRatio`'s pinned range);
 * - a terminal method: C_h / (G_term + G_fin,max), with G_fin,max = √(G′_max k A) over every conductor
 *   entry of this catalogue that the method's `awgRange` and `stranding` admit.
 */
function checkThermalTimeConstants(
  devices: readonly DeviceDefinition[],
  kindByKey: ReadonlyMap<string, ModelKindDef>,
  resolveRow: (ref: TableRef) => Readonly<Record<string, unknown>> | undefined,
  issues: ValidationIssue[],
): void {
  const add = (device: DeviceDefinition, path: string, message: string) =>
    issues.push({ path: `${device.id}@${device.version}: ${path}`, message });
  const minTau = THERMAL_MIN_TAU_S.value;
  const conductors: { readonly physics: ConductorPhysics; readonly finMax: number }[] = [];
  for (const device of devices) {
    const kind = kindByKey.get(refKey(device.id, device.version));
    if (kind?.kind === 'lead') {
      const line = leadThermalLine(LeadParams.parse(device.model.params));
      const r0 = line.diameterM / 2;
      if (line.insulation !== null && r0 + line.insulation.thicknessM > MAX_INSULATION_RADIUS_RATIO * r0) {
        add(
          device,
          'model.params.insulationThicknessMm',
          `The insulation's outer radius is above ${MAX_INSULATION_RADIUS_RATIO}× the conductor's`,
        );
        continue;
      }
      const tau = conductorTauMinS(conductorThermal(line));
      if (!thermalTauAllowed(tau)) add(device, 'model.params', thermalTauMessage('The lead', tau, minTau));
      continue;
    }
    const physics = kind?.requires === 'conductor' ? conductorPhysics({ tableRow: resolveRow }, device) : undefined;
    if (physics === undefined) continue;
    const thermal = conductorThermal(physics);
    const tau = conductorTauMinS(thermal);
    if (!thermalTauAllowed(tau)) add(device, 'conductor', thermalTauMessage('The conductor', tau, minTau));
    conductors.push({ physics, finMax: maxFinConductanceWPerK(thermal) });
  }
  for (const device of devices) {
    for (const terminal of device.terminals) {
      for (const spec of terminal.methods) {
        let finMax = 0;
        for (const { physics, finMax: fin } of conductors) {
          const stranding =
            physics.stranding === 'solid'
              ? spec.stranding.includes('solid')
              : spec.stranding.includes('stranded') || spec.stranding.includes('strandedFerrule');
          if (stranding && awgInRange(physics.awg, spec.awgRange) && fin > finMax) finMax = fin;
        }
        const tau = spec.hotSpotHeatCapacityJPerK / (spec.heatPathWPerK + finMax);
        if (!thermalTauAllowed(tau)) {
          add(
            device,
            `terminals.${terminal.id}.methods.${spec.method}.hotSpotHeatCapacityJPerK`,
            thermalTauMessage('The termination hot spot', tau, minTau),
          );
        }
      }
    }
  }
}

const thermalTauMessage = (what: string, tau: number, min: number) =>
  `${what}'s thermal time constant can be as short as ${tau.toPrecision(3)} s, below the ${min} s the engine's 10 ms step needs (ADR 0018 §3.4)`;
