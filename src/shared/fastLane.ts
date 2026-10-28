// The fast lane: time-sensitive player fields sent every tick as WebTransport datagrams
// (UDP), alongside the reliable state every client still receives. A lost datagram costs
// one stale sample, never a stall; players on a WebSocket simply use the reliable copy.
// Which fields ride it is the game's call (GameLogic.network), defaulting to smoothFields.
import type { GameInfo, Kind, ObjectKind } from './shapes.ts';

export const FAST_LANE_MESSAGE = 'fast';
const VERSION = 1;
/** Payload budget per datagram. Browsers report a maximum datagram size of 1,024 bytes or more
 * (more on paths with a larger MTU); this leaves room for the message header and framing. */
export const FAST_LANE_FRAME_BYTES = 900;
const HEADER_BYTES = 20;
/** Strings ride as at most this many UTF-8 bytes. */
export const FAST_STRING_BYTES = 64;
/** The most one player's fast fields may take, so a full roster still fits a few datagrams. */
export const FAST_PLAYER_BYTES = 600;

/** Wire kinds: float64, int32 and uint32 fields ride as 8-byte floats so they stay exact; other numbers as 4-byte. */
export type FastKind = 'float32' | 'float64' | 'boolean' | 'string';
export type FastValue = number | boolean | string;
export interface FastField { path: string; kind: FastKind }
/** One decoded datagram. An undefined value was unknown at the server (the reliable copy stands). */
export interface FastFrame { seq: number; serverTime: number; layout: number; roster: number; players: { index: number; values: (FastValue | undefined)[] }[] }

const fieldBytes = (kind: FastKind) => kind === 'float32' ? 4 : kind === 'float64' ? 8 : kind === 'boolean' ? 1 : 1 + FAST_STRING_BYTES;
const WIDE = new Set(['float64', 'int32', 'uint32']);

/** The kind of a declared scalar player field, or undefined. */
export function scalarKind(player: ObjectKind, path: string): FastKind | undefined {
  let shape: Kind = player;
  for (const part of path.split('.')) {
    if (shape.kind !== 'object') return undefined;
    const next: Kind | undefined = shape.fields.find(([name]) => name === part)?.[1];
    if (!next) return undefined;
    shape = next;
  }
  if (shape.kind === 'number') return WIDE.has(shape.type) ? 'float64' : 'float32';
  return shape.kind === 'boolean' || shape.kind === 'string' ? shape.kind : undefined;
}

/** The fast fields in wire order, with the kinds their shape declares. */
export function fastLaneLayout(info: Pick<GameInfo, 'player' | 'fastFields'>): FastField[] {
  return (info.fastFields ?? []).flatMap(path => { const kind = scalarKind(info.player, path); return kind ? [{ path, kind }] : []; });
}

/** The most bytes one player's fields can take. */
export const fastPlayerBytes = (fields: readonly FastField[]) => 1 + fields.reduce((sum, field) => sum + fieldBytes(field.kind), 0);

function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash;
}
/** Both ends must agree on the field list, or a frame would be read with the wrong layout. */
export const layoutHash = (fields: readonly FastField[]) => fnv(fields.map(field => `${field.path}:${field.kind}`).join('|'));
/** Players are indexed in room order; the roster hash proves both ends mean the same order. */
export const rosterHash = (sessionIds: readonly string[]) => fnv(sessionIds.join('|'));

// Created on first use: this module is also imported where no TextEncoder exists (the logic sandbox).
let text: { encoder: TextEncoder; decoder: TextDecoder } | undefined;
const codec = () => text ??= { encoder: new TextEncoder(), decoder: new TextDecoder() };
function stringBytes(value: string): Uint8Array {
  const { encoder } = codec();
  let bytes = encoder.encode(value);
  // Cut on a character boundary so the receiver never sees half a character.
  for (let chars = value.length; bytes.length > FAST_STRING_BYTES && chars > 0; chars--) bytes = encoder.encode(value.slice(0, chars - 1));
  return bytes;
}

/** One tick's fast fields for every player, split into datagram-sized frames. */
export function encodeFastLane(seq: number, serverTime: number, fields: readonly FastField[], sessionIds: readonly string[],
  values: readonly (readonly unknown[])[]): Uint8Array[] {
  const layout = layoutHash(fields), roster = rosterHash(sessionIds);
  const frames: Uint8Array[] = [];
  let buffer = new Uint8Array(FAST_LANE_FRAME_BYTES), view = new DataView(buffer.buffer), offset = HEADER_BYTES, count = 0;
  const flush = () => {
    if (!count) return;
    view.setUint8(0, VERSION); view.setUint16(1, seq & 0xffff, true); view.setFloat64(3, serverTime, true);
    view.setUint32(11, layout, true); view.setUint32(15, roster, true); view.setUint8(19, count);
    frames.push(buffer.slice(0, offset));
    buffer = new Uint8Array(FAST_LANE_FRAME_BYTES); view = new DataView(buffer.buffer); offset = HEADER_BYTES; count = 0;
  };
  const worst = fastPlayerBytes(fields);
  if (worst + HEADER_BYTES > FAST_LANE_FRAME_BYTES) return [];
  values.forEach((row, index) => {
    if (index > 255) return;
    if (offset + worst > FAST_LANE_FRAME_BYTES || count === 255) flush();
    view.setUint8(offset++, index);
    fields.forEach((field, column) => {
      const value = row[column];
      if (field.kind === 'float32') { view.setFloat32(offset, typeof value === 'number' ? value : Number.NaN, true); offset += 4; }
      else if (field.kind === 'float64') { view.setFloat64(offset, typeof value === 'number' ? value : Number.NaN, true); offset += 8; }
      else if (field.kind === 'boolean') view.setUint8(offset++, value === true ? 1 : value === false ? 0 : 2);
      else {
        const bytes = typeof value === 'string' ? stringBytes(value) : new Uint8Array(0);
        view.setUint8(offset++, typeof value === 'string' ? bytes.length : 255);
        buffer.set(bytes, offset); offset += bytes.length;
      }
    });
    count++;
  });
  flush();
  return frames;
}

/** Reads one frame, or null when it is not a fast-lane frame of this layout. Unknown
 * values (a non-finite number, a missing field) come back undefined so the reliable copy stands. */
export function decodeFastLane(bytes: Uint8Array, fields: readonly FastField[]): FastFrame | null {
  if (bytes.byteLength < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== VERSION || view.getUint32(11, true) !== layoutHash(fields)) return null;
  const frame: FastFrame = { seq: view.getUint16(1, true), serverTime: view.getFloat64(3, true), layout: view.getUint32(11, true), roster: view.getUint32(15, true), players: [] };
  let offset = HEADER_BYTES;
  try {
    for (let player = view.getUint8(19); player > 0; player--) {
      const index = view.getUint8(offset++);
      const values = fields.map((field): FastValue | undefined => {
        if (field.kind === 'float32' || field.kind === 'float64') {
          const value = field.kind === 'float32' ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
          offset += field.kind === 'float32' ? 4 : 8;
          return Number.isFinite(value) ? value : undefined;
        }
        if (field.kind === 'boolean') { const value = view.getUint8(offset++); return value === 2 ? undefined : value === 1; }
        const length = view.getUint8(offset++);
        if (length === 255) return undefined;
        const value = codec().decoder.decode(bytes.subarray(offset, offset + length)); offset += length;
        return value;
      });
      frame.players.push({ index, values });
    }
  } catch { return null; }
  return offset === bytes.byteLength ? frame : null;
}
