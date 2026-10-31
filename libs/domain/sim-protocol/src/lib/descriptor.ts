import { TerminalId } from '@controls/save-format';
import { z } from 'zod';
import type { DeviceOutputField, DeviceOutputFieldType, DeviceOutputSchema } from './device-output';

/*
 * The topology descriptor (ADR 0011 §7): what the snapshot's indices mean for one topology
 * generation. Sent by message (`topology`) once per generation, before the first slot of that
 * generation is written, and parsed on receipt. Plain JSON-compatible data.
 */

const Count = z.int().min(0);
const EntityId = z.int().min(1);

const TerminalRefSchema = z.strictObject({ entity: EntityId, terminal: TerminalId });

const ElementRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entity'), entity: EntityId, part: z.string().min(1).max(32) }),
  z.strictObject({ kind: z.literal('connection'), connection: EntityId }),
]);

const DeviceOutputFieldSchema = z.strictObject({
  name: z.string().min(1).max(64),
  type: z.enum(['f64', 'u32', 'i32', 'u8']),
  offset: Count,
  unit: z.string().max(16).nullable(),
  values: z.array(z.string().max(32)).nullable(),
});

const DeviceOutputSchemaSchema = z.strictObject({
  kind: z.string().min(1).max(64),
  recordBytes: Count,
  fields: z.array(DeviceOutputFieldSchema),
});

/** The descriptor's Zod schema: every received descriptor is parsed with it. */
export const TopologyDescriptorSchema = z.strictObject({
  protocol: Count,
  /** Joins with a slot's `topologyGeneration`. */
  generation: Count,
  /** Lower-case hex; equals the slot's raw `topologyHash` bytes. */
  topologyHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Index = F2.1's node numbering; members sorted. */
  nodes: z.array(z.strictObject({ island: Count, members: z.array(TerminalRefSchema).min(1) })),
  branches: z.array(z.strictObject({ element: ElementRefSchema, a: Count, b: Count, island: Count })),
  islands: z.array(z.strictObject({ kind: z.enum(['empty', 'dc', 'ac', 'mixed']), nodes: z.array(Count) })),
  /** Entity ascending: one per device whose model publishes a record. */
  devices: z.array(z.strictObject({ entity: EntityId, kind: z.string().min(1).max(64), recordOffset: Count })),
  /** Every kind used in `devices`. */
  schemas: z.record(z.string(), DeviceOutputSchemaSchema),
});

export type DescriptorTerminalRef = z.infer<typeof TerminalRefSchema>;
export type DescriptorElementRef = z.infer<typeof ElementRefSchema>;

/** ADR 0011 §7's descriptor. A new object for each generation and each worker: key caches on identity. */
export interface TopologyDescriptor {
  readonly protocol: number;
  readonly generation: number;
  readonly topologyHash: string;
  readonly nodes: readonly { readonly island: number; readonly members: readonly DescriptorTerminalRef[] }[];
  readonly branches: readonly {
    readonly element: DescriptorElementRef;
    readonly a: number;
    readonly b: number;
    readonly island: number;
  }[];
  readonly islands: readonly { readonly kind: 'empty' | 'dc' | 'ac' | 'mixed'; readonly nodes: readonly number[] }[];
  readonly devices: readonly { readonly entity: number; readonly kind: string; readonly recordOffset: number }[];
  readonly schemas: Readonly<Record<string, DeviceOutputSchema>>;
}

/** A resolved device field: where to read it in a slot's device section, and how. */
export interface FieldRef {
  /** The byte offset within the device section (record offset + field offset). */
  readonly offset: number;
  readonly type: DeviceOutputFieldType;
  readonly field: DeviceOutputField;
}

const indexes = new WeakMap<TopologyDescriptor, DescriptorIndex>();

/**
 * Lookups over one descriptor, resolved once per generation, never per frame:
 * `DescriptorIndex.of(descriptor).field(entityId, 'lightOutputRel')`. Cached by descriptor identity.
 */
export class DescriptorIndex {
  private readonly devices = new Map<number, TopologyDescriptor['devices'][number]>();

  private constructor(readonly descriptor: TopologyDescriptor) {
    for (const device of descriptor.devices) this.devices.set(device.entity, device);
  }

  static of(descriptor: TopologyDescriptor): DescriptorIndex {
    let index = indexes.get(descriptor);
    if (index === undefined) indexes.set(descriptor, (index = new DescriptorIndex(descriptor)));
    return index;
  }

  /**
   * The field `name` of entity `entity`'s record, or `null` if the entity publishes none, its kind
   * isn't `kind` (when given: readers join by id and kind, ADR 0011 §5.4), or its schema has no such field.
   */
  field(entity: number, name: string, kind?: string): FieldRef | null {
    const device = this.devices.get(entity);
    if (device === undefined || (kind !== undefined && device.kind !== kind)) return null;
    const schema = Object.prototype.hasOwnProperty.call(this.descriptor.schemas, device.kind)
      ? this.descriptor.schemas[device.kind]
      : undefined;
    const field = schema?.fields.find((f) => f.name === name);
    return field === undefined ? null : { offset: device.recordOffset + field.offset, type: field.type, field };
  }
}
