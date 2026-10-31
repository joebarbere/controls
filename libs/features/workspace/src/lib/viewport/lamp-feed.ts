import type { LampOutput, LampOutputs, LampSolveStatus } from '@controls/renderer';
import {
  DescriptorIndex,
  type FieldRef,
  RECORD_STATUS_VALUES,
  type SnapshotView,
  type TopologyDescriptor,
} from '@controls/sim-protocol';

/** The lamp model kind whose records the viewport draws (readers join by id and kind, ADR 0011 §5.4). */
export const LAMP_KIND = 'lamp.incandescent';

interface MutableLampOutput {
  lightOutputRel: number;
  status: LampSolveStatus;
}

/**
 * Each lamp's light output and reading status, read from the sim worker's snapshot (F2.5 on F2.3b,
 * ADR 0011 §9.2). The fields are resolved once per topology generation into an offset table
 * (`DescriptorIndex.of(descriptor).field(id, 'lightOutputRel', kind)` and `'status'`); each snapshot
 * is then one `readAll` into a reused buffer and reused entries, so the per-snapshot path allocates
 * nothing. A `null` view (a source reset: no game, a crash, a restart) leaves every lamp without an
 * entry, which the renderer draws as unknown (the validity rule), never as an off lamp.
 *
 * The map it returns is the same object every call, updated in place.
 */
export class LampSnapshotFeed {
  private descriptor: TopologyDescriptor | null = null;
  /** `lightOutputRel` then `status`, per lamp. */
  private fields: FieldRef[] = [];
  private entries: MutableLampOutput[] = [];
  private values = new Float64Array(0);
  private readonly outputs = new Map<number, LampOutput>();

  /** The lamp outputs for `view` (`null`: none, every lamp unknown). */
  update(view: SnapshotView | null): LampOutputs {
    if (view === null) {
      this.reset();
      return this.outputs;
    }
    if (view.descriptor !== this.descriptor) this.resolve(view.descriptor);
    view.readAll(this.fields, this.values);
    const entries = this.entries;
    const values = this.values;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      entry.lightOutputRel = values[2 * i];
      // A code past the table is no reading: unknown, like `unsolved`.
      entry.status = (RECORD_STATUS_VALUES[values[2 * i + 1]] ?? 'unsolved') as LampSolveStatus;
    }
    return this.outputs;
  }

  private reset(): void {
    this.descriptor = null;
    this.fields = [];
    this.entries = [];
    this.values = new Float64Array(0);
    this.outputs.clear();
  }

  /** The offset table for a new generation: once per descriptor, never per snapshot. */
  private resolve(descriptor: TopologyDescriptor): void {
    this.reset();
    this.descriptor = descriptor;
    const index = DescriptorIndex.of(descriptor);
    for (const device of descriptor.devices) {
      if (device.kind !== LAMP_KIND) continue;
      const light = index.field(device.entity, 'lightOutputRel', LAMP_KIND);
      const status = index.field(device.entity, 'status', LAMP_KIND);
      if (light === null || status === null) continue;
      const entry: MutableLampOutput = { lightOutputRel: 0, status: 'unsolved' };
      this.fields.push(light, status);
      this.entries.push(entry);
      this.outputs.set(device.entity, entry);
    }
    this.values = new Float64Array(this.fields.length);
  }
}
