import { looksLikeZip } from '@controls/save-format';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

/*
 * What `sim replay`, `sim hash` and `sim run --world` read (ADR 0008): a `.ctrl` save (F1.8b), or
 * one of the JSON documents a save contains: a world document (`world.json`, or a level such as
 * `content/levels/*.json`) or a replay log (`replay.log`, which is JSON). A `.ctrl` is recognised by
 * its extension or by the ZIP signature; JSON kinds are told apart by content, not by file name.
 */

/** Largest file `sim-cli` reads. Saves are far smaller (and `readCtrl` applies its own caps); this only stops a runaway file. */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export type DocumentKind = 'world' | 'replay-log';

export type ReadDocumentResult =
  | { readonly ok: true; readonly kind: DocumentKind; readonly json: unknown }
  | { readonly ok: true; readonly kind: 'ctrl'; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message: string };

/** Classifies parsed JSON: a replay log has `initialWorld` and `entries`; anything else is read as a world. */
export function documentKind(json: unknown): DocumentKind {
  return typeof json === 'object' && json !== null && !Array.isArray(json) && 'initialWorld' in json
    ? 'replay-log'
    : 'world';
}

/** Reads a save or a JSON document. Never throws; messages name the file but never echo its content. */
export async function readDocument(path: string, label = path): Promise<ReadDocumentResult> {
  let bytes: Uint8Array;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, message: `${label}: not a file` };
    if (info.size > MAX_DOCUMENT_BYTES) {
      return { ok: false, message: `${label}: larger than ${MAX_DOCUMENT_BYTES} bytes` };
    }
    const buffer = await readFile(path);
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    return { ok: false, message: `${label}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}` };
  }
  if (extname(path).toLowerCase() === '.ctrl' || looksLikeZip(bytes)) return { ok: true, kind: 'ctrl', bytes };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return { ok: false, message: `${label}: not valid JSON` };
  }
  return { ok: true, kind: documentKind(json), json };
}
