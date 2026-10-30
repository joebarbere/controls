import { sha256, toHex } from '@controls/world-model';
import type { ElementKind, ElementRef, NetlistBranch, NetlistNode, SourceDomain } from './types';

/*
 * `topologyHash` (plan F2.1, ADR 0011 §5.2 and §9.6): SHA-256, by the pure implementation in
 * `@controls/world-model` (the one `world.hash` uses), over a canonical byte encoding of the
 * netlist's structure:
 *
 * - the partition: every node's members, in node order;
 * - every branch's element, element kind, source domain, model kind and end nodes, in branch order.
 *
 * Values (resistances, setpoints, nameplates) are left out, so a value-only change keeps the hash and
 * the factorisation cache (F2.2 part 3) can reuse a symbolic factorisation. Islands are left out too:
 * they follow from the partition and the branch ends. Element refs are in, because the solution
 * record (`WorldV2.sim`) is ordered by branch and is checked against this hash when the engine starts.
 *
 * The encoding is compact rather than readable because it is hashed on every topology change, inside
 * F2.2's re-solve budget: a 2,000-node plant encodes to about 36 KB. Integers are unsigned LEB128;
 * strings (terminal ids, parts, model kinds, all ASCII by their grammars) are a length byte and their
 * bytes:
 *
 * ```text
 * "CNT" 0x01                                  format and version
 * varint nodeCount
 *   per node:   varint memberCount, then per member: varint entity, str terminal
 * varint branchCount
 *   per branch: u8 0, varint entity, str part   (an entity's element)
 *            or u8 1, varint connection         (a connection)
 *               u8 element kind (ELEMENT_KIND_CODES), u8 source (SOURCE_CODES), str model,
 *               varint a, varint b
 * ```
 *
 * Changing the encoding moves every persisted `topologyHash`: bump the version byte and
 * `SIM_ENGINE_VERSION` together, and re-pin the goldens.
 */

/** The first four bytes: `CNT` and the encoding version. */
export const TOPOLOGY_ENCODING_HEADER: readonly number[] = [0x43, 0x4e, 0x54, 0x01];

/** Element kinds as encoded. Append only: a new kind gets the next code. */
export const ELEMENT_KIND_CODES: Readonly<Record<ElementKind, number>> = { resistor: 0, vsource: 1 };

/** Source domains as encoded: 0 for a passive element. Append only. */
export const SOURCE_CODES: Readonly<Record<SourceDomain, number>> = { dc: 1, ac: 2 };

/** `e<entity>.<part>` or `c<connection>`: how `formatNetlist` names a branch's element. */
export function elementKey(element: ElementRef): string {
  return element.kind === 'entity' ? `e${element.entity}.${element.part}` : `c${element.connection}`;
}

/** A growable byte buffer for the encoding. */
class ByteWriter {
  private bytes: Uint8Array;
  private length = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(Math.max(capacity, 64));
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  byte(value: number): void {
    this.ensure(1);
    this.bytes[this.length++] = value;
  }

  /** Unsigned LEB128 of a non-negative safe integer (ids, counts, indices). */
  varint(value: number): void {
    this.ensure(8);
    while (value >= 0x80) {
      this.bytes[this.length++] = (value % 0x80) + 0x80;
      value = Math.floor(value / 0x80);
    }
    this.bytes[this.length++] = value;
  }

  /** A length byte, then the string's code units, which must be ASCII (the id grammars guarantee it). */
  ascii(text: string): void {
    if (text.length > 0xff) throw new Error(`Not a short ASCII id: ${JSON.stringify(text)}`);
    this.ensure(text.length + 1);
    this.bytes[this.length++] = text.length;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0x7e) throw new Error(`Not a short ASCII id: ${JSON.stringify(text)}`);
      this.bytes[this.length++] = code;
    }
  }

  result(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/** The canonical bytes `topologyHash` digests (see the format above). */
export function topologyBytes(nodes: readonly NetlistNode[], branches: readonly NetlistBranch[]): Uint8Array {
  const out = new ByteWriter(8 + nodes.length * 6 + branches.length * 16);
  for (const byte of TOPOLOGY_ENCODING_HEADER) out.byte(byte);
  out.varint(nodes.length);
  for (const node of nodes) {
    out.varint(node.members.length);
    for (const member of node.members) {
      out.varint(member.entity);
      out.ascii(member.terminal);
    }
  }
  out.varint(branches.length);
  for (const branch of branches) {
    const element = branch.element;
    if (element.kind === 'entity') {
      out.byte(0);
      out.varint(element.entity);
      out.ascii(element.part);
    } else {
      out.byte(1);
      out.varint(element.connection);
    }
    out.byte(ELEMENT_KIND_CODES[branch.kind]);
    out.byte(branch.source === null ? 0 : SOURCE_CODES[branch.source]);
    out.ascii(branch.model);
    out.varint(branch.a);
    out.varint(branch.b);
  }
  return out.result();
}

/** SHA-256 of {@link topologyBytes}, lower-case hex. */
export function computeTopologyHash(nodes: readonly NetlistNode[], branches: readonly NetlistBranch[]): string {
  return toHex(sha256(topologyBytes(nodes, branches)));
}
