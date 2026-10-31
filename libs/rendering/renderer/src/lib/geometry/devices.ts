import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CylinderGeometry, MeshStandardMaterial, SphereGeometry, type BufferGeometry } from 'three/webgpu';
import { mm } from '@controls/units';
import { BUILTIN_CATALOG, type Catalog, type DeviceDefinition } from '@controls/catalog';
import type { CatalogRef } from '@controls/world-model';
import type { DrawnLamp } from '../sim/lamp-display';
import { boxBetween } from './fixtures';

/*
 * Procedural recipes for catalogue devices (plan F2.4, F2.5, §4.9 "procedural first"): the battery,
 * the bench supply and the DIN-rail PSU (F2.4); the SPST switch, the lamp, the resistor and the heater
 * (F2.5). Sizes and terminal positions come from the catalogue entry (`content/devices/`), the same
 * data the simulator and lead drawing use; only the look lives here.
 *
 * Frame: the entity's own, as for props (rendering caveats): origin at the min corner, the device
 * spanning +x (`widthMm`), +y (`heightMm`) and +z (`depthMm`, standing off its mounting surface). Set
 * on a bench top (pitched −90°, `orientationForFrame`) a device's depth stands up, so the bench
 * devices put their tops at z = depth and their fronts at y = 0; the DIN PSU, made for a rail, faces
 * +z (its front at z = depth). The F2.5 devices stand "on a base": the base is the bottom of their
 * depth (from z = 0), with a screw head on its top at each catalogue terminal and the label on its
 * front (y = 0).
 *
 * One merged geometry per device, with a group per material slot ({@link DEVICE_SLOTS}), drawn with a
 * material array: one mesh, one pick, one BVH per device kind. A single material (the placement ghost)
 * draws every group. Labels carry only the entry's fictional brand and model name (realism charter);
 * the text is on the mesh's `userData.label` (and so in the scene-graph snapshot), the label plate is
 * geometry. Colours are renderer-local looks, not world data.
 *
 * Per-entity parts: the lamp's bulb has its own slot ({@link BULB_SLOT}), which `WorldSync` clones per
 * lamp so each lamp glows by its own sim output ({@link applyBulbLook}). The switch's lever is a
 * separate shared geometry ({@link buildDeviceLever}) that `WorldSync` draws as a child mesh, turned
 * by the entity's commanded `state.closed` ({@link leverAngle}).
 */

/** Material slots, by group index. */
export const DEVICE_SLOTS = ['body', 'panel', 'label', 'positive', 'negative', 'accent', 'bulb'] as const;
type Slot = (typeof DEVICE_SLOTS)[number];

/** The material index of the lamp's bulb (cloned per lamp entity, so each glows on its own). */
export const BULB_SLOT: number = DEVICE_SLOTS.indexOf('bulb');

/** The lamp model kind, whose bulb glows by sim output. */
export const LAMP_KIND = 'lamp.incandescent';
/** The SPST switch model kind, whose lever follows `state.closed`. */
export const SWITCH_KIND = 'switch.spst';

/** Which recipe draws a model kind. Kinds without one are drawn as unknown objects. */
const RECIPES: Readonly<Record<string, (def: DeviceDefinition) => Part[]>> = {
  battery: batteryParts,
  'supply.bench': benchSupplyParts,
  'supply.dinPsu': dinPsuParts,
  [SWITCH_KIND]: switchParts,
  [LAMP_KIND]: lampParts,
  resistor: resistorParts,
  heater: heaterParts,
};

interface Part {
  readonly slot: Slot;
  readonly geometry: BufferGeometry;
}

/** The catalogue entry a ref draws as a device, or `undefined` (not a catalogue device, or no recipe). */
export function deviceDefinitionFor(ref: CatalogRef, catalog: Catalog = BUILTIN_CATALOG): DeviceDefinition | undefined {
  const def = catalog.device(ref);
  if (def === undefined || def.sizeMm === null) return undefined;
  return Object.prototype.hasOwnProperty.call(RECIPES, def.model.kind) ? def : undefined;
}

/** The label a device carries: its fictional brand and model name. */
export function deviceLabel(def: DeviceDefinition): string {
  return `${def.brand} ${def.modelName}`;
}

/** The device's merged geometry, in metres, one group per material slot used (see {@link DEVICE_SLOTS}). */
export function buildDeviceGeometry(def: DeviceDefinition): BufferGeometry {
  const parts = RECIPES[def.model.kind](def);
  const bySlot = DEVICE_SLOTS.map((slot) => parts.filter((p) => p.slot === slot).map((p) => p.geometry));
  // One merged geometry per slot (empty slots skipped), then all of them with groups.
  const slots: { index: number; geometry: BufferGeometry }[] = [];
  bySlot.forEach((geometries, index) => {
    if (geometries.length === 0) return;
    slots.push({ index, geometry: merge(geometries, false) });
  });
  const all = merge(
    slots.map((s) => s.geometry),
    true,
  );
  // `mergeGeometries` numbers groups 0, 1, … in input order; point each at its slot's material.
  all.groups.forEach((group, i) => (group.materialIndex = slots[i].index));
  return all;
}

/** The materials for {@link buildDeviceGeometry}'s groups, by slot. */
export function buildDeviceMaterials(def: DeviceDefinition): MeshStandardMaterial[] {
  const look = LOOKS[def.model.kind];
  return DEVICE_SLOTS.map((slot) => new MeshStandardMaterial(look[slot]));
}

type Look = Readonly<Record<Slot, { color: number; roughness: number; metalness: number; emissive?: number }>>;
const plastic = (color: number) => ({ color, roughness: 0.6, metalness: 0 });
const metal = (color: number) => ({ color, roughness: 0.4, metalness: 0.5 });
/** A slot a kind doesn't use (no group points at it, so it is never drawn or compiled). */
const unused = plastic(0x808080);

/**
 * The bulb's tint by drawn status (renderer-local, game-design): clear warm glass when solved (clear
 * and dark is a lamp that really is off), blue-grey when unknown (no reading, so never mistaken for
 * off), violet-grey when unsettled (lit by its level, but not a steady reading).
 */
export const BULB_TINTS: Readonly<Record<DrawnLamp['status'], number>> = {
  solved: 0xf3eee0,
  unknown: 0x6f7f99,
  unsettled: 0xa48fd0,
};
/** The bulb's glow colour: a warm filament. */
export const BULB_EMISSIVE = 0xffb45a;
/** Emissive intensity at level 255; level n draws at n / 255 of it. game-design: bright enough to read as lit. */
export const BULB_MAX_EMISSIVE_INTENSITY = 2.5;

const LOOKS: Readonly<Record<string, Look>> = {
  battery: {
    body: plastic(0x2b2d30), // black ABS case
    panel: plastic(0x3a3d42), // lid
    label: plastic(0xd8d2c4), // paper label
    positive: plastic(0xc0392b), // red + terminal cover
    negative: plastic(0x1c1c1c),
    accent: metal(0xb8bcc0), // tinned terminal tabs
    bulb: unused,
  },
  'supply.bench': {
    body: metal(0x5b6f82), // painted steel case
    panel: plastic(0x23272b), // front panel
    label: plastic(0xe6e6e6),
    positive: plastic(0xc0392b), // red binding post
    negative: plastic(0x1c1c1c), // black binding post
    accent: plastic(0x37c46b), // display windows
    bulb: unused,
  },
  'supply.dinPsu': {
    body: plastic(0xb9bec4), // light grey housing
    panel: plastic(0x8e949b), // terminal block
    label: plastic(0xf0f0f0),
    positive: plastic(0xc0392b),
    negative: plastic(0x1c1c1c),
    accent: plastic(0x37c46b), // DC OK LED
    bulb: unused,
  },
  [SWITCH_KIND]: {
    body: plastic(0x2f3338), // black base
    panel: plastic(0x8a9099), // switch body
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xc9ccd0), // nickel bushing, lever and screw heads
    bulb: unused,
  },
  [LAMP_KIND]: {
    body: plastic(0x2f3338), // black base
    panel: plastic(0x4a2f24), // brown bakelite holder
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xc8a24a), // brass neck and screw heads
    // The recipe's own bulb (the ghost's geometry never uses it); lamp entities draw a clone.
    bulb: { color: BULB_TINTS.unknown, roughness: 0.15, metalness: 0, emissive: BULB_EMISSIVE },
  },
  resistor: {
    body: plastic(0x2f3338),
    panel: metal(0xc9a548), // gold anodised aluminium housing
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xc8a24a), // brass screw heads
    bulb: unused,
  },
  heater: {
    body: plastic(0x2f3338),
    panel: { color: 0x7a3b2e, roughness: 0.8, metalness: 0.2 }, // oxidised element
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xb8bcc0), // steel guard, posts and screw heads
    bulb: unused,
  },
};

/**
 * Draws `lamp` on a lamp entity's own bulb material: its tint by status ({@link BULB_TINTS}) and its
 * glow by level. Writes only uniforms (colour, emissive intensity), never `visible` or material
 * defines (ADR 0011 §9.2).
 */
export function applyBulbLook(material: MeshStandardMaterial, lamp: DrawnLamp): void {
  material.color.setHex(BULB_TINTS[lamp.status]);
  material.emissiveIntensity = (lamp.level / 255) * BULB_MAX_EMISSIVE_INTENSITY;
}

/** The switch lever's throw either side of upright, in millidegrees (game-design). */
export const SWITCH_LEVER_THROW_MDEG = 25_000;

/**
 * The switch lever: a shared geometry drawn as a child mesh at `pivotMm` (device frame) with the
 * material in slot `slot`. Upright is +z; closed leans it toward the base's back edge (+y: a rotation
 * of −{@link SWITCH_LEVER_THROW_MDEG} about x), open toward its front (−y).
 */
export interface DeviceLever {
  readonly geometry: BufferGeometry;
  readonly pivotMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly slot: number;
}

/** The lever of a device kind that has one (the SPST switch), else `null`. */
export function buildDeviceLever(def: DeviceDefinition): DeviceLever | null {
  if (def.model.kind !== SWITCH_KIND) return null;
  const { widthMm: w, heightMm: h } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  // A rod with a fatter tip, from the pivot up +z.
  const geometry = merge([cylinderZ(0, 0, 2, 0, 13), cylinderZ(0, 0, 3.5, 11, 16)], false);
  return { geometry, pivotMm: { x: w / 2, y: h / 2, z: 29 }, slot: DEVICE_SLOTS.indexOf('accent') };
}

/** The lever's rotation about x, in radians, for a switch whose commanded state is `closed`. */
export function leverAngle(closed: boolean): number {
  return ((closed ? -SWITCH_LEVER_THROW_MDEG : SWITCH_LEVER_THROW_MDEG) * Math.PI) / 180_000;
}

function merge(geometries: BufferGeometry[], groups: boolean): BufferGeometry {
  const g = mergeGeometries(geometries, groups);
  geometries.forEach((p) => p.dispose());
  if (!g) throw new Error('device geometry could not be merged');
  return g;
}

/** A cylinder of radius `r` (mm) along +y from y0 to y1, centred at (x, z). */
function cylinderY(x: number, z: number, r: number, y0: number, y1: number): BufferGeometry {
  const g = new CylinderGeometry(mm(r), mm(r), mm(y1 - y0), 24);
  g.translate(mm(x), mm((y0 + y1) / 2), mm(z));
  return g;
}

/** A cylinder of radius `r` (mm) along +x from x0 to x1, centred at (y, z). */
function cylinderX(y: number, z: number, r: number, x0: number, x1: number): BufferGeometry {
  const g = new CylinderGeometry(mm(r), mm(r), mm(x1 - x0), 24);
  g.rotateZ(Math.PI / 2);
  g.translate(mm((x0 + x1) / 2), mm(y), mm(z));
  return g;
}

/** A cylinder of radius `r` (mm) along +z from z0 to z1, centred at (x, y). */
function cylinderZ(x: number, y: number, r: number, z0: number, z1: number): BufferGeometry {
  const g = new CylinderGeometry(mm(r), mm(r), mm(z1 - z0), 24);
  g.rotateX(Math.PI / 2);
  g.translate(mm(x), mm(y), mm((z0 + z1) / 2));
  return g;
}

/** A sphere of radius `r` (mm) centred at (x, y, z). */
function sphere(x: number, y: number, z: number, r: number): BufferGeometry {
  const g = new SphereGeometry(mm(r), 24, 16);
  g.translate(mm(x), mm(y), mm(z));
  return g;
}

const terminalSlot = (id: string): Slot => (id === 'pos' ? 'positive' : 'negative');

/**
 * The battery: a case with a lid band, a paper label on the front (y = 0), and at each terminal a
 * tinned tab under a coloured cover on the top (z = depth).
 */
function batteryParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const lid = 8;
  const parts: Part[] = [
    { slot: 'body', geometry: boxBetween(0, 0, 0, w, h, d - lid) },
    { slot: 'panel', geometry: boxBetween(0, 0, d - lid, w, h, d) },
    { slot: 'label', geometry: boxBetween(12, -0.5, 12, w - 12, 0, d - lid - 12) },
  ];
  for (const t of def.terminals) {
    const p = t.positionMm;
    parts.push({ slot: 'accent', geometry: boxBetween(p.x - 3, p.y - 0.5, d, p.x + 3, p.y + 0.5, d + 7) });
    parts.push({ slot: terminalSlot(t.id), geometry: boxBetween(p.x - 9, p.y - 7, d, p.x + 9, p.y + 7, d + 3) });
  }
  return parts;
}

/**
 * The bench supply: a case with a dark front panel (y = 0), two display windows (voltage and
 * current) and their knobs, a label strip, and a binding post standing out of the panel at each
 * terminal.
 */
function benchSupplyParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const parts: Part[] = [
    { slot: 'body', geometry: boxBetween(0, 2, 0, w, h, d) },
    { slot: 'panel', geometry: boxBetween(0, 0, 0, w, 2, d) },
    { slot: 'label', geometry: boxBetween(10, -0.5, d - 18, w - 10, 0, d - 8) },
    // Voltage and current displays, then their knobs.
    { slot: 'accent', geometry: boxBetween(10, -0.5, d - 60, w / 2 - 5, 0, d - 30) },
    { slot: 'accent', geometry: boxBetween(w / 2 + 5, -0.5, d - 60, w - 10, 0, d - 30) },
    { slot: 'panel', geometry: cylinderY(w / 4, d - 85, 9, -14, 0) },
    { slot: 'panel', geometry: cylinderY((3 * w) / 4, d - 85, 9, -14, 0) },
  ];
  for (const t of def.terminals) {
    const p = t.positionMm;
    parts.push({ slot: terminalSlot(t.id), geometry: cylinderY(p.x, p.z, 5, p.y - 15, p.y) });
  }
  return parts;
}

/**
 * The DIN PSU: a housing facing +z, a raised terminal block across the top of its front with a screw
 * terminal at each output terminal, a DC OK LED and a label.
 */
function dinPsuParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const parts: Part[] = [
    { slot: 'body', geometry: boxBetween(0, 0, 0, w, h, d - 4) },
    { slot: 'panel', geometry: boxBetween(2, h - 22, d - 4, w - 2, h - 2, d) },
    { slot: 'label', geometry: boxBetween(4, 20, d - 4, w - 4, h - 40, d - 3.5) },
    { slot: 'accent', geometry: cylinderZ(w / 2, h - 32, 1.5, d - 4, d - 2) },
  ];
  for (const t of def.terminals) {
    const p = t.positionMm;
    parts.push({ slot: terminalSlot(t.id), geometry: cylinderZ(p.x, p.y, 2.5, d - 2, d + 0.5) });
  }
  return parts;
}

/** Base height of the F2.5 "on a base" devices, in mm (game-design). */
const BASE_MM = 10;

/** A base: the bottom block, a label strip on its front (y = 0), and a screw head at each terminal. */
function baseParts(def: DeviceDefinition, base = BASE_MM): Part[] {
  const { widthMm: w, heightMm: h } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const parts: Part[] = [
    { slot: 'body', geometry: boxBetween(0, 0, 0, w, h, base) },
    { slot: 'label', geometry: boxBetween(6, -0.5, 2, w - 6, 0, base - 2) },
  ];
  for (const t of def.terminals) {
    const p = t.positionMm;
    parts.push({ slot: 'accent', geometry: cylinderZ(p.x, p.y, 4, base, Math.max(base, p.z) + 2) });
  }
  return parts;
}

/**
 * The SPST toggle switch: a base with a screw terminal at each end, a switch body in the middle and a
 * bushing on top. The lever is not in this geometry ({@link buildDeviceLever}).
 */
function switchParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  return [
    ...baseParts(def),
    { slot: 'panel', geometry: boxBetween(w / 2 - 12, h / 2 - 12, BASE_MM, w / 2 + 12, h / 2 + 12, 26) },
    { slot: 'accent', geometry: cylinderZ(w / 2, h / 2, 6, 26, 31) },
  ];
}

/** The lamp: a base with a screw terminal each side, a holder, a brass neck and the bulb on top. */
function lampParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const base = 12;
  const r = 12; // bulb radius
  return [
    ...baseParts(def, base),
    { slot: 'panel', geometry: cylinderZ(w / 2, h / 2, 10, base, 30) },
    { slot: 'accent', geometry: cylinderZ(w / 2, h / 2, 7, 30, d - 2 * r) },
    { slot: 'bulb', geometry: sphere(w / 2, h / 2, d - r, r) },
  ];
}

/** The power resistor: a finned aluminium housing on a base with a screw terminal at each end. */
function resistorParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const x0 = 16;
  const x1 = w - 16;
  const parts: Part[] = [...baseParts(def), { slot: 'panel', geometry: boxBetween(x0, 8, BASE_MM, x1, h - 8, d - 6) }];
  for (const y of [9, h / 2 - 1.5, h - 12]) {
    parts.push({ slot: 'panel', geometry: boxBetween(x0, y, d - 6, x1, y + 3, d) });
  }
  return parts;
}

/**
 * The heater: an element between two posts inside a wire guard (end hoops and top bars), on a base
 * with a screw terminal at each end.
 */
function heaterParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const parts: Part[] = [
    ...baseParts(def),
    { slot: 'accent', geometry: boxBetween(20, h / 2 - 7, BASE_MM, 26, h / 2 + 7, d - 8) },
    { slot: 'accent', geometry: boxBetween(w - 26, h / 2 - 7, BASE_MM, w - 20, h / 2 + 7, d - 8) },
    { slot: 'panel', geometry: cylinderX(h / 2, d - 16, 6, 26, w - 26) },
    { slot: 'accent', geometry: boxBetween(17, 10, BASE_MM, 19, h - 10, d) },
    { slot: 'accent', geometry: boxBetween(w - 19, 10, BASE_MM, w - 17, h - 10, d) },
  ];
  for (const y of [10, h / 2 - 1, h - 12]) {
    parts.push({ slot: 'accent', geometry: boxBetween(17, y, d - 2, w - 17, y + 2, d) });
  }
  return parts;
}
