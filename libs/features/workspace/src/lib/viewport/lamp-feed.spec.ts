import { DescriptorIndex } from '@controls/sim-protocol';
import { LAMP_KIND, LampSnapshotFeed } from './lamp-feed';
import { fakeView, lampDescriptor, writeLamp } from './lamp-feed.fakes';

describe('LampSnapshotFeed', () => {
  it('reads each lamp by the descriptor, joined by id and kind, and nothing else', () => {
    const descriptor = lampDescriptor([
      { entity: 3, kind: 'resistor', recordOffset: 0 },
      { entity: 5, kind: LAMP_KIND, recordOffset: 32 },
      { entity: 9, kind: LAMP_KIND, recordOffset: 88 },
    ]);
    const section = new DataView(new ArrayBuffer(144));
    writeLamp(section, 32, 0.75, 1);
    writeLamp(section, 88, 0, 0);
    const outputs = new LampSnapshotFeed().update(fakeView(descriptor, section));
    expect([...outputs]).toStrictEqual([
      [5, { lightOutputRel: 0.75, status: 'solved' }],
      [9, { lightOutputRel: 0, status: 'unsolved' }],
    ]);
  });

  it('updates in place on every snapshot of a generation, resolving the fields again only on a new one', () => {
    const of = vi.spyOn(DescriptorIndex, 'of');
    const descriptor = lampDescriptor([{ entity: 5, kind: LAMP_KIND, recordOffset: 0 }]);
    const section = new DataView(new ArrayBuffer(56));
    const feed = new LampSnapshotFeed();
    writeLamp(section, 0, 0.1, 1);
    const first = feed.update(fakeView(descriptor, section));
    const entry = first.get(5);
    writeLamp(section, 0, 0.9, 2);
    const second = feed.update(fakeView(descriptor, section));
    expect(second).toBe(first);
    expect(second.get(5)).toBe(entry); // the same entry, rewritten
    expect(entry).toStrictEqual({ lightOutputRel: 0.9, status: 'unsettled' });
    expect(of).toHaveBeenCalledTimes(1); // two snapshots of one generation: resolved once
    // A new generation: the lamp moved in the device section, and a heater took its old offset.
    const next = lampDescriptor(
      [
        { entity: 2, kind: 'heater', recordOffset: 0 },
        { entity: 5, kind: LAMP_KIND, recordOffset: 32 },
      ],
      2,
    );
    const moved = new DataView(new ArrayBuffer(88));
    moved.setFloat64(0, 12, true); // the heater's voltage, where the lamp used to be
    writeLamp(moved, 32, 0.5, 1);
    expect([...feed.update(fakeView(next, moved))]).toStrictEqual([[5, { lightOutputRel: 0.5, status: 'solved' }]]);
    expect(of).toHaveBeenCalledTimes(2); // a new descriptor: resolved again
    expect(of).toHaveBeenLastCalledWith(next);
    of.mockRestore();
  });

  it('leaves every lamp unknown on a reset, and reads a status code past the table as unsolved', () => {
    const descriptor = lampDescriptor([{ entity: 5, kind: LAMP_KIND, recordOffset: 0 }]);
    const section = new DataView(new ArrayBuffer(56));
    writeLamp(section, 0, 1, 7);
    const feed = new LampSnapshotFeed();
    expect(feed.update(fakeView(descriptor, section)).get(5)?.status).toBe('unsolved');
    expect(feed.update(null).size).toBe(0);
    writeLamp(section, 0, 1, 1);
    expect(feed.update(fakeView(descriptor, section)).get(5)).toStrictEqual({ lightOutputRel: 1, status: 'solved' });
  });

  it('skips a lamp whose descriptor carries no schema with the fields', () => {
    const descriptor = { ...lampDescriptor([{ entity: 5, kind: LAMP_KIND, recordOffset: 0 }]), schemas: {} };
    expect(new LampSnapshotFeed().update(fakeView(descriptor, new DataView(new ArrayBuffer(56)))).size).toBe(0);
  });
});
