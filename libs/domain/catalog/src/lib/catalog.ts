import { type CatalogRef, type DeviceStateValue, summariseIssues, type ValidationIssue } from '@controls/save-format';
import type * as z from 'zod';
import {
  type ConductorColour,
  type DeviceControl,
  DeviceDefinition,
  type EnclosureSpec,
  type TerminalMethodSpec,
} from './device';
import { AccessoryDefinition, CableDefinition, ToolDefinition } from './families';
import { type ModelKindDef, MODEL_KINDS, type StateKeyDef } from './model-kinds';
import {
  ACCESSORY_PREFIX,
  entryType,
  FAMILY_PREFIXES,
  mountType,
  type ToolStep,
  terminationMethod,
} from './registries';
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
}

/** What a catalogue is built from: each family's documents (untrusted JSON, already `JSON.parse`d). */
export interface CatalogInput {
  readonly devices?: readonly unknown[];
  readonly cables?: readonly unknown[];
  readonly tools?: readonly unknown[];
  readonly accessories?: readonly unknown[];
  readonly tables?: readonly unknown[];
}

/** The keys a {@link CatalogInput} may have; any other is refused. */
export const CATALOG_INPUT_KEYS = ['devices', 'cables', 'tools', 'accessories', 'tables'] as const;

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
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };

  const index = <T extends { id: string; version: number }>(entries: readonly T[]) =>
    new Map(entries.map((entry) => [refKey(entry.id, entry.version), entry]));
  const cableByKey = index(cables);
  const toolByKey = index(tools);
  const accessoryByKey = index(accessories);
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
  };
  return { ok: true, catalog: Object.freeze(catalog) };
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
  checkEnclosure(device, kind, add);
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
  const sorted = [...ids].sort();
  if (sorted.join('\n') !== [...kind.terminals].join('\n')) {
    add('terminals', `Model kind ${kind.kind} needs exactly the terminals [${kind.terminals.join(', ')}]`);
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
      if (method.clampTorque !== (spec.torqueNm !== null)) {
        add(
          path,
          method.clampTorque
            ? `A ${spec.method} method needs its marked torqueNm`
            : `A ${spec.method} method has no clamp torque: torqueNm must be null`,
        );
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
}

function checkMounts(device: DeviceDefinition, kind: ModelKindDef, add: Add): void {
  if (kind.placement === 'connection' && device.mounts.length > 0) add('mounts', 'A connection mounts on nothing');
  const types = device.mounts.map((m) => m.type);
  if (new Set(types).size !== types.length) add('mounts', 'Each mount type is declared once');
  for (const type of types) if (!mountType(type)) add(`mounts.${type}`, 'Unknown mount type');
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
  for (const mount of enclosure.mounts) {
    if (!mountType(mount.type)) add(`mounts.${mount.id}`, `Unknown mount type "${mount.type}"`);
  }
  for (const entry of enclosure.entries) {
    if (!entryType(entry.type)) add(`entries.${entry.id}`, `Unknown entry type "${entry.type}"`);
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
    const expected = { toggle: 'boolean', setpoint: 'number', selector: 'enum' }[control.type];
    if (key.type !== expected) add(path, `A ${control.type} control needs a ${expected} key`);
    if (control.type === 'selector' && !control.options.every((o) => key.values?.includes(o))) {
      add(path, 'Selector options must be values of the key');
    }
    // A new device starts at its key's initial value, so that value must be one the control allows
    // (a 0–5 V supply can't start at a kind's 12 V): F2.4 save-format review.
    if (key.type === expected && !checkControlValue(control, kind, key.initial).ok) {
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
  for (const mount of device.mounts) required.push(`fits.${mount.type}`);
  if (device.enclosure !== null) {
    for (const mount of device.enclosure.mounts) required.push(`mounts.${mount.id}`);
    for (const entry of device.enclosure.entries) required.push(`entries.${entry.id}`);
    if (device.enclosure.interiorVolumeMm3 !== null) required.push('interiorVolumeMm3');
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
  }
  return required;
}

function methodPaths(terminal: string, spec: TerminalMethodSpec): string[] {
  const base = `terminals.${terminal}.methods.${spec.method}`;
  const fields: string[] = [...METHOD_SOURCED_FIELDS];
  if (spec.torqueNm !== null) fields.push('torqueNm');
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
  ];
  for (const [capable, has, message] of consistent) if (capable !== has) add('capabilities', message);
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
  }
  return key.schema.safeParse(value).success
    ? { ok: true }
    : { ok: false, message: `${control.label} doesn't accept that value` };
}
