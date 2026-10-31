import { ELEMENT_KIND_CODES, SOURCE_CODES, TOPOLOGY_ENCODING_HEADER } from './hash';
import type { NetlistBranch, NetlistNode } from './types';

/*
 * The compiler's encoder for `topologyHash` (F2.2 part 3b): the bytes of `topologyBytes(nodes,
 * branches)` exactly, written into a buffer the compiler keeps, so a structural recompile neither
 * allocates nor grows one, and with one capacity check per member and per branch rather than one per
 * field. `topologyBytes` (hash.ts) stays the reference: the netlist property tests check every
 * compiled `topologyHash` against `computeTopologyHash` of the netlist's own nodes and branches, and
 * hash.spec.ts pins the bytes. Not exported from the package.
 *
 * Caching each fragment's encoded pieces was tried and dropped: it saved about 0.1 ms per recompile
 * of the 2,000-node plant but cost 0.75 ms on a from-scratch compile (building some 6,000 small
 * arrays), which a load pays.
 */

/** The most bytes one member or one branch can take: two strings of at most 255 code units and some varints. */
const MAX_ITEM_BYTES = 2 * 256 + 4 * 8 + 3;

export class TopologyWriter {
  private buffer = new Uint8Array(0);
  private length = 0;

  /** The canonical bytes of `nodes` and `branches`: a view of the buffer, valid until the next call. */
  encode(nodes: readonly NetlistNode[], branches: readonly NetlistBranch[]): Uint8Array {
    this.length = 0;
    // A first guess at the size (a few bytes a member, a few dozen a branch), so a new compiler grows
    // its buffer once rather than by doubling; the checks below keep it exact whatever the ids.
    this.reserve(TOPOLOGY_ENCODING_HEADER.length + 8 * nodes.length + 32 * branches.length + 16);
    for (const byte of TOPOLOGY_ENCODING_HEADER) this.buffer[this.length++] = byte;
    this.varint(nodes.length);
    for (const node of nodes) {
      this.reserve(8);
      this.varint(node.members.length);
      for (const member of node.members) {
        this.reserve(MAX_ITEM_BYTES);
        this.varint(member.entity);
        this.ascii(member.terminal);
      }
    }
    this.reserve(8);
    this.varint(branches.length);
    for (const branch of branches) {
      this.reserve(MAX_ITEM_BYTES);
      const element = branch.element;
      if (element.kind === 'entity') {
        this.buffer[this.length++] = 0;
        this.varint(element.entity);
        this.ascii(element.part);
      } else {
        this.buffer[this.length++] = 1;
        this.varint(element.connection);
      }
      this.buffer[this.length++] = ELEMENT_KIND_CODES[branch.kind];
      this.buffer[this.length++] = branch.source === null ? 0 : SOURCE_CODES[branch.source];
      this.ascii(branch.model);
      this.varint(branch.a);
      this.varint(branch.b);
    }
    return this.buffer.subarray(0, this.length);
  }

  /** Makes room for `extra` more bytes, keeping what was written. The buffer only grows. */
  private reserve(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    const grown = new Uint8Array(Math.max(2 * this.buffer.length, this.length + extra, 1024));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  /** Unsigned LEB128 of a non-negative safe integer, exactly as `topologyBytes` writes it. */
  private varint(value: number): void {
    const buffer = this.buffer;
    let length = this.length;
    // Above 2³¹ the bit operators would wrap: divide instead (entity ids may be that large).
    while (value >= 0x8000_0000) {
      buffer[length++] = (value % 0x80) + 0x80;
      value = Math.floor(value / 0x80);
    }
    while (value >= 0x80) {
      buffer[length++] = (value & 0x7f) | 0x80;
      value >>>= 7;
    }
    buffer[length++] = value;
    this.length = length;
  }

  /** A length byte and the code units, refusing what `topologyBytes` refuses (with its message). */
  private ascii(text: string): void {
    if (text.length > 0xff) throw new Error(`Not a short ASCII id: ${JSON.stringify(text)}`);
    const buffer = this.buffer;
    let length = this.length;
    buffer[length++] = text.length;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0x7e) throw new Error(`Not a short ASCII id: ${JSON.stringify(text)}`);
      buffer[length++] = code;
    }
    this.length = length;
  }
}
