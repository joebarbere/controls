import { z } from 'zod';

/**
 * How long main waits for the renderer to acknowledge a flush request before it closes the window
 * or quits anyway. Long enough for an atomic settings write (milliseconds); short enough that a hung
 * or crashed renderer can't stop the player from quitting.
 */
export const FLUSH_BEFORE_QUIT_TIMEOUT_MS = 2000;

/** Request ids are positive safe integers, allocated by main and echoed back in the ack. */
const RequestId = z.int().positive();

/**
 * `app:flush-request` (main → renderer): the window is about to close or the app is about to quit;
 * finish pending writes (debounced settings now, autosave in F1.8b), then acknowledge.
 */
export const FlushRequestSchema = z.strictObject({ requestId: RequestId });
export type FlushRequest = z.infer<typeof FlushRequestSchema>;

/**
 * `app:flush-ack` (renderer → main): the request with this id is done. `ok` is false if a flush
 * failed; main closes or quits either way (the renderer has already told the player).
 */
export const FlushAckSchema = z.strictObject({ requestId: RequestId, ok: z.boolean() });
export type FlushAck = z.infer<typeof FlushAckSchema>;
