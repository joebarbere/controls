import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CylinderGeometry, MeshStandardMaterial, type BufferGeometry, type Material } from 'three/webgpu';
import { mm } from '@controls/units';
import { BUILTIN_CATALOG, type Catalog, type DeviceDefinition } from '@controls/catalog';
import type { CatalogRef } from '@controls/world-model';
import { boxBetween } from './fixtures';

/*
 * Procedural recipes for catalogue devices (plan F2.4, §4.9 "procedural first"): the battery, the
 * bench supply and the DIN-rail PSU. Sizes and terminal positions come from the catalogue entry
 * (`content/devices/`), the same data the simulator and lead drawing use; only the look lives here.
 *
 * Frame: the entity's own, as for props (rendering caveats): origin at the min corner, the device
 * spanning +x (`widthMm`), +y (`heightMm`) and +z (`depthMm`, standing off its mounting surface). Set
 * on a bench top (pitched −90°, `orientationForFrame`) a device's depth stands up, so the bench
 * devices put their tops at z = depth and their fronts at y = 0; the DIN PSU, made for a rail, faces
 * +z (its front at z = depth).
 *
 * One merged geometry per device, with a group per material slot ({@link DEVICE_SLOTS}), drawn with a
 * material array: one mesh, one pick, one BVH per device kind. A single material (the placement ghost)
 * draws every group. Labels carry only the entry's fictional brand and model name (realism charter);
 * the text is on the mesh's `userData.label` (and so in the scene-graph snapshot), the label plate is
 * geometry. Colours are renderer-local looks, not world data.
 */

/** Material slots, by group index. */
export const DEVICE_SLOTS = ['body', 'panel', 'label', 'positive', 'negative', 'accent'] as const;
type Slot = (typeof DEVICE_SLOTS)[number];

/** Which recipe draws a model kind. Kinds without one are drawn as unknown objects (until F2.5's recipes). */
const RECIPES: Readonly<Record<string, (def: DeviceDefinition) => Part[]>> = {
  battery: batteryParts,
  'supply.bench': benchSupplyParts,
  'supply.dinPsu': dinPsuParts,
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
export function buildDeviceMaterials(def: DeviceDefinition): Material[] {
  const look = LOOKS[def.model.kind];
  return DEVICE_SLOTS.map((slot) => new MeshStandardMaterial(look[slot]));
}

type Look = Readonly<Record<Slot, { color: number; roughness: number; metalness: number }>>;
const plastic = (color: number) => ({ color, roughness: 0.6, metalness: 0 });
const metal = (color: number) => ({ color, roughness: 0.4, metalness: 0.5 });
const LOOKS: Readonly<Record<string, Look>> = {
  battery: {
    body: plastic(0x2b2d30), // black ABS case
    panel: plastic(0x3a3d42), // lid
    label: plastic(0xd8d2c4), // paper label
    positive: plastic(0xc0392b), // red + terminal cover
    negative: plastic(0x1c1c1c),
    accent: metal(0xb8bcc0), // tinned terminal tabs
  },
  'supply.bench': {
    body: metal(0x5b6f82), // painted steel case
    panel: plastic(0x23272b), // front panel
    label: plastic(0xe6e6e6),
    positive: plastic(0xc0392b), // red binding post
    negative: plastic(0x1c1c1c), // black binding post
    accent: plastic(0x37c46b), // display windows
  },
  'supply.dinPsu': {
    body: plastic(0xb9bec4), // light grey housing
    panel: plastic(0x8e949b), // terminal block
    label: plastic(0xf0f0f0),
    positive: plastic(0xc0392b),
    negative: plastic(0x1c1c1c),
    accent: plastic(0x37c46b), // DC OK LED
  },
};

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

/** A cylinder of radius `r` (mm) along +z from z0 to z1, centred at (x, y). */
function cylinderZ(x: number, y: number, r: number, z0: number, z1: number): BufferGeometry {
  const g = new CylinderGeometry(mm(r), mm(r), mm(z1 - z0), 24);
  g.rotateX(Math.PI / 2);
  g.translate(mm(x), mm(y), mm((z0 + z1) / 2));
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
