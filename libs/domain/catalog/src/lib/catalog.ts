import { type CatalogRef, type DeviceStateValue, summariseIssues, type ValidationIssue } from '@controls/save-format';
import { type DeviceControl, DeviceDefinition } from './device';
import { type ModelKindDef, MODEL_KINDS, type StateKeyDef } from './model-kinds';

/*
 * A loaded, validated device catalogue (plan P2 decision D4, ADR 0013). Domain code resolves a saved
 * `CatalogRef` through it: the world commands (`entity.place` initial bags, `lead.connect` terminals,
 * `device.operate` controls), the load check and, from F2.1, the netlist compiler.
 */

export interface Catalog {
  /** `catalogVersion`: recorded in every save's manifest (ADR 0004). */
  readonly version: number;
  /** Every entry, sorted by id, then version. */
  readonly devices: readonly DeviceDefinition[];
  /** The entry a ref names, or `undefined`. */
  device(ref: CatalogRef): DeviceDefinition | undefined;
  /** The model kind of the entry a ref names, or `undefined` (unknown ref). */
  kindOf(ref: CatalogRef): ModelKindDef | undefined;
}

export type CatalogResult =
  | { readonly ok: true; readonly catalog: Catalog }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Reported at most this many catalogue issues. */
const MAX_ISSUES = 50;

const refKey = (id: string, version: number): string => `${id}@${version}`;

/**
 * Validates catalogue entries (untrusted JSON, already `JSON.parse`d) and builds a {@link Catalog}.
 * Never throws. On top of each entry's schema it checks, for every entry:
 *
 * - its `(id, version)` is unique;
 * - its model kind exists in `kinds` and its parameters pass the kind's schema;
 * - its terminals are exactly the kind's (unique ids); a connection kind has none and no size, an
 *   entity kind has a size; category `lead` goes with connection kinds and only them;
 * - each control drives a commanded key of the kind, of a matching type (toggle ↔ boolean, setpoint ↔
 *   number, selector ↔ enum, with options among the key's values), with unique ids;
 * - source ids are unique and every parameter, the size and the terminal layout are covered by a source.
 *
 * `kinds` defaults to {@link MODEL_KINDS}; tests pass synthetic kinds.
 */
export function parseCatalog(
  version: number,
  documents: readonly unknown[],
  kinds: Readonly<Record<string, ModelKindDef>> = MODEL_KINDS,
): CatalogResult {
  const issues: ValidationIssue[] = [];
  if (!Number.isSafeInteger(version) || version < 1) {
    issues.push({ path: 'version', message: 'catalogVersion must be an integer of at least 1' });
  }
  const devices: DeviceDefinition[] = [];
  const kindByKey = new Map<string, ModelKindDef>();
  documents.forEach((document, index) => {
    const parsed = DeviceDefinition.safeParse(document);
    if (!parsed.success) {
      for (const issue of summariseIssues(parsed.error.issues)) {
        issues.push({
          path: issue.path === '(root)' ? `[${index}]` : `[${index}].${issue.path}`,
          message: issue.message,
        });
      }
      return;
    }
    const device = parsed.data;
    const at = (path: string) => `[${index}] ${device.id}@${device.version}: ${path}`;
    const add = (path: string, message: string) => issues.push({ path: at(path), message });
    const key = refKey(device.id, device.version);
    if (kindByKey.has(key)) add('id', 'Duplicate catalogue entry (same id and version)');

    const kind = Object.prototype.hasOwnProperty.call(kinds, device.model.kind) ? kinds[device.model.kind] : undefined;
    if (!kind) {
      add('model.kind', 'Unknown model kind');
      return;
    }
    const params = kind.params.safeParse(device.model.params);
    if (!params.success) {
      for (const issue of summariseIssues(params.error.issues)) add(`model.params.${issue.path}`, issue.message);
    }
    checkTerminals(device, kind, add);
    checkControls(device.controls, kind, add);
    checkSources(device, add);
    kindByKey.set(key, kind);
    devices.push(device);
  });
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };

  devices.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
  const byKey = new Map(devices.map((device) => [refKey(device.id, device.version), device]));
  const catalog: Catalog = {
    version,
    devices,
    device: (ref) => byKey.get(refKey(ref.id, ref.version)),
    kindOf: (ref) => kindByKey.get(refKey(ref.id, ref.version)),
  };
  return { ok: true, catalog: Object.freeze(catalog) };
}

type Add = (path: string, message: string) => void;

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
  if ((device.category === 'lead') !== (kind.placement === 'connection')) {
    add('category', 'Category "lead" goes with connection kinds, and only with them');
  }
}

function checkControls(controls: readonly DeviceControl[], kind: ModelKindDef, add: Add): void {
  const seen = new Set<string>();
  controls.forEach((control, index) => {
    const path = `controls[${index}]`;
    if (seen.has(control.id)) add(path, 'Duplicate control id');
    seen.add(control.id);
    const key: StateKeyDef | undefined = Object.prototype.hasOwnProperty.call(kind.keys, control.id)
      ? kind.keys[control.id]
      : undefined;
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

function checkSources(device: DeviceDefinition, add: Add): void {
  const ids = device.sources.map((s) => s.id);
  if (new Set(ids).size !== ids.length) add('sources', 'Source ids must be unique');
  const covered = new Set(device.sources.flatMap((s) => s.covers));
  const required = Object.keys(device.model.params).map((name) => `model.params.${name}`);
  if (device.sizeMm !== null) required.push('sizeMm');
  if (device.terminals.length > 0) required.push('terminals');
  for (const path of required) {
    if (!covered.has(path)) add(path, 'Has no source (realism charter: every value has a source)');
  }
  const params = new Set(Object.keys(device.model.params));
  for (const path of covered) {
    if (path.startsWith('model.params.') && !params.has(path.slice('model.params.'.length))) {
      add('sources', `A source covers ${path}, which the entry doesn't have`);
    }
    if ((path === 'sizeMm' && device.sizeMm === null) || (path === 'terminals' && device.terminals.length === 0)) {
      add('sources', `A source covers ${path}, which the entry doesn't have`);
    }
  }
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
  documents: readonly unknown[],
  kinds: Readonly<Record<string, ModelKindDef>> = MODEL_KINDS,
): Catalog {
  const result = parseCatalog(version, documents, kinds);
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
