import { ELEMENT_KIND_CODES, RELATION_CODES, SOURCE_CODES, TOPOLOGY_ENCODING_HEADER } from './hash';
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

/** The most bytes one member or one branch can take: two strings of at most 255 code units, some varints and bytes. */
const MAX_ITEM_BYTES = 2 * 256 + 4 * 8 + 4;

/**
 * The codes of the kinds every netlist holds, read once: a keyed load from the code tables by a string
 * that varies branch to branch was about a fifth of `writeBranches` (perf only; the tables stay the
 * definition, and any other kind is still looked up there).
 */
const RESISTOR_CODE = ELEMENT_KIND_CODES.resistor;
const VSOURCE_CODE = ELEMENT_KIND_CODES.vsource;
const DC_CODE = SOURCE_CODES.dc;
const AC_CODE = SOURCE_CODES.ac;

export class TopologyWriter {
  private buffer = new Uint8Array(0);
  private length = 0;
  /** Where the last `encode`'s node section ends (its branch count starts): see `encodeBranches`. */
  nodesEnd = 0;

  /** The canonical bytes of `nodes` and `branches`: a view of the buffer, valid until the next call. */
  encode(nodes: readonly NetlistNode[], branches: readonly NetlistBranch[]): Uint8Array {
    this.length = 0;
    // A first guess at the size (a few bytes a member, a few dozen a branch), so a new compiler grows
    // its buffer once rather than by doubling; the checks below keep it exact whatever the ids.
    this.reserve(TOPOLOGY_ENCODING_HEADER.length + 8 * nodes.length + 32 * branches.length + 16);
    for (const byte of TOPOLOGY_ENCODING_HEADER) this.buffer[this.length++] = byte;
    this.varint(nodes.length);
    for (let n = 0; n < nodes.length; n++) {
      const members = nodes[n].members;
      this.reserve(8);
      this.varint(members.length);
      for (let m = 0; m < members.length; m++) {
        const member = members[m];
        this.reserve(MAX_ITEM_BYTES);
        this.varint(member.entity);
        this.ascii(member.terminal);
      }
    }
    this.nodesEnd = this.length;
    this.writeBranches(branches);
    return this.buffer.subarray(0, this.length);
  }

  /**
   * The canonical bytes of the last `encode`'s nodes with `branches` instead: only the branch section is
   * rewritten (F3.6 part 2's toggle path, whose nodes are unchanged). Valid only while the buffer holds
   * an encoding of the same nodes.
   */
  encodeBranches(branches: readonly NetlistBranch[]): Uint8Array {
    this.length = this.nodesEnd;
    this.reserve(32 * branches.length + 16);
    this.writeBranches(branches);
    return this.buffer.subarray(0, this.length);
  }

  private writeBranches(branches: readonly NetlistBranch[]): void {
    this.reserve(8);
    this.varint(branches.length);
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i];
      this.reserve(MAX_ITEM_BYTES);
      const element = branch.element;
      if (element.kind === 'entity') {
        this.buffer[this.length++] = 0;
        this.varint(element.entity);
        this.ascii(element.part);
      } else if (element.kind === 'connection') {
        this.buffer[this.length++] = 1;
        this.varint(element.connection);
      } else {
        // A relation contact (engine 8): tag 2, the dependent entity, the relation code, the contact id.
        this.buffer[this.length++] = 2;
        this.varint(element.entity);
        this.buffer[this.length++] = RELATION_CODES[element.relation];
        this.ascii(element.contact);
      }
      const kind = branch.kind;
      this.buffer[this.length++] =
        kind === 'resistor' ? RESISTOR_CODE : kind === 'vsource' ? VSOURCE_CODE : ELEMENT_KIND_CODES[kind];
      const source = branch.source;
      this.buffer[this.length++] =
        source === null ? 0 : source === 'dc' ? DC_CODE : source === 'ac' ? AC_CODE : SOURCE_CODES[source];
      this.ascii(branch.model);
      this.varint(branch.a);
      this.varint(branch.b);
    }
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
