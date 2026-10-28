import { FlushAckSchema, FlushRequestSchema } from './lifecycle';

describe('FlushRequestSchema', () => {
  it('accepts a positive integer request id', () => {
    expect(FlushRequestSchema.parse({ requestId: 1 })).toEqual({ requestId: 1 });
  });

  it.each([
    [{}],
    [{ requestId: 0 }],
    [{ requestId: 1.5 }],
    [{ requestId: '1' }],
    [{ requestId: 1, extra: true }],
    [null],
  ])('rejects %j', (payload) => {
    expect(FlushRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe('FlushAckSchema', () => {
  it('accepts an id and an outcome', () => {
    expect(FlushAckSchema.parse({ requestId: 7, ok: false })).toEqual({ requestId: 7, ok: false });
  });

  it.each([
    [{ requestId: 7 }],
    [{ requestId: -1, ok: true }],
    [{ requestId: 7, ok: 'yes' }],
    [{ requestId: 7, ok: true, more: 1 }],
  ])('rejects %j', (payload) => {
    expect(FlushAckSchema.safeParse(payload).success).toBe(false);
  });
});
