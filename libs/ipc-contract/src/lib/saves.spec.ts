import {
  autosaveFileName,
  autosaveSlotOf,
  compareSaveEntries,
  DialogSaveAsRequestSchema,
  isUint8Array,
  manualSaveFileName,
  manualSaveNameOf,
  MAX_SAVE_NAME_LENGTH,
  pickAutosaveSlot,
  saveErrorCodeOf,
  SaveHandleSchema,
  SaveNameSchema,
  saveRefusalMessage,
  SaveWriteRequestSchema,
  type SaveEntry,
} from './saves';

describe('SaveNameSchema', () => {
  it.each(['Workshop', 'my save (2)', 'Ünïcode 1', 'a', 'x'.repeat(MAX_SAVE_NAME_LENGTH), "Joe's [test] #1 & co.v2"])(
    'accepts %j',
    (name) => expect(SaveNameSchema.safeParse(name).success).toBe(true),
  );

  it.each([
    '',
    'x'.repeat(MAX_SAVE_NAME_LENGTH + 1),
    '../evil',
    '..',
    '.',
    '.hidden',
    'a/b',
    'a\\b',
    'C:evil',
    'nul\0byte',
    'line\nbreak',
    'trailing ',
    'trailing.',
    ' leading',
    '-flag',
    'CON',
    'con.txt',
    'Com1',
    'LPT9',
    'aux',
    'a*b',
    'a?b',
    'a<b>',
    'a|b',
    'a"b',
    'a:b',
  ])('refuses %j', (name) => expect(SaveNameSchema.safeParse(name).success).toBe(false));
});

describe('SaveHandleSchema', () => {
  it('accepts 22 base64url characters only', () => {
    expect(SaveHandleSchema.safeParse('AbCdEfGhIjKlMnOpQrSt_-').success).toBe(true);
    for (const bad of ['', 'short', '../../../../etc/passwd', 'AbCdEfGhIjKlMnOpQrSt_-x', 'AbCdEfGhIjKlMnOpQrSt/=', 42])
      expect(SaveHandleSchema.safeParse(bad).success).toBe(false);
  });
});

describe('SaveWriteRequestSchema', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  it('accepts each target kind with non-empty bytes', () => {
    for (const target of [
      { kind: 'manual', name: 'A', overwrite: false },
      { kind: 'autosave', slotCount: 3 },
      { kind: 'handle', handle: 'AbCdEfGhIjKlMnOpQrSt_-' },
    ])
      expect(SaveWriteRequestSchema.safeParse({ target, bytes }).success).toBe(true);
  });

  it.each([
    [{ target: { kind: 'manual', name: 'A', overwrite: false }, bytes: new Uint8Array() }],
    [{ target: { kind: 'manual', name: 'A', overwrite: false }, bytes: [1, 2] }],
    [{ target: { kind: 'manual', name: 'A', overwrite: false }, bytes: new Uint16Array([1]) }],
    [{ target: { kind: 'manual', name: 'A', overwrite: false }, bytes: 'AAAA' }],
    [{ target: { kind: 'manual', name: 'A' }, bytes: new Uint8Array([1]) }],
    [{ target: { kind: 'autosave', slotCount: 0 }, bytes: new Uint8Array([1]) }],
    [{ target: { kind: 'autosave', slotCount: 21 }, bytes: new Uint8Array([1]) }],
    [{ target: { kind: 'path', path: '/etc/passwd' }, bytes: new Uint8Array([1]) }],
    [{ target: { kind: 'handle', handle: 'x' }, bytes: new Uint8Array([1]) }],
    [{ target: { kind: 'autosave', slotCount: 1 }, bytes: new Uint8Array([1]), extra: 1 }],
    [undefined],
  ])('refuses %#', (payload) => expect(SaveWriteRequestSchema.safeParse(payload).success).toBe(false));
});

describe('DialogSaveAsRequestSchema', () => {
  it('validates the suggested name like a save name', () => {
    expect(DialogSaveAsRequestSchema.safeParse({ fileType: 'ctrl', suggestedName: 'Shop' }).success).toBe(true);
    expect(DialogSaveAsRequestSchema.safeParse({ fileType: 'ctrl', suggestedName: '../x' }).success).toBe(false);
    expect(DialogSaveAsRequestSchema.safeParse({ fileType: 'exe', suggestedName: 'x' }).success).toBe(false);
  });
});

describe('file names', () => {
  it('maps manual names both ways and ignores other files', () => {
    expect(manualSaveFileName('Shop')).toBe('Shop.ctrl');
    expect(manualSaveNameOf('Shop.ctrl')).toBe('Shop');
    for (const other of ['Shop.json', '.Shop.ctrl.123.0.tmp', '.ctrl', 'CON.ctrl', 'Shop.CTRL'])
      expect(manualSaveNameOf(other)).toBeNull();
  });

  it('maps autosave slots both ways, canonical names only', () => {
    expect(autosaveFileName(3)).toBe('slot-3.ctrl');
    expect(autosaveSlotOf('slot-3.ctrl')).toBe(3);
    expect(autosaveSlotOf('slot-20.ctrl')).toBe(20);
    for (const other of ['slot-0.ctrl', 'slot-03.ctrl', 'slot-21.ctrl', 'slot-3.ctrl.tmp', 'slot-.ctrl'])
      expect(autosaveSlotOf(other)).toBeNull();
  });
});

describe('pickAutosaveSlot', () => {
  const at = (slot: number, modifiedMs: number) => ({ slot, modifiedMs });

  it('fills free slots first, lowest first', () => {
    expect(pickAutosaveSlot([], 3, null)).toBe(1);
    expect(pickAutosaveSlot([at(1, 5), at(3, 9)], 3, null)).toBe(2);
  });

  it('then overwrites the oldest, ties to the lowest slot', () => {
    expect(pickAutosaveSlot([at(1, 50), at(2, 10), at(3, 30)], 3, null)).toBe(2);
    expect(pickAutosaveSlot([at(1, 10), at(2, 10), at(3, 10)], 3, null)).toBe(1);
  });

  it('ignores slots above the count', () => {
    expect(pickAutosaveSlot([at(1, 50), at(2, 60), at(5, 1)], 2, null)).toBe(1);
  });

  it('rotates after the slot written last in this session, whatever the mtimes say', () => {
    expect(pickAutosaveSlot([at(1, 10), at(2, 10), at(3, 10)], 3, 1)).toBe(2);
    expect(pickAutosaveSlot([], 3, 3)).toBe(1);
    expect(pickAutosaveSlot([], 2, 5)).toBe(1); // the count shrank
  });
});

describe('refusal messages', () => {
  it('round-trip the code, including through Electron’s invoke wrapper', () => {
    const message = saveRefusalMessage('save:read', 'unknown-handle');
    expect(message).toBe('save:read refused (unknown-handle).');
    expect(saveErrorCodeOf(`Error invoking remote method 'save:read': Error: ${message}`)).toBe('unknown-handle');
    expect(saveErrorCodeOf('ENOENT: /home/x')).toBe('io');
    expect(saveErrorCodeOf('save:read refused (made-up).')).toBe('io');
  });
});

describe('compareSaveEntries', () => {
  it('sorts newest first, then manual before autosave, then by name', () => {
    const e = (name: string, kind: SaveEntry['kind'], modifiedMs: number): SaveEntry => ({
      handle: 'AbCdEfGhIjKlMnOpQrSt_-',
      name,
      kind,
      slot: kind === 'autosave' ? 1 : null,
      modifiedMs,
      sizeBytes: 1,
    });
    const sorted = [e('b', 'manual', 1), e('Autosave 1', 'autosave', 2), e('a', 'manual', 2), e('c', 'manual', 3)]
      .sort(compareSaveEntries)
      .map((x) => x.name);
    expect(sorted).toEqual(['c', 'a', 'Autosave 1', 'b']);
  });
});

describe('isUint8Array', () => {
  it('accepts Uint8Array and Buffer, nothing else', () => {
    expect(isUint8Array(new Uint8Array(1))).toBe(true);
    expect(isUint8Array(Buffer.from('x'))).toBe(true);
    for (const other of [new ArrayBuffer(1), new Int8Array(1), new DataView(new ArrayBuffer(1)), [1], null])
      expect(isUint8Array(other)).toBe(false);
  });
});
