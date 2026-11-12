import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  CylinderGeometry,
  DoubleSide,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three/webgpu';
import { mm } from '@controls/units';
import {
  type BodySizeMm,
  type BodyState,
  BUILTIN_CATALOG,
  type Catalog,
  deviceBodySizeMm,
  type DeviceDefinition,
  type EnclosureEntry,
} from '@controls/catalog';
import type { CatalogRef } from '@controls/world-model';
import type { DrawnLamp } from '../sim/lamp-display';
import { buildDinRailGeometry } from './din-rail';
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
 * by the entity's commanded `state.closed` ({@link leverAngle}); the breaker's handle is the same kind of
 * lever, turned by `state.on`.
 *
 * F3.5 part 1: the 15 A breaker (a DIN-rail body facing +z, its terminal screws in the top and bottom
 * faces), the fuse (an inline holder on a base) and the enclosures: open-fronted boxes (rectangular or
 * round) and the DIN panel (a backplate and two TS35 rails inside an open-fronted case). An
 * enclosure's entries (knockouts, pryouts, clamps, drill sites) are drawn as two child meshes per
 * entity (`WorldSync`): the closed ones (a slug or tab, the `accent` slot) and the open ones (a dark
 * hole, the `opening` slot), from the entity's commanded `openEntries` bit set ({@link buildDeviceEntries}).
 *
 * F3.5 part 2: wire duct (a slotted comb on a base; its cover is a child mesh shown by the commanded
 * `coverOn`, {@link buildDeviceCover}), EMT-lite sticks, elbows and connectors, and DIN terminal blocks.
 * A cut-to-length part's recipe is built for its cut length (`deviceBodySizeMm`), so the recipe cache
 * keys it by length too (`PropRecipes`); every other recipe ignores the state.
 */

/** Material slots, by group index. */
export const DEVICE_SLOTS = ['body', 'panel', 'label', 'positive', 'negative', 'accent', 'bulb', 'opening'] as const;
type Slot = (typeof DEVICE_SLOTS)[number];

/** The material index of the lamp's bulb (cloned per lamp entity, so each glows on its own). */
export const BULB_SLOT: number = DEVICE_SLOTS.indexOf('bulb');

/** The lamp model kind, whose bulb glows by sim output. */
export const LAMP_KIND = 'lamp.incandescent';
/** The SPST switch model kind, whose lever follows `state.closed`. */
export const SWITCH_KIND = 'switch.spst';
/** The breaker model kind, whose handle follows `state.on`. */
export const BREAKER_KIND = 'breaker.thermalMagnetic';

/** The material index an open entry is drawn with (a dark hole). */
export const OPENING_SLOT: number = DEVICE_SLOTS.indexOf('opening');
/** The material index a closed entry is drawn with (the slug or tab). */
export const CLOSED_ENTRY_SLOT: number = DEVICE_SLOTS.indexOf('accent');

/** The duct model kind, whose cover follows `state.coverOn`. */
export const DUCT_KIND = 'raceway.duct';

/** Which recipe draws a model kind (given its body size: a cut part's length). Kinds without one are drawn as unknown objects. */
const RECIPES: Readonly<Record<string, (def: DeviceDefinition, size: BodySizeMm) => Part[]>> = {
  battery: batteryParts,
  'supply.bench': benchSupplyParts,
  'supply.dinPsu': dinPsuParts,
  [SWITCH_KIND]: switchParts,
  [LAMP_KIND]: lampParts,
  resistor: resistorParts,
  heater: heaterParts,
  [BREAKER_KIND]: breakerParts,
  fuse: fuseParts,
  'enclosure.box': boxEnclosureParts,
  'enclosure.panel': panelEnclosureParts,
  [DUCT_KIND]: ductParts,
  'raceway.conduit': conduitParts,
  'raceway.conduitElbow': elbowParts,
  'raceway.conduitConnector': connectorParts,
  'terminalBlock.feedThrough': terminalBlockParts,
  'terminalBlock.ground': terminalBlockParts,
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

/**
 * The device's merged geometry, in metres, one group per material slot used (see {@link DEVICE_SLOTS}),
 * for commanded `state` (a cut part's length; `null`: a part not placed yet, at its default length).
 */
export function buildDeviceGeometry(def: DeviceDefinition, state: BodyState = null): BufferGeometry {
  const parts = RECIPES[def.model.kind](def, deviceBodySizeMm(def, state) as BodySizeMm);
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
  const body = def.enclosure ? enclosureStyle(def).body : undefined;
  return DEVICE_SLOTS.map(
    (slot) =>
      new MeshStandardMaterial(slot === 'body' && body !== undefined ? { ...look[slot], color: body } : look[slot]),
  );
}

type SlotLook = { color: number; roughness: number; metalness: number; emissive?: number; side?: typeof DoubleSide };
type Look = Readonly<Record<Slot, SlotLook>>;
const plastic = (color: number) => ({ color, roughness: 0.6, metalness: 0 });
const metal = (color: number) => ({ color, roughness: 0.4, metalness: 0.5 });
/** A slot a kind doesn't use (no group points at it, so it is never drawn or compiled). */
const unused = plastic(0x808080);
/** An open entry: a hole into a dark box interior. */
const hole = { color: 0x101214, roughness: 1, metalness: 0 };

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
    opening: unused,
  },
  'supply.bench': {
    body: metal(0x5b6f82), // painted steel case
    panel: plastic(0x23272b), // front panel
    label: plastic(0xe6e6e6),
    positive: plastic(0xc0392b), // red binding post
    negative: plastic(0x1c1c1c), // black binding post
    accent: plastic(0x37c46b), // display windows
    bulb: unused,
    opening: unused,
  },
  'supply.dinPsu': {
    body: plastic(0xb9bec4), // light grey housing
    panel: plastic(0x8e949b), // terminal block
    label: plastic(0xf0f0f0),
    positive: plastic(0xc0392b),
    negative: plastic(0x1c1c1c),
    accent: plastic(0x37c46b), // DC OK LED
    bulb: unused,
    opening: unused,
  },
  [SWITCH_KIND]: {
    body: plastic(0x2f3338), // black base
    panel: plastic(0x8a9099), // switch body
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xc9ccd0), // nickel bushing, lever and screw heads
    bulb: unused,
    opening: unused,
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
    opening: unused,
  },
  resistor: {
    body: plastic(0x2f3338),
    panel: metal(0xc9a548), // gold anodised aluminium housing
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xc8a24a), // brass screw heads
    bulb: unused,
    opening: unused,
  },
  heater: {
    body: plastic(0x2f3338),
    panel: { color: 0x7a3b2e, roughness: 0.8, metalness: 0.2 }, // oxidised element
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xb8bcc0), // steel guard, posts and screw heads
    bulb: unused,
    opening: unused,
  },
  [BREAKER_KIND]: {
    body: plastic(0xe9e7e1), // off-white moulded case
    panel: plastic(0x2f3338), // DIN clip and handle
    label: plastic(0xf6f6f6),
    positive: unused,
    negative: unused,
    accent: metal(0xc9ccd0), // terminal screws
    bulb: unused,
    opening: unused,
  },
  fuse: {
    body: plastic(0x2f3338), // black base
    panel: { color: 0xd8e6ea, roughness: 0.1, metalness: 0 }, // glass cartridge
    label: plastic(0xe6e6e6),
    positive: unused,
    negative: unused,
    accent: metal(0xc9ccd0), // end caps, clips and screw heads
    bulb: unused,
    opening: unused,
  },
  'enclosure.box': {
    body: { ...metal(0xb8bec4), side: DoubleSide }, // galvanised steel (nonmetallic boxes: ENCLOSURE_STYLES)
    panel: unused,
    label: unused,
    positive: unused,
    negative: unused,
    accent: metal(0x9aa1a8), // knockout slugs, pryouts and clamp tabs
    bulb: unused,
    opening: hole,
  },
  [DUCT_KIND]: {
    body: plastic(0xb9bcbf), // light grey rigid PVC
    panel: plastic(0xa7abae), // the cover
    label: unused,
    positive: unused,
    negative: unused,
    accent: unused,
    bulb: unused,
    opening: unused,
  },
  'raceway.conduit': {
    body: metal(0xc3c7cb), // galvanised steel tube
    panel: unused,
    label: unused,
    positive: unused,
    negative: unused,
    accent: unused,
    bulb: unused,
    opening: hole, // the open bore at each cut end
  },
  'raceway.conduitElbow': {
    body: metal(0xc3c7cb),
    panel: unused,
    label: unused,
    positive: unused,
    negative: unused,
    accent: unused,
    bulb: unused,
    opening: hole,
  },
  'raceway.conduitConnector': {
    body: metal(0xb7bbbf), // zinc die-cast body
    panel: unused,
    label: unused,
    positive: unused,
    negative: unused,
    accent: metal(0x8d9196), // locknut, gland and set screw
    bulb: unused,
    opening: hole,
  },
  'terminalBlock.feedThrough': {
    body: plastic(0x9da3a8), // grey polyamide
    panel: plastic(0x2f3338), // DIN foot
    label: plastic(0xf0f0f0), // marker carrier
    positive: unused,
    negative: unused,
    accent: metal(0xc9ccd0), // clamp screws and spring releases
    bulb: unused,
    opening: hole, // conductor entries
  },
  'terminalBlock.ground': {
    body: plastic(0x2e8b3a), // green
    panel: plastic(0x2f3338),
    label: plastic(0xf0f0f0),
    positive: plastic(0xe8c51a), // the yellow stripe of a green-yellow PE block
    negative: unused,
    accent: metal(0xc9ccd0),
    bulb: unused,
    opening: hole,
  },
  'enclosure.panel': {
    body: { ...plastic(0xd7d8d2), side: DoubleSide }, // light grey powder-coated steel
    panel: metal(0xd9a441), // zinc-yellow passivated backplate
    label: unused,
    positive: unused,
    negative: unused,
    accent: metal(0xc4cad0), // zinc-plated rails and knockout slugs
    bulb: unused,
    opening: hole,
  },
};

/** How an enclosure entry is drawn (renderer-local look, keyed by catalogue id): shape, wall and colour. */
interface EnclosureStyle {
  readonly shape: 'box' | 'round';
  /** Drawn wall thickness (mm), as the entry's own size source describes it. */
  readonly wallMm: number;
  /** Body colour, replacing the kind's look (nonmetallic boxes are blue PVC). */
  readonly body?: number;
}

/** Per-entry enclosure looks. Anything not listed is a rectangular steel box with 2 mm walls. */
const ENCLOSURE_STYLES: Readonly<Record<string, EnclosureStyle>> = {
  'box.tinmoor-2g-nm': { shape: 'box', wallMm: 3, body: 0x2f5fa8 },
  'box.tinmoor-4rd-nm-ceiling': { shape: 'round', wallMm: 3, body: 0x2f5fa8 },
};
const DEFAULT_ENCLOSURE_STYLE: EnclosureStyle = { shape: 'box', wallMm: 2 };
const enclosureStyle = (def: DeviceDefinition): EnclosureStyle =>
  Object.prototype.hasOwnProperty.call(ENCLOSURE_STYLES, def.id) ? ENCLOSURE_STYLES[def.id] : DEFAULT_ENCLOSURE_STYLE;

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
 * A lever: a shared geometry drawn as a child mesh at `pivotMm` (device frame) with the material in
 * slot `slot`, turned about x by the entity's commanded boolean `stateKey` ({@link leverAngle}). The
 * switch's lever: upright is +z; closed leans it toward the base's back edge (+y: a rotation of
 * −{@link SWITCH_LEVER_THROW_MDEG} about x), open toward its front (−y). The breaker's handle: on leans
 * it up, toward the line terminal (+y), off down.
 */
export interface DeviceLever {
  readonly geometry: BufferGeometry;
  readonly pivotMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly slot: number;
  /** The commanded boolean key that turns it (`closed`, `on`). */
  readonly stateKey: string;
  /** The `userData` key its state is published under for the scene-graph snapshot (`switch`, `breaker`). */
  readonly userKey: 'switch' | 'breaker';
}

/** The lever of a device kind that has one (the SPST switch, the breaker's handle), else `null`. */
export function buildDeviceLever(def: DeviceDefinition): DeviceLever | null {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  if (def.model.kind === SWITCH_KIND) {
    // A rod with a fatter tip, from the pivot up +z.
    const geometry = merge([cylinderZ(0, 0, 2, 0, 13), cylinderZ(0, 0, 3.5, 11, 16)], false);
    const slot = DEVICE_SLOTS.indexOf('accent');
    return { geometry, pivotMm: { x: w / 2, y: h / 2, z: 29 }, slot, stateKey: 'closed', userKey: 'switch' };
  }
  if (def.model.kind === BREAKER_KIND) {
    // A flat toggle handle standing 12 mm out of the front from a pivot just inside it.
    const geometry = boxBetween(-6, -3, -2, 6, 3, 12);
    const slot = DEVICE_SLOTS.indexOf('panel');
    return { geometry, pivotMm: { x: w / 2, y: h / 2, z: d }, slot, stateKey: 'on', userKey: 'breaker' };
  }
  return null;
}

/** The lever's rotation about x, in radians, for a lever whose commanded state is `closed` (or `on`). */
export function leverAngle(closed: boolean): number {
  return ((closed ? -SWITCH_LEVER_THROW_MDEG : SWITCH_LEVER_THROW_MDEG) * Math.PI) / 180_000;
}

/** One entry of an enclosure, drawn as a per-entity child mesh with a shared geometry. */
export interface DeviceEntryPart {
  /** The catalogue entry id (`ko-top`); its index is its `openEntries` bit. */
  readonly id: string;
  readonly type: string;
  readonly geometry: BufferGeometry;
}

/**
 * Drawn diameters of a knockout or drill site, by trade size (mm): the standard knockout sizes (7/8, 1-3/32,
 * 1-23/64, 1-23/32, 1-31/32 and 2-15/32 in, rounded to whole mm). Renderer look only: the
 * hole a connector of that trade size goes through, not catalogue data.
 */
const ENTRY_DIAMETER_MM: Readonly<Record<string, number>> = {
  '1/2': 22,
  '3/4': 28,
  '1': 35,
  '1-1/4': 44,
  '1-1/2': 50,
  '2': 63,
};
/** A clamp tab or pryout, drawn as a square of this side (mm). */
const TAB_MM = 12;

/**
 * The entries of an enclosure, in catalogue order (empty for anything else): a disc (a knockout or
 * drill site) or a square tab (a clamp or pryout) through the wall at the entry's position, standing
 * 0.3 mm proud of both faces so it reads over the wall whether open or closed.
 */
export function buildDeviceEntries(def: DeviceDefinition): DeviceEntryPart[] {
  if (!def.enclosure) return [];
  const wall = enclosureStyle(def).wallMm;
  return def.enclosure.entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    geometry: entryGeometry(entry, wall),
  }));
}

function entryGeometry(entry: EnclosureEntry, wall: number): BufferGeometry {
  const thick = wall + 0.6;
  const round = entry.tradeSize !== null;
  const size = round ? (ENTRY_DIAMETER_MM[entry.tradeSize as string] ?? 22) : TAB_MM;
  // Built along +y (a cylinder's own axis), centred on the origin, then turned onto the entry's axis.
  const g = round
    ? new CylinderGeometry(mm(size / 2), mm(size / 2), mm(thick), 24)
    : boxBetween(-size / 2, -thick / 2, -size / 2, size / 2, thick / 2, size / 2);
  const axis = entry.axis[1];
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  // Centred in the wall: half a wall inward from the outside face the position is on.
  const shift = ((entry.axis[0] === '+' ? 1 : -1) * wall) / 2;
  const p = entry.positionMm;
  g.translate(
    mm(p.x + (axis === 'x' ? shift : 0)),
    mm(p.y + (axis === 'y' ? shift : 0)),
    mm(p.z + (axis === 'z' ? shift : 0)),
  );
  return g;
}

/**
 * Entry part geometries merged into one (the inputs are kept: they belong to the recipe), so an
 * enclosure draws all its closed entries in one call and all its open ones in another.
 */
export function mergeEntryGeometries(geometries: readonly BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries([...geometries], false);
  if (!g) throw new Error('entry geometry could not be merged');
  return g;
}

/** Whether entry `index` is open in an `openEntries` bit set (bit i is entry i). */
export function entryIsOpen(openEntries: unknown, index: number): boolean {
  return typeof openEntries === 'number' && Math.floor(openEntries / 2 ** index) % 2 === 1;
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

/**
 * The 15 A breaker on a DIN rail: a moulded case facing +z (its back on the rail), a black DIN clip
 * across the back, a raised front with the label, and a terminal screw in the top face (line) and the
 * bottom face (load) at each catalogue terminal. The handle is a lever ({@link buildDeviceLever}).
 */
function breakerParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const shoulder = d - 15; // the case's shoulders; the front stands out above them
  const parts: Part[] = [
    { slot: 'body', geometry: boxBetween(0, 0, 0, w, h, shoulder) },
    { slot: 'body', geometry: boxBetween(2, h / 2 - 22, shoulder, w - 2, h / 2 + 22, d) },
    { slot: 'panel', geometry: boxBetween(0, h / 2 - 20, -0.5, w, h / 2 + 20, 6) }, // DIN clip
    { slot: 'label', geometry: boxBetween(4, h / 2 + 10, d, w - 4, h / 2 + 20, d + 0.5) },
  ];
  for (const t of def.terminals) {
    const p = t.positionMm;
    // The screw is reached through the face nearer the terminal (top for line, bottom for load).
    const top = p.y > h / 2;
    parts.push({ slot: 'accent', geometry: cylinderY(p.x, p.z, 4, top ? h - 1 : -0.5, top ? h + 0.5 : 1) });
    parts.push({ slot: 'accent', geometry: cylinderY(p.x, p.z, 1.5, top ? p.y : 0, top ? h : p.y) });
  }
  return parts;
}

/** The fuse: a base with a screw terminal at each end, two clips and a glass cartridge with metal end caps. */
function fuseParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const axisZ = d - 10;
  return [
    ...baseParts(def),
    { slot: 'accent', geometry: boxBetween(14, h / 2 - 4, BASE_MM, 18, h / 2 + 4, axisZ) },
    { slot: 'accent', geometry: boxBetween(w - 18, h / 2 - 4, BASE_MM, w - 14, h / 2 + 4, axisZ) },
    { slot: 'panel', geometry: cylinderX(h / 2, axisZ, 4.5, 19, w - 19) },
    { slot: 'accent', geometry: cylinderX(h / 2, axisZ, 5, 13, 19) },
    { slot: 'accent', geometry: cylinderX(h / 2, axisZ, 5, w - 19, w - 13) },
  ];
}

/**
 * A box: the back (z = 0 to the wall) and four walls (or a round wall) up to the open front at
 * z = depth, in the `body` slot (drawn double-sided, so the inside reads). Entries are child meshes.
 */
function boxEnclosureParts(def: DeviceDefinition): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const style = enclosureStyle(def);
  const t = style.wallMm;
  if (style.shape === 'round') {
    const r = Math.min(w, h) / 2;
    const ring = new CylinderGeometry(mm(r), mm(r), mm(d - t), 48, 1, true);
    ring.rotateX(Math.PI / 2);
    ring.translate(mm(w / 2), mm(h / 2), mm((d + t) / 2));
    return [
      { slot: 'body', geometry: cylinderZ(w / 2, h / 2, r, 0, t) },
      { slot: 'body', geometry: ring },
    ];
  }
  return [
    { slot: 'body', geometry: boxBetween(0, 0, 0, w, h, t) },
    { slot: 'body', geometry: boxBetween(0, 0, t, t, h, d) },
    { slot: 'body', geometry: boxBetween(w - t, 0, t, w, h, d) },
    { slot: 'body', geometry: boxBetween(t, 0, t, w - t, t, d) },
    { slot: 'body', geometry: boxBetween(t, h - t, t, w - t, h, d) },
  ];
}

/** How far above a `din35` mount's origin its rail's centreline is drawn: half a 90 mm modular device (DIN 43880). */
export const DIN_MOUNT_CENTRE_MM = 45;

/**
 * The DIN panel: an open-fronted case (the body of a box), the backplate (the `panel` slot, 2 mm thick as the entry says,
 * its front face the area mount's plane, inside a border as wide as the mount's offset) and a TS35
 * rail (the `accent` slot) along each `din35` mount, its centreline {@link DIN_MOUNT_CENTRE_MM} above
 * the mount origin (where a mounted device's bottom edge sits) and its back on the plate.
 */
function panelEnclosureParts(def: DeviceDefinition): Part[] {
  const parts = boxEnclosureParts(def);
  const { widthMm: w, heightMm: h } = def.sizeMm as NonNullable<DeviceDefinition['sizeMm']>;
  const mounts = def.enclosure?.mounts ?? [];
  const plate = mounts.find((m) => m.type === 'backplate');
  if (plate) {
    const { x, y, z } = plate.positionMm;
    parts.push({ slot: 'panel', geometry: boxBetween(x, y, z - 2, w - x, h - y, z) });
  }
  for (const m of mounts) {
    if (m.type !== 'din35') continue;
    // The extruded profile is non-indexed; index it so it merges with the indexed boxes.
    const extruded = buildDinRailGeometry(m.extentMm);
    const rail = mergeVertices(extruded);
    extruded.dispose();
    const back = plate?.positionMm.z ?? m.positionMm.z - 8;
    rail.translate(mm(m.positionMm.x + m.extentMm / 2), mm(m.positionMm.y + DIN_MOUNT_CENTRE_MM), mm(back));
    parts.push({ slot: 'accent', geometry: rail });
  }
  return parts;
}

/** How deep the solid band along the bottom of a duct's walls is, below the slots (mm, game-design look). */
const DUCT_BAND_MM = 10;
/** The cover's thickness (mm, game-design look): it sits inside the body's depth, on top of the fingers. */
const DUCT_COVER_MM = 2;
/** At most this many fingers are drawn per wall (a 2 m duct at a 10 mm pitch is 200): a vertex budget. */
const MAX_DUCT_FINGERS = 256;

/**
 * Slotted wire duct, lying along +x for its cut length: a base on the plate (z = 0) and two walls
 * (y = 0 and y = height) of a solid band and fingers up to the cover, from the entry's wall, slot and
 * finger widths. The cover is not here ({@link buildDeviceCover}).
 */
function ductParts(def: DeviceDefinition, size: BodySizeMm): Part[] {
  const { widthMm: l, heightMm: w, depthMm: d } = size;
  const p = def.model.params;
  const t = p['wallThicknessMm'];
  const top = d - DUCT_COVER_MM;
  const band = Math.min(DUCT_BAND_MM, top / 3);
  const parts: Part[] = [
    { slot: 'body', geometry: boxBetween(0, 0, 0, l, w, t) },
    { slot: 'body', geometry: boxBetween(0, 0, t, l, t, band) },
    { slot: 'body', geometry: boxBetween(0, w - t, t, l, w, band) },
  ];
  const pitch = p['slotWidthMm'] + p['fingerWidthMm'];
  const fingers = Math.min(MAX_DUCT_FINGERS, Math.floor((l - p['fingerWidthMm']) / pitch) + 1);
  // Fingers centred along the cut, so a cut piece looks the same at both ends.
  const start = (l - ((fingers - 1) * pitch + p['fingerWidthMm'])) / 2;
  for (let k = 0; k < fingers; k++) {
    const x0 = start + k * pitch;
    const x1 = x0 + p['fingerWidthMm'];
    parts.push({ slot: 'body', geometry: boxBetween(x0, 0, band, x1, t, top) });
    parts.push({ slot: 'body', geometry: boxBetween(x0, w - t, band, x1, w, top) });
  }
  return parts;
}

/**
 * A duct's cover, its cut length (shared geometry owned by the recipe, drawn as the child mesh
 * `cover` in the `panel` slot when the entity's commanded `coverOn` is true), or `null` for anything
 * else.
 */
export function buildDeviceCover(def: DeviceDefinition, state: BodyState = null): BufferGeometry | null {
  if (def.model.kind !== DUCT_KIND) return null;
  const { widthMm: l, heightMm: w, depthMm: d } = deviceBodySizeMm(def, state) as BodySizeMm;
  return boxBetween(0, 0, d - DUCT_COVER_MM, l, w, d);
}

/** A tube's open bore at an end: a dark disc just proud of the end face, at x = `x` (mm). */
function boreDisc(r: number, inner: number, x: number, out: 1 | -1): BufferGeometry {
  return cylinderX(r, r, inner, x - (out < 0 ? 0.3 : 0), x + (out > 0 ? 0.3 : 0));
}

/** An EMT stick: a tube along +x for its cut length, centred in its body box, with its bore drawn at each end. */
function conduitParts(def: DeviceDefinition, size: BodySizeMm): Part[] {
  const r = size.depthMm / 2;
  const od = def.model.params['outsideDiameterMm'];
  const inner = od / 2 - def.model.params['wallThicknessMm'];
  return [
    { slot: 'body', geometry: cylinderX(r, r, od / 2, 0, size.widthMm) },
    { slot: 'opening', geometry: boreDisc(r, inner, 0, -1) },
    { slot: 'opening', geometry: boreDisc(r, inner, size.widthMm, 1) },
  ];
}

/**
 * A 90° elbow: a quarter torus of the bend radius about (R + D/2, 0, D/2) in the part's xy-plane, from
 * its end a at (D/2, 0) to its end b at (R + D/2, R) (`racewayPorts`), with a bore at each end.
 */
function elbowParts(def: DeviceDefinition, size: BodySizeMm): Part[] {
  const r = size.depthMm / 2;
  const bend = def.model.params['bendRadiusMm'];
  const od = def.model.params['outsideDiameterMm'];
  const inner = od / 2 - def.model.params['wallThicknessMm'];
  const torus = new TorusGeometry(mm(bend), mm(od / 2), 16, 24, Math.PI / 2);
  // The arc runs from angle 0 to 90°; turned by 90° it runs from +y to −x about the centre.
  torus.rotateZ(Math.PI / 2);
  torus.translate(mm(bend + r), 0, mm(r));
  return [
    { slot: 'body', geometry: torus },
    { slot: 'opening', geometry: cylinderY(r, r, inner, -0.3, 0) }, // end a (y = 0), facing −y
    { slot: 'opening', geometry: cylinderX(bend, r, inner, bend + r, bend + r + 0.3) }, // end b, facing +x
  ];
}

/** A hexagonal prism along +x (a nut), across-corners diameter `d`, centred at (y, z). */
function hexX(y: number, z: number, d: number, x0: number, x1: number): BufferGeometry {
  const g = new CylinderGeometry(mm(d / 2), mm(d / 2), mm(x1 - x0), 6);
  g.rotateZ(Math.PI / 2);
  g.translate(mm((x0 + x1) / 2), mm(y), mm(z));
  return g;
}

/**
 * A set-screw connector: outside the wall (0 ≤ x ≤ width) a hex shoulder against the wall and a
 * gland the tube enters, with its set screw; inside (x < 0, through the knockout) the threaded throat
 * and a locknut, which reach past the body box on purpose (they are inside the enclosure's own wall).
 */
function connectorParts(def: DeviceDefinition, size: BodySizeMm): Part[] {
  const { widthMm: w, depthMm: d } = size;
  const r = d / 2;
  const od = def.model.params['outsideDiameterMm'];
  const throat = def.model.params['throatLengthMm'];
  const shoulder = Math.round(w * 0.35);
  const inner = od / 2 - def.model.params['wallThicknessMm'];
  return [
    { slot: 'body', geometry: hexX(r, r, d, 0, shoulder) },
    { slot: 'body', geometry: cylinderX(r, r, od / 2 + 2, shoulder, w) },
    { slot: 'accent', geometry: cylinderY(shoulder + (w - shoulder) / 2, r, 2, r, r + od / 2 + 4) },
    { slot: 'body', geometry: cylinderX(r, r, od / 2 + 1, -throat, 0) },
    { slot: 'accent', geometry: hexX(r, r, d, -throat, -throat + 3) },
    { slot: 'opening', geometry: boreDisc(r, inner, -throat, -1) },
  ];
}

/**
 * A DIN terminal block standing on its rail, facing +z: a body, a DIN foot across the back at the
 * rail's centreline (the body's mid-height, as `crossMm` centres it), a marker carrier on the front,
 * and per terminal a clamp screw (or a spring release) on the front and a dark conductor entry where
 * its method's `entryMm` is. A ground block carries a yellow stripe on its green body.
 */
function terminalBlockParts(def: DeviceDefinition, size: BodySizeMm): Part[] {
  const { widthMm: w, heightMm: h, depthMm: d } = size;
  const front = d - 6;
  const mid = Math.floor(h / 2);
  const parts: Part[] = [
    { slot: 'body', geometry: boxBetween(0, 0, 0, w, h, front) },
    { slot: 'body', geometry: boxBetween(0.4, h * 0.3, front, w - 0.4, h * 0.7, d - 1) },
    { slot: 'label', geometry: boxBetween(0.6, mid - 4, d - 1, w - 0.6, mid + 4, d) },
    { slot: 'panel', geometry: boxBetween(0, mid - 12, -0.5, w, mid + 12, 4) },
  ];
  if (def.model.kind === 'terminalBlock.ground') {
    parts.push({ slot: 'positive', geometry: boxBetween(-0.2, h * 0.3, 8, w + 0.2, h * 0.3 + 4, front) });
  }
  for (const t of def.terminals) {
    const m = t.methods[0];
    const p = t.positionMm;
    const screw = m?.method === 'screw';
    parts.push({
      slot: 'accent',
      geometry: screw
        ? cylinderZ(p.x, p.y, Math.min(w / 2 - 0.4, 2.5), front - 1, front + 0.5)
        : boxBetween(p.x - w / 2 + 1, p.y - 3, front - 1, p.x + w / 2 - 1, p.y + 3, front + 0.5),
    });
    if (m) {
      const e = m.entryMm;
      const out = m.exitAxis === '+y' ? 0.3 : -0.3;
      parts.push({
        slot: 'opening',
        geometry: boxBetween(
          e.x - w / 2 + 1,
          Math.min(e.y, e.y + out),
          e.z - 2.5,
          e.x + w / 2 - 1,
          Math.max(e.y, e.y + out),
          e.z + 2.5,
        ),
      });
    }
  }
  return parts;
}
