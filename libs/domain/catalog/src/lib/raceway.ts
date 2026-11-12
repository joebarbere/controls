import type { DeviceDefinition, PointMm } from './device';
import { CUT_LENGTH_KEY, modelKind, TRADE_SIZE_INCHES } from './model-kinds';
import type { Axis, TradeSize } from './registries';

/*
 * Raceway geometry (F3.5 part 2): wire duct, EMT-lite sticks, elbows and connectors. Pure integer maths
 * from a catalogue entry and, for a cut-to-length part, its commanded `lengthMm`, shared by the
 * commands (body boxes, mounts, overlap), the placement maths (`world-model`'s conduit snapping) and
 * the renderer's recipes, so they can never disagree about where a part's body or ends are.
 */

/** A body size in a device's own frame (integer mm), as `sizeMm`. */
export interface BodySizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly depthMm: number;
}

/** A device's commanded state bag, as far as body geometry reads it. */
export type BodyState = Readonly<Record<string, unknown>> | null;

/** Whether the entry's model kind is a raceway, and which waypoint kind it hosts (`duct`, `conduit`). */
export function racewayOf(device: Pick<DeviceDefinition, 'model'>): 'duct' | 'conduit' | null {
  return modelKind(device.model.kind)?.raceway ?? null;
}

/** Whether the entry is cut to length: its kind declares the commanded {@link CUT_LENGTH_KEY}. */
export function isCutToLength(device: Pick<DeviceDefinition, 'model'>): boolean {
  const kind = modelKind(device.model.kind);
  return kind?.raceway !== undefined && kind.keys[CUT_LENGTH_KEY]?.owner === 'commanded';
}

/**
 * The cut length of a cut-to-length part (integer mm): its commanded `lengthMm`, or the entry's
 * `defaultLengthMm` for a part not placed yet (`state` `null` or without the key). `null` for an
 * entry that isn't cut to length.
 */
export function cutLengthMm(device: Pick<DeviceDefinition, 'model'>, state: BodyState): number | null {
  if (!isCutToLength(device)) return null;
  const value = state?.[CUT_LENGTH_KEY];
  return typeof value === 'number' ? value : device.model.params['defaultLengthMm'];
}

/**
 * A device's body size (integer mm): its catalogue `sizeMm`, except that a cut-to-length raceway's
 * width (along its +x) is its cut length ({@link cutLengthMm}). `null` for an entry with no body.
 */
export function deviceBodySizeMm(
  device: Pick<DeviceDefinition, 'model' | 'sizeMm'>,
  state: BodyState,
): BodySizeMm | null {
  const size = device.sizeMm;
  if (size === null) return null;
  const length = cutLengthMm(device, state);
  return length === null ? size : { widthMm: length, heightMm: size.heightMm, depthMm: size.depthMm };
}

/** The width a device takes along a mount of type `type` (its `fits` width, or a cut part's length), or `undefined`. */
export function deviceMountWidthMm(device: DeviceDefinition, type: string, state: BodyState): number | undefined {
  const fit = device.mounts.find((m) => m.type === type);
  if (fit === undefined) return undefined;
  return cutLengthMm(device, state) ?? fit.widthMm;
}

/** The trade size of a conduit part, or `null` (not a conduit part). */
export function conduitTradeSize(device: Pick<DeviceDefinition, 'model'>): TradeSize | null {
  if (racewayOf(device) !== 'conduit') return null;
  const inches = device.model.params['tradeSizeIn'];
  const found = Object.entries(TRADE_SIZE_INCHES).find(([, n]) => n === inches);
  return found ? (found[0] as TradeSize) : null;
}

/**
 * An end of a conduit part, in its own frame: where a neighbouring part's end meets it (the centre
 * of the tube's end face, integer mm) and the direction out of the part there. `entry` is a
 * connector's enclosure end, which fits an enclosure entry; every other end is a `joint`, which fits
 * the joint end of another part of the same trade size, facing it.
 */
export interface RacewayPort {
  readonly id: 'a' | 'b';
  readonly kind: 'joint' | 'entry';
  readonly positionMm: PointMm;
  readonly axis: Axis;
}

/**
 * The ends of a conduit part (F3.5 part 2), in its own frame, `a` first; empty for anything else
 * (ducts are laid, not joined, in P3):
 * - a stick of cut length L and body diameter D: `a` at (0, D/2, D/2) facing −x, `b` at (L, D/2, D/2) facing +x;
 * - an elbow of bend radius R: `a` at (D/2, 0, D/2) facing −y, `b` at (R + D/2, R, D/2) facing +x;
 * - a connector of body length W: `a`, the entry end, at (0, D/2, D/2) facing −x (into the
 *   enclosure), `b` at (W, D/2, D/2) facing +x.
 * Each end lies on a face of the body box, so parts joined end to end touch and never overlap.
 */
export function racewayPorts(device: Pick<DeviceDefinition, 'model' | 'sizeMm'>, state: BodyState): RacewayPort[] {
  const size = deviceBodySizeMm(device, state);
  if (size === null || racewayOf(device) !== 'conduit') return [];
  const r = size.depthMm / 2;
  switch (device.model.kind) {
    case 'raceway.conduit':
      return [
        { id: 'a', kind: 'joint', positionMm: { x: 0, y: r, z: r }, axis: '-x' },
        { id: 'b', kind: 'joint', positionMm: { x: size.widthMm, y: r, z: r }, axis: '+x' },
      ];
    case 'raceway.conduitElbow': {
      const bend = device.model.params['bendRadiusMm'];
      return [
        { id: 'a', kind: 'joint', positionMm: { x: r, y: 0, z: r }, axis: '-y' },
        { id: 'b', kind: 'joint', positionMm: { x: bend + r, y: bend, z: r }, axis: '+x' },
      ];
    }
    case 'raceway.conduitConnector':
      return [
        { id: 'a', kind: 'entry', positionMm: { x: 0, y: r, z: r }, axis: '-x' },
        { id: 'b', kind: 'joint', positionMm: { x: size.widthMm, y: r, z: r }, axis: '+x' },
      ];
    default:
      return [];
  }
}

/**
 * The load-time geometry rules of a raceway entry (F3.5 part 2), as `[path, message]` pairs. A cut
 * part's lengths fit its stock (`minLengthMm ≤ defaultLengthMm ≤ sizeMm.widthMm`); a conduit part's
 * body diameter (`depthMm`) is its tube's outside diameter rounded up to an even whole mm, so its ends
 * sit on whole millimetres; a stick and a connector are as tall as deep; an elbow's box is R + D/2
 * square; a duct's walls leave an inside.
 */
export function racewayEntryProblems(device: DeviceDefinition): [string, string][] {
  const raceway = racewayOf(device);
  const size = device.sizeMm;
  if (raceway === null || size === null) return [];
  const p = device.model.params;
  const problems: [string, string][] = [];
  if (isCutToLength(device) && !(p['defaultLengthMm'] <= size.widthMm)) {
    problems.push([
      'model.params.defaultLengthMm',
      'defaultLengthMm must not exceed the stock length (sizeMm.widthMm)',
    ]);
  }
  if (raceway === 'duct') {
    const wall = p['wallThicknessMm'];
    if (!(2 * wall < size.heightMm && wall < size.depthMm)) {
      problems.push(['model.params.wallThicknessMm', 'The duct walls must leave an inside']);
    }
    return problems;
  }
  const d = size.depthMm;
  const od = p['outsideDiameterMm'];
  const kind = device.model.kind;
  if (kind !== 'raceway.conduitConnector' && (d % 2 !== 0 || d < od || d - od >= 2)) {
    problems.push(['sizeMm', "A conduit part's depth is its tube's outside diameter rounded up to an even whole mm"]);
  }
  if (kind === 'raceway.conduitConnector' && (d % 2 !== 0 || d < od)) {
    problems.push(['sizeMm', "A connector's depth is an even whole mm, at least the tube's outside diameter"]);
  }
  if (kind === 'raceway.conduitElbow') {
    const box = p['bendRadiusMm'] + d / 2;
    if (size.widthMm !== box || size.heightMm !== box) {
      problems.push(['sizeMm', "An elbow's width and height are its bend radius plus half its depth"]);
    }
  } else if (size.heightMm !== d) {
    problems.push(['sizeMm', 'A conduit stick or connector is as tall as it is deep']);
  }
  return problems;
}
