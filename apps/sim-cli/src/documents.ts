import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

/*
 * What `sim replay` and `sim hash` read (ADR 0008). Until the `.ctrl` ZIP container lands (F1.8b),
 * they read the JSON documents a `.ctrl` will contain: a world document (`world.json`, or a level
 * such as `content/levels/*.json`) and a replay log (`replay.log`, which is JSON). The kind is taken
 * from the content, not the file name, so `replay.log` and `*.json` both work. F1.8b adds `.ctrl`
 * here: `hash` will read its `world.json`, `replay` its `replay.log`.
 */

/** Largest document `sim-cli` reads. Saves are far smaller; this only stops a runaway file. */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export type DocumentKind = 'world' | 'replay-log';

export type ReadDocumentResult =
  | { readonly ok: true; readonly kind: DocumentKind; readonly json: unknown }
  | { readonly ok: false; readonly message: string };

/** Classifies parsed JSON: a replay log has `initialWorld` and `entries`; anything else is read as a world. */
export function documentKind(json: unknown): DocumentKind {
  return typeof json === 'object' && json !== null && !Array.isArray(json) && 'initialWorld' in json
    ? 'replay-log'
    : 'world';
}

/** Reads and parses a document file. Never throws; messages name the file but never echo its content. */
export async function readDocument(path: string, label = path): Promise<ReadDocumentResult> {
  if (extname(path).toLowerCase() === '.ctrl') {
    return {
      ok: false,
      message: `${label}: .ctrl saves are not supported until F1.8b; pass the world or replay-log JSON instead`,
    };
  }
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { ok: false, message: `${label}: not a file` };
    if (info.size > MAX_DOCUMENT_BYTES) {
      return { ok: false, message: `${label}: larger than ${MAX_DOCUMENT_BYTES} bytes` };
    }
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, message: `${label}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: `${label}: not valid JSON` };
  }
  return { ok: true, kind: documentKind(json), json };
}
