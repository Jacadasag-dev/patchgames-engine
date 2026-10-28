import { decodeFastLane, rosterHash, type FastField, type FastValue } from '../../shared/fastLane.ts';

/** Samples kept per player field: about a second at 30 Hz, far more than any interpolation delay. */
const RING = 32;
/** With no datagram for this long the fast lane counts as stalled and the reliable state takes over. */
export const FAST_LANE_STALE_MS = 300;
/** Ticks per loss window for the readout. */
const LOSS_WINDOW = 120;

interface Series { times: number[]; values: FastValue[] }

/**
 * The browser end of the fast lane (shared/fastLane.ts): every player's time-sensitive fields,
 * one sample per server tick, kept on the server-time axis the SDK interpolates on. Smooth
 * numeric fields are read between samples like the SDK's lerp; the others read as the newest
 * value. A frame for another roster or layout is ignored, so the reliable state stands.
 */
export class FastLaneReceiver {
  private readonly columns: Map<string, number>;
  private readonly players = new Map<string, Series[]>();
  private lastArrival = Number.NEGATIVE_INFINITY;
  private seen = new Set<number>();
  private windowStart: number | undefined;
  private lossRatio = 0;
  /** Frames this receiver could not use (wrong layout, roster or a damaged datagram). */
  rejected = 0;

  private readonly fields: readonly FastField[];

  constructor(fields: readonly FastField[]) {
    this.fields = fields;
    this.columns = new Map(fields.map((field, index) => [field.path, index]));
  }

  /** Stores one datagram. Returns its server time, or undefined when it does not describe this room. */
  receive(bytes: Uint8Array, sessionIds: readonly string[], arrival: number): number | undefined {
    const frame = decodeFastLane(bytes, this.fields);
    const ids = [...sessionIds].sort();
    if (!frame || frame.roster !== rosterHash(ids)) { this.rejected++; return undefined; }
    this.countSeq(frame.seq);
    for (const { index, values } of frame.players) {
      const id = ids[index];
      if (id === undefined) continue;
      let series = this.players.get(id);
      if (!series) this.players.set(id, series = this.fields.map(() => ({ times: [], values: [] })));
      values.forEach((value, column) => { if (value !== undefined) insert(series![column]!, frame.serverTime, value); });
    }
    this.lastArrival = arrival;
    return frame.serverTime;
  }

  /** Whether datagrams are still arriving. */
  active(now: number): boolean { return now - this.lastArrival < FAST_LANE_STALE_MS; }

  /** Share of ticks whose datagram never arrived, over the last complete window. */
  get loss(): number { return this.lossRatio; }

  /** A field's value at server time `target`, between the samples around it; held at either end. */
  sampleAt(id: string, path: string, target: number): number | undefined {
    const series = this.series(id, path);
    if (!series?.times.length) return undefined;
    const { times, values } = series;
    const last = times.length - 1;
    if (target >= times[last]!) return numeric(values[last]);
    if (target <= times[0]!) return numeric(values[0]);
    let after = last;
    while (after > 0 && times[after - 1]! > target) after--;
    const before = after - 1, a = numeric(values[before]), b = numeric(values[after]);
    if (a === undefined || b === undefined) return b ?? a;
    const span = times[after]! - times[before]!;
    return span > 0 ? a + (b - a) * (target - times[before]!) / span : b;
  }

  /** A field's newest value and the server time it was sent at. */
  latest(id: string, path: string): { value: FastValue; stamp: number } | undefined {
    const series = this.series(id, path);
    const last = series ? series.times.length - 1 : -1;
    return last >= 0 ? { value: series!.values[last]!, stamp: series!.times[last]! } : undefined;
  }

  /** A new connection or round: earlier samples describe another timeline. */
  reset(): void {
    this.players.clear();
    this.lastArrival = Number.NEGATIVE_INFINITY;
    this.seen.clear(); this.windowStart = undefined;
  }

  private series(id: string, path: string): Series | undefined {
    const column = this.columns.get(path);
    return column === undefined ? undefined : this.players.get(id)?.[column];
  }

  private countSeq(seq: number): void {
    if (this.windowStart === undefined) this.windowStart = seq;
    const offset = (seq - this.windowStart) & 0xffff;
    // A late frame from an earlier window is already counted as lost; one far ahead (a long stall) starts over.
    if (offset >= 0x8000) return;
    if (offset >= LOSS_WINDOW * 2) { this.seen.clear(); this.windowStart = seq; this.seen.add(0); return; }
    if (offset >= LOSS_WINDOW) {
      this.lossRatio = 1 - this.seen.size / LOSS_WINDOW;
      this.seen.clear(); this.windowStart = (this.windowStart + LOSS_WINDOW) & 0xffff;
      this.seen.add(offset - LOSS_WINDOW);
      return;
    }
    this.seen.add(offset);
  }
}

const numeric = (value: FastValue | undefined) => typeof value === 'number' ? value : undefined;

/** Keeps samples in server-time order (datagrams can arrive out of order) and the ring bounded. */
function insert(series: Series, time: number, value: FastValue): void {
  const { times, values } = series;
  let at = times.length;
  while (at > 0 && times[at - 1]! > time) at--;
  if (at > 0 && times[at - 1] === time) { values[at - 1] = value; return; }
  if (at === 0 && times.length >= RING) return;
  times.splice(at, 0, time); values.splice(at, 0, value);
  if (times.length > RING) { times.shift(); values.shift(); }
}
