import type { TerrainPreparedWorld } from './terrainWorld.ts';
import type { PhysicsScene } from './physics.ts';

export type TerrainPreparationPieceKind = 'chunks' | 'heightfieldChunks' | 'staticColliders' | 'eager';
export interface TerrainPreparationHeader {
  version: 1;
  revision: string;
  loadedRevision: string;
  checksum: string;
  collisionRevision?: string;
  streamedRevision?: string;
  sceneKind: 'chunks' | 'terrain' | 'both' | 'none';
  counts: Record<TerrainPreparationPieceKind, number>;
}
export interface TerrainPreparationReuse {
  baseChecksum:string;
  chunks:unknown[];
  heightfieldChunks:unknown[];
  staticColliders:unknown[];
}
/** References are indexes into the last activated cache, never caller paths.
 * Changed pieces remain ordinary validated, bounded plain data. */
export function terrainPreparationReuse(before:TerrainPreparedWorld|undefined,after:TerrainPreparedWorld):TerrainPreparationReuse|undefined{
  if(!before?.streamed||!after.streamed||before.streamed.revision!==after.streamed.revision||before.eager||after.eager||before.scene.terrain||after.scene.terrain)return;
  const refs=(old:readonly unknown[],next:readonly unknown[],key:(value:any)=>string,copy=(value:any)=>value)=>{
    const index=new Map(old.map((value,i)=>[key(value),i]));
    return next.map(value=>index.get(key(value))??copy(value));
  };
  const reuse:TerrainPreparationReuse={baseChecksum:before.checksum,
    chunks:refs(before.streamed.chunks,after.streamed.chunks,value=>JSON.stringify([value.id,value.x,value.z,value.manifest.revision]),value=>{
      const {recipe:_,...manifest}=value.manifest;return{...value,manifest};}),
    heightfieldChunks:refs(before.scene.terrainChunks??[],after.scene.terrainChunks??[],value=>JSON.stringify(value)),
    staticColliders:refs(before.scene.colliders,after.scene.colliders,value=>JSON.stringify(value))};
  // A large source/layout change takes the existing sliced full-transfer path.
  return JSON.stringify(reuse).length<=96*1024?reuse:undefined;
}
const kinds: readonly TerrainPreparationPieceKind[] = ['chunks', 'heightfieldChunks', 'staticColliders', 'eager'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** A captured plain context, not the latest animation frame, binds all stages. */
export function terrainPreparationContext(tuning: unknown, world: unknown): string {
  let left = 150000;
  const canonical = (value: unknown, depth = 0): string => {
    if (--left < 0 || depth > 32) throw new Error('Terrain preparation context exceeds its bound.');
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
    if (record(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
    if (typeof value === 'number' && !Number.isFinite(value) || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint')
      throw new Error('Terrain preparation context must be plain data.');
    return JSON.stringify(value) ?? 'null';
  };
  return canonical([tuning, world]);
}

/** The host validates the complete cache checksum before transfer. These
 * stages bound and sequence that already validated data; they do not authorize
 * an arbitrary cache or expose host capabilities to authored game code. */
export class TerrainPreparationTransfer {
  private lastId = 0;
  private accepted?:TerrainPreparedWorld;
  private pending?: {
    id: number; context: string; header: TerrainPreparationHeader;
    parts: Record<TerrainPreparationPieceKind, unknown[]>; remainingNodes: number;
  };
  activate(cache:TerrainPreparedWorld):void {this.accepted=cache;}
  reuse(id:number,context:string,header:TerrainPreparationHeader,reuse:TerrainPreparationReuse):true{
    const before=this.accepted;
    if(!before?.streamed||!record(reuse)||reuse.baseChecksum!==before.checksum||header.streamedRevision!==before.streamed.revision
      ||header.sceneKind!=='chunks'||before.scene.terrain||before.eager||Object.keys(reuse).some(key=>!['baseChecksum','chunks','heightfieldChunks','staticColliders'].includes(key)))
      throw new Error('Terrain reuse does not match the activated base.');
    if(JSON.stringify(reuse).length>96*1024)throw new Error('Terrain reuse exceeds its transfer budget.');
    this.begin(id,context,header);
    const state=this.require(id),pools={chunks:before.streamed.chunks,heightfieldChunks:before.scene.terrainChunks??[],staticColliders:before.scene.colliders};
    for(const kind of ['chunks','heightfieldChunks','staticColliders'] as const){
      const values=reuse[kind];if(!Array.isArray(values)||values.length!==header.counts[kind])throw new Error('Terrain reuse count differs from its header.');
      state.parts[kind]=values.map(value=>{
        if(typeof value==='number'){
          if(!Number.isSafeInteger(value)||value<0||value>=pools[kind].length)throw new Error('Terrain reuse index is outside its activated base.');
          return pools[kind][value];
        }
        if(!record(value))throw new Error('Terrain reuse pieces must be records or activated indexes.');
        return this.freezePiece(state,value);
      });
    }
    return true;
  }

  begin(id: number, context: string, header: TerrainPreparationHeader): true {
    if (!Number.isSafeInteger(id) || id <= this.lastId) throw new Error('Stale terrain preparation transfer id.');
    if (!record(header) || header.version !== 1 || !text(header.revision) || !text(header.loadedRevision) || !text(header.checksum)
      || !['chunks', 'terrain', 'both', 'none'].includes(header.sceneKind) || !record(header.counts)
      || header.collisionRevision !== undefined && (typeof header.collisionRevision !== 'string' || !/^[0-9a-f]{16}$/.test(header.collisionRevision))
      || Object.keys(header).some(key => !['version', 'revision', 'loadedRevision', 'checksum', 'collisionRevision', 'streamedRevision', 'sceneKind', 'counts'].includes(key))
      || Object.keys(header.counts).some(key => !kinds.includes(key as TerrainPreparationPieceKind)))
      throw new Error('Invalid terrain preparation transfer header.');
    const counts = header.counts;
    for (const kind of kinds) if (!Number.isSafeInteger(counts[kind]) || counts[kind] < 0
      || counts[kind] > (kind === 'staticColliders' ? 12288 : kind === 'eager' ? 1 : kind === 'heightfieldChunks' && header.sceneKind === 'both' ? 129 : 128))
      throw new Error('Terrain preparation transfer count exceeds its bound.');
    if (header.streamedRevision !== undefined ? !text(header.streamedRevision) || !counts.chunks || counts.eager !== 0
      : counts.chunks !== 0 || counts.eager !== 1)
      throw new Error('Terrain preparation transfer mode differs from its counts.');
    if (header.sceneKind === 'terrain' ? counts.heightfieldChunks !== 1 : header.sceneKind === 'none' && counts.heightfieldChunks !== 0)
      throw new Error('Terrain preparation scene differs from its counts.');
    if (header.sceneKind === 'both' && !counts.heightfieldChunks) throw new Error('Terrain preparation scene differs from its counts.');
    this.lastId = id;
    this.pending = { id, context, header: { ...header, counts: { ...counts } },
      parts: { chunks: [], heightfieldChunks: [], staticColliders: [], eager: [] }, remainingNodes: 2000000 };
    return true;
  }

  append(id: number, kind: TerrainPreparationPieceKind, offset: number, values: unknown[]): true {
    const state = this.require(id);
    const expected = kinds.find(candidate => state.parts[candidate].length < state.header.counts[candidate]);
    if (kind !== expected || !Number.isSafeInteger(offset) || offset !== state.parts[kind]?.length
      || !Array.isArray(values) || !values.length || offset + values.length > state.header.counts[kind])
      throw new Error('Terrain preparation pieces are out of order or exceed their declared count.');
    const accepted = values.map(value => this.freezePiece(state,value));
    state.parts[kind].push(...accepted);
    return true;
  }
  private freezePiece(state:NonNullable<TerrainPreparationTransfer['pending']>,value:unknown,depth=0):unknown{
      if (--state.remainingNodes < 0 || depth > 32) throw new Error('Terrain preparation pieces exceed their plain-data bound.');
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Terrain preparation pieces require finite numbers.');
      if (value && typeof value === 'object') {
        if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Terrain preparation pieces must be plain data.');
        for (const item of Object.values(value)) this.freezePiece(state,item, depth + 1);
        Object.freeze(value);
      } else if (!['undefined', 'boolean', 'number', 'string'].includes(typeof value) && value !== null) throw new Error('Terrain preparation pieces must be plain data.');
      return value;
  }

  finish(id: number, context: string): TerrainPreparedWorld {
    const state = this.require(id);
    if (context !== state.context) throw new Error('Terrain preparation context changed during transfer.');
    if (kinds.some(kind => state.parts[kind].length !== state.header.counts[kind])) throw new Error('Terrain preparation transfer is incomplete.');
    const { header, parts } = state;
    const scene: PhysicsScene = { colliders: Object.freeze(parts.staticColliders) as PhysicsScene['colliders'],
      ...(header.sceneKind === 'both' ? { terrain: parts.heightfieldChunks[0] as PhysicsScene['terrain'],
        terrainChunks: Object.freeze(parts.heightfieldChunks.slice(1)) as PhysicsScene['terrainChunks'] }
        : header.sceneKind === 'chunks' ? { terrainChunks: Object.freeze(parts.heightfieldChunks) as PhysicsScene['terrainChunks'] }
        : header.sceneKind === 'terrain' ? { terrain: parts.heightfieldChunks[0] as PhysicsScene['terrain'] } : {}) };
    const cache: TerrainPreparedWorld = { version: 1, revision: header.revision, loadedRevision: header.loadedRevision, checksum: header.checksum,
      ...(header.collisionRevision === undefined ? {} : { collisionRevision: header.collisionRevision }),
      scene: Object.freeze(scene), ...(header.streamedRevision !== undefined
        ? { streamed: { version: 1 as const, revision: header.streamedRevision, chunks: Object.freeze(parts.chunks) as NonNullable<TerrainPreparedWorld['streamed']>['chunks'] } }
        // Eager adoption updates its top-level revision/collider references.
        : { eager: { ...parts.eager[0] as NonNullable<TerrainPreparedWorld['eager']> } }) };
    this.pending = undefined;
    return cache;
  }

  private require(id: number) {
    if (!this.pending || id !== this.pending.id) throw new Error('Stale terrain preparation transfer id.');
    return this.pending;
  }
}
