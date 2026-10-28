import type {PhysicsCollider, PhysicsVector} from './physics.ts';

/** Editable finite voxel fields. Air is zero; material IDs are 1..255.
 * Generation is authored pure code. Caches never contain durable world edits. */
export interface VoxelBounds {minX:number;maxX:number;minY:number;maxY:number;minZ:number;maxZ:number}
export interface VoxelEdit extends PhysicsVector {material:number}
export interface VoxelFieldOptions {
  bounds:VoxelBounds;
  sample:(x:number,y:number,z:number)=>number;
  solid?:(material:number)=>boolean;
  chunkSize?:number;
  maxCachedColumns?:number;
}
export interface VoxelRayHit {block:PhysicsVector;previous:PhysicsVector;normal:PhysicsVector;material:number;distance:number}
export interface VoxelSurface {positions:number[];normals:number[];uvs:number[];materials:number[]}
export type VoxelSurfaceCache=Map<string,{revision:number;surface:VoxelSurface}>;
const surfaceCacheOwners=new WeakMap<VoxelSurfaceCache,object>();
const surfaceFaces=[{n:[1,0,0],u:[0,1,0],v:[0,0,1]},{n:[-1,0,0],u:[0,0,1],v:[0,1,0]},
  {n:[0,1,0],u:[0,0,1],v:[1,0,0]},{n:[0,-1,0],u:[1,0,0],v:[0,0,1]},
  {n:[0,0,1],u:[1,0,0],v:[0,1,0]},{n:[0,0,-1],u:[0,1,0],v:[1,0,0]}];
const surfaceCorners=[[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]];
const key=(x:number,z:number)=>`${x}:${z}`;
const integer=(v:number)=>Number.isSafeInteger(v);
type CutBox={x0:number;x1:number;y0:number;y1:number;z0:number;z1:number};
function frozen<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}
export class VoxelField {
  readonly bounds:Readonly<VoxelBounds>;
  readonly chunkSize:number;
  private columns=new Map<string,(number|undefined)[]>();
  private edits=new Map<string,Map<number,number>>();
  private editKey='';
  private serial=0;
  private chunkVersions=new Map<string,number>();
  private columnVersions=new Map<string,number>();
  private colliderChunks=new Map<string,PhysicsCollider[]>();
  private colliderOwners=new Map<string,Uint16Array>();
  private cutPlans=new Map<string,{points:Set<string>;pieces:CutBox[]}>();
  private pieceColliders=new WeakMap<CutBox,{id:string;collider:PhysicsCollider}>();
  private placedColliders=new Map<string,PhysicsCollider>();
  private importedCollision=false;
  private importedOwners=new Map<string,PhysicsCollider|null>();
  private collisionCache:{revision:number;value:{remove:PhysicsCollider[];add:PhysicsCollider[]}}|undefined;
  private warming=new Map<string,Generator<void,PhysicsCollider[]>>();
  private readonly options:VoxelFieldOptions;
  constructor(options:VoxelFieldOptions){
    this.options=options;
    const b={...options.bounds};
    if(!Object.values(b).every(integer)||b.minX>=b.maxX||b.minY>=b.maxY||b.minZ>=b.maxZ
      ||Math.max(...Object.values(b).map(Math.abs))>9000||b.maxY-b.minY>128)throw new Error('Invalid bounded voxel field.');
    this.chunkSize=options.chunkSize??32;
    if(!integer(this.chunkSize)||this.chunkSize<4||this.chunkSize>32)throw new Error('Voxel chunks require 4..32 cells.');
    if(options.maxCachedColumns!==undefined&&(!integer(options.maxCachedColumns)||options.maxCachedColumns<64||options.maxCachedColumns>65536))throw new Error('Invalid voxel column cache budget.');
    this.bounds=Object.freeze(b);
  }
  get revision():number{return this.serial;}
  chunkRevision(cx:number,cz:number):number{return this.chunkVersions.get(key(cx,cz))??0;}
  inside(x:number,y:number,z:number):boolean{const b=this.bounds;return x>=b.minX&&x<b.maxX&&y>=b.minY&&y<b.maxY&&z>=b.minZ&&z<b.maxZ;}
  solid(material:number):boolean{return this.options.solid?.(material)??material!==0;}
  baseColumn(x:number,z:number):readonly number[]{
    if(!integer(x)||!integer(z))throw new Error('Voxel columns require integer coordinates.');
    const out=this.column(x,z);
    for(let y=this.bounds.minY;y<this.bounds.maxY;y++){
      const i=y-this.bounds.minY;if(out[i]===undefined)out[i]=this.sample(x,y,z);
    }
    return Object.freeze(out) as readonly number[];
  }
  private column(x:number,z:number):(number|undefined)[]{
    const k=key(x,z),cached=this.columns.get(k);if(cached)return cached;
    const out:(number|undefined)[]=new Array(this.bounds.maxY-this.bounds.minY);
    // A normal 3x3 visible horizon already needs 9216 columns plus seam samples.
    // Keep it resident instead of thrashing an 8192-column cache on every pass.
    if(this.columns.size>=(this.options.maxCachedColumns??32768))this.columns.delete(this.columns.keys().next().value!);
    this.columns.set(k,out);return out;
  }
  private sample(x:number,y:number,z:number):number{
    const m=this.inside(x,y,z)?this.options.sample(x,y,z):0;
    if(!integer(m)||m<0||m>255)throw new Error('Voxel generators return material IDs 0..255.');return m;
  }
  get(x:number,y:number,z:number,base=false):number{
    if(![x,y,z].every(integer))throw new Error('Voxel queries require integer coordinates.');
    if(!this.inside(x,y,z))return 0;
    const edited=!base?this.edits.get(key(x,z))?.get(y):undefined;if(edited!==undefined)return edited;
    const column=this.column(x,z),i=y-this.bounds.minY;
    return column[i]??(column[i]=this.sample(x,y,z));
  }
  /** Copy complete sparse state. Last duplicate wins, independent of cache residency. */
  setEdits(edits:readonly VoxelEdit[]):boolean{
    if(edits.length>256)throw new Error('Voxel edits exceed the 256-entry declared-state budget.');
    const next=new Map<string,Map<number,number>>();
    for(const e of edits){if(![e.x,e.y,e.z,e.material].every(integer)||!this.inside(e.x,e.y,e.z)||e.material<0||e.material>255)throw new Error('Invalid voxel edit.');
      const k=key(e.x,e.z);let c=next.get(k);if(!c){c=new Map();next.set(k,c);}c.set(e.y,e.material);}
    const signature=JSON.stringify([...next].sort().map(([k,c])=>[k,[...c].sort((a,b)=>a[0]-b[0])]));
    if(signature===this.editKey)return false;
    const changed=new Set([...this.edits.keys(),...next.keys()].filter(k=>{
      const a=this.edits.get(k),b=next.get(k);return a?.size!==b?.size||!!a&&[...a].some(([y,m])=>b?.get(y)!==m);
    }));
    this.edits=next;this.editKey=signature;this.serial++;
    for(const k of changed){const [x,z]=k.split(':').map(Number);for(const [dx,dz] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]){
      this.columnVersions.set(key(x+dx,z+dz),this.serial);
      this.chunkVersions.set(key(Math.floor((x+dx)/this.chunkSize),Math.floor((z+dz)/this.chunkSize)),this.serial);
    }}
    return true;
  }
  /** One native box per contiguous solid run, irrespective of material changes.
   * Rendering and Rapier use the exact same integer cell boundaries. */
  columnColliders(x:number,z:number,base=false):PhysicsCollider[]{
    const result:PhysicsCollider[]=[];
    for(let y=this.bounds.minY;y<this.bounds.maxY;){
      if(!this.solid(this.get(x,y,z,base))){y++;continue;}
      const bottom=y++;while(y<this.bounds.maxY&&this.solid(this.get(x,y,z,base)))y++;
      result.push({id:`voxel:${x}:${z}:${bottom}:${y}`,shape:{kind:'box',halfExtents:{x:.5,y:(y-bottom)/2,z:.5}},position:{x:x+.5,y:(bottom+y)/2,z:z+.5}});
    }return result;
  }
  chunkColliders(cx:number,cz:number,base=true):PhysicsCollider[]{
    const cacheKey=`${cx}:${cz}:${base?'base':this.chunkRevision(cx,cz)}`,cached=this.colliderChunks.get(cacheKey);if(cached)return cached;
    const work=(base?this.warming.get(cacheKey):undefined)??this.colliderSteps(cx,cz,base);
    let result=work.next();while(!result.done)result=work.next();
    this.warming.delete(cacheKey);this.cacheColliders(cacheKey,result.value);return result.value;
  }
  private cacheColliders(cacheKey:string,out:PhysicsCollider[]):void{
    if(this.colliderChunks.size>=256){const oldest=this.colliderChunks.keys().next().value!;this.colliderChunks.delete(oldest);this.colliderOwners.delete(oldest);}this.colliderChunks.set(cacheKey,frozen(out));
  }
  private *colliderSteps(cx:number,cz:number,base=true):Generator<void,PhysicsCollider[]>{
    const size=this.chunkSize;
    const levels=this.bounds.maxY-this.bounds.minY,plane=size*size,cells=new Uint8Array(plane*levels),owners=base?new Uint16Array(plane*levels):undefined,out:PhysicsCollider[]=[];
    for(let x=0;x<size;x++)for(let z=0;z<size;z++){
      for(let y=0;y<levels;y++)if(this.solid(this.get(cx*size+x,y+this.bounds.minY,cz*size+z,base)))cells[y*plane+x*size+z]=1;
      yield;
    }
    // Greedy solid cuboids, including shared lower strata beneath columns of
    // different heights. No box bridges an air cell or fills a cave.
    for(let y=0;y<levels;y++){
     for(let x=0;x<size;x++)for(let z=0;z<size;z++)if(cells[y*plane+x*size+z]){
      let width=1;while(x+width<size&&cells[y*plane+(x+width)*size+z])width++;
      let depth=1;row:while(z+depth<size){for(let a=0;a<width;a++)if(!cells[y*plane+(x+a)*size+z+depth])break row;depth++;}
      let height=1;level:while(y+height<levels){for(let a=0;a<width;a++)for(let b=0;b<depth;b++)if(!cells[(y+height)*plane+(x+a)*size+z+b])break level;height++;}
      if(out.length>=65535)throw new Error('Voxel chunk exceeds its solid ownership budget.');
      for(let c=0;c<height;c++)for(let a=0;a<width;a++){const offset=(y+c)*plane+(x+a)*size+z;cells.fill(0,offset,offset+depth);owners?.fill(out.length+1,offset,offset+depth);}
      out.push({id:`voxel:${cx}:${cz}:${x}:${y}:${z}:${width}:${height}:${depth}`,shape:{kind:'box',halfExtents:{x:width/2,y:height/2,z:depth/2}},position:{x:cx*size+x+width/2,y:this.bounds.minY+y+height/2,z:cz*size+z+depth/2}});
     }yield;
    }if(owners)this.colliderOwners.set(`${cx}:${cz}:base`,owners);return out;
  }
  /** One bounded generation slice for the ordinary terrain preparation worker. */
  chunkPrepared(cx:number,cz:number):boolean{return this.colliderChunks.has(`${cx}:${cz}:base`);}
  importCollisionChunk(cx:number,cz:number,colliders:PhysicsCollider[]):void{
    if(!integer(cx)||!integer(cz)||!Array.isArray(colliders)||colliders.length>12800)throw new Error('Invalid voxel collision source.');
    const size=this.chunkSize;
    for(const c of colliders){
      if(c.shape?.kind!=='box'||!c.id?.startsWith(`voxel:${cx}:${cz}:`))throw new Error('Voxel source chunk identity differs.');
      const p=c.position,h=c.shape.halfExtents;
      for(const [v,low,high] of [[p.x-h.x,cx*size,(cx+1)*size],[p.x+h.x,cx*size,(cx+1)*size],[p.z-h.z,cz*size,(cz+1)*size],[p.z+h.z,cz*size,(cz+1)*size],[p.y-h.y,this.bounds.minY,this.bounds.maxY],[p.y+h.y,this.bounds.minY,this.bounds.maxY]])
        if(!integer(v)||v<low||v>high)throw new Error('Voxel source solid leaves its cell bounds.');
      if(h.x<=0||h.y<=0||h.z<=0)throw new Error('Voxel source solid is empty.');
    }
    this.importedCollision=true;this.cacheColliders(`${cx}:${cz}:base`,colliders);this.collisionCache=undefined;this.importedOwners.clear();
  }
  private sourceSolid(x:number,y:number,z:number):PhysicsCollider|undefined{
    const key=`${x}:${y}:${z}`;
    if(this.importedOwners.has(key))return this.importedOwners.get(key)??undefined;
    const cx=Math.floor(x/this.chunkSize),cz=Math.floor(z/this.chunkSize),chunk=this.colliderChunks.get(`${cx}:${cz}:base`);
    const result=chunk?.find(c=>{if(c.shape.kind!=='box')return false;const p=c.position,h=c.shape.halfExtents;return x+.5>=p.x-h.x&&x+.5<p.x+h.x&&y+.5>=p.y-h.y&&y+.5<p.y+h.y&&z+.5>=p.z-h.z&&z+.5<p.z+h.z;});
    if(this.importedOwners.size>=2048)this.importedOwners.delete(this.importedOwners.keys().next().value!);
    this.importedOwners.set(key,result??null);return result;
  }
  prepareChunk(cx:number,cz:number,columns=128):boolean{
    const k=`${cx}:${cz}:base`;if(this.colliderChunks.has(k))return true;
    let work=this.warming.get(k);
    if(!work){if(this.warming.size>=128)this.warming.delete(this.warming.keys().next().value!);work=this.colliderSteps(cx,cz);this.warming.set(k,work);}
    for(let i=0;i<columns;i++){const result=work.next();if(result.done){this.cacheColliders(k,result.value);this.warming.delete(k);return true;}}
    return false;
  }
  /** Feed to createTerrainWorld.options.collisionEdits. Subtracts edited cells
   * from original native cuboids without regenerating unaffected geometry. */
  collisionEdits():{remove:PhysicsCollider[];add:PhysicsCollider[]}{
    if(this.collisionCache?.revision===this.serial)return this.collisionCache.value;
    const remove:PhysicsCollider[]=[],add:PhysicsCollider[]=[],cuts=new Map<PhysicsCollider,PhysicsVector[]>(),placed=new Map<string,PhysicsCollider>();
    for(const k of [...this.edits.keys()].sort()){const [x,z]=k.split(':').map(Number);
      for(const [y,m] of [...this.edits.get(k)!].sort((a,b)=>a[0]-b[0])){
        if(this.importedCollision&&!this.chunkPrepared(Math.floor(x/this.chunkSize),Math.floor(z/this.chunkSize)))continue;
        const source=this.importedCollision?this.sourceSolid(x,y,z):undefined;
        const old=this.importedCollision?!!source:this.solid(this.get(x,y,z,true)),solid=this.solid(m);if(old===solid)continue;
        if(solid){const id=`voxel-edit:${x}:${y}:${z}`,collider=this.placedColliders.get(id)??{id,shape:{kind:'box' as const,halfExtents:{x:.5,y:.5,z:.5}},position:{x:x+.5,y:y+.5,z:z+.5}};placed.set(id,collider);add.push(collider);continue;}
        const cx=Math.floor(x/this.chunkSize),cz=Math.floor(z/this.chunkSize),size=this.chunkSize,chunk=this.chunkColliders(cx,cz);
        const index=(y-this.bounds.minY)*size*size+(x-cx*size)*size+z-cz*size;
        const collider=source??chunk[this.colliderOwners.get(`${cx}:${cz}:base`)![index]-1];
        if(!collider)throw new Error('Voxel edit lacks its original native solid.');
        const list=cuts.get(collider)??[];list.push({x,y,z});cuts.set(collider,list);
      }
    }
    const nextPlans:typeof this.cutPlans=new Map();
    for(const [c,points] of cuts){if(c.shape.kind!=='box')throw new Error('Voxel solid must be a box.');remove.push(c);
      const h=c.shape.halfExtents,p=c.position;
      const pointKey=({x,y,z}:PhysicsVector)=>`${x}:${y}:${z}`,wanted=new Set(points.map(pointKey)),old=this.cutPlans.get(c.id!);
      // Only extend an exact canonical prefix. Different edit arrival histories
      // must produce identical native descriptors and transfer revisions.
      const reuse=old&&old.points.size<=points.length&&[...old.points].every((point,index)=>point===pointKey(points[index]));
      let pieces=reuse?old.pieces:[{x0:p.x-h.x,x1:p.x+h.x,y0:p.y-h.y,y1:p.y+h.y,z0:p.z-h.z,z1:p.z+h.z}];
      for(const {x,y,z} of reuse?points.slice(old.points.size):points){const next:typeof pieces=[];
        for(const b of pieces){if(x<b.x0||x>=b.x1||y<b.y0||y>=b.y1||z<b.z0||z>=b.z1){next.push(b);continue;}
          const push=(v:typeof b)=>{if(v.x1>v.x0&&v.y1>v.y0&&v.z1>v.z0)next.push(v);};
          push({...b,x1:x});push({...b,x0:x+1});
          push({...b,x0:x,x1:x+1,y1:y});push({...b,x0:x,x1:x+1,y0:y+1});
          push({x0:x,x1:x+1,y0:y,y1:y+1,z0:b.z0,z1:z});push({x0:x,x1:x+1,y0:y,y1:y+1,z0:z+1,z1:b.z1});
        }pieces=next;
      }
      nextPlans.set(c.id!,{points:wanted,pieces});
      pieces.forEach((b,i)=>{const id=c.id+':cut:'+i,old=this.pieceColliders.get(b);
        const collider=old?.id===id?old.collider:{id,shape:{kind:'box' as const,halfExtents:{x:(b.x1-b.x0)/2,y:(b.y1-b.y0)/2,z:(b.z1-b.z0)/2}},position:{x:(b.x1+b.x0)/2,y:(b.y1+b.y0)/2,z:(b.z1+b.z0)/2}};
        this.pieceColliders.set(b,{id,collider});add.push(collider);});
    }
    if(remove.length>512||add.length>512)throw new Error('Voxel edit collision budget exceeded; keep fewer independently changed columns.');
    this.cutPlans=nextPlans;this.placedColliders=placed;const value=frozen({remove,add});this.collisionCache={revision:this.serial,value};return value;
  }
  /** Bounded admission in a live tick. Split only affected cached cuboids;
   * native scene installation remains preparation work outside live ticks. */
  assertEditBudget():void{
    const chunks=new Set([...this.edits.keys()].map(k=>{const [x,z]=k.split(':').map(Number);return key(Math.floor(x/this.chunkSize),Math.floor(z/this.chunkSize));}));
    for(const k of chunks){const [x,z]=k.split(':').map(Number);if(!this.colliderChunks.has(`${x}:${z}:base`))throw new Error('Prepare voxel collision before editing this chunk.');}
    this.collisionEdits();
  }
  surfaceHeight(x:number,z:number):number{
    x=Math.floor(x);z=Math.floor(z);
    for(let y=this.bounds.maxY-1;y>=this.bounds.minY;y--)if(this.solid(this.get(x,y,z)))return y+1;
    return this.bounds.minY;
  }
  /** Exact grid DDA, including negative coordinates and rays starting in solids. */
  raycast(origin:PhysicsVector,direction:PhysicsVector,distance=6):VoxelRayHit|null{
    const length=Math.hypot(direction.x,direction.y,direction.z);
    if(!Object.values(origin).every(Number.isFinite)||!Number.isFinite(length)||length===0||!Number.isFinite(distance)||distance<0||distance>128)throw new Error('Invalid voxel ray.');
    const d={x:direction.x/length,y:direction.y/length,z:direction.z/length},p={x:Math.floor(origin.x),y:Math.floor(origin.y),z:Math.floor(origin.z)};
    let previous={...p},normal={x:0,y:0,z:0},t=0;
    const axes=['x','y','z'] as const,step={x:Math.sign(d.x),y:Math.sign(d.y),z:Math.sign(d.z)};
    const delta={x:d.x?Math.abs(1/d.x):Infinity,y:d.y?Math.abs(1/d.y):Infinity,z:d.z?Math.abs(1/d.z):Infinity};
    const next={x:0,y:0,z:0};for(const a of axes)next[a]=d[a]?(p[a]+(d[a]>0?1:0)-origin[a])/d[a]:Infinity;
    for(let count=0;count<512&&t<=distance;count++){
      const m=this.get(p.x,p.y,p.z);if(this.solid(m))return{block:{...p},previous,normal,material:m,distance:t};
      const a=next.x<=next.y&&next.x<=next.z?'x':next.y<=next.z?'y':'z';
      previous={...p};t=next[a];p[a]+=step[a];next[a]+=delta[a];normal={x:0,y:0,z:0};normal[a]=-step[a];
    }return null;
  }
  /** Culled faces, including neighbor queries across seams. Material IDs are
   * per quad; UVs span one block. No hidden interior cubes are drawn. */
  surface(cx:number,cz:number):VoxelSurface{
    const work=this.surfaceSteps(cx,cz);let result=work.next();while(!result.done)result=work.next();return result.value;
  }
  /** Render workers may yield after each column and retain the previous mesh
   * until this complete, revision-matched surface is ready to swap atomically. */
  *surfaceSteps(cx:number,cz:number,cache?:VoxelSurfaceCache,yieldCached=false):Generator<void,VoxelSurface>{
    if(cache&&surfaceCacheOwners.get(cache)!==this){cache.clear();surfaceCacheOwners.set(cache,this);}
    const out:VoxelSurface={positions:[],normals:[],uvs:[],materials:[]};
    for(let x=cx*this.chunkSize;x<(cx+1)*this.chunkSize;x++)for(let z=cz*this.chunkSize;z<(cz+1)*this.chunkSize;z++){
      const k=key(x,z),revision=this.columnVersions.get(k)??0;let column=cache?.get(k);
      const fresh=!column||column.revision!==revision;
      if(fresh){column={revision,surface:this.surfaceColumn(x,z)};cache?.set(k,column);}
      const data=column!.surface;
      out.positions.push(...data.positions);out.normals.push(...data.normals);out.uvs.push(...data.uvs);out.materials.push(...data.materials);
      if(fresh||yieldCached&&((x-cx*this.chunkSize)*this.chunkSize+z-cz*this.chunkSize)%64===63)yield;
    }return out;
  }
  private surfaceColumn(x:number,z:number):VoxelSurface{
    const out:VoxelSurface={positions:[],normals:[],uvs:[],materials:[]};
    for(let y=this.bounds.minY;y<this.bounds.maxY;y++){
      const material=this.get(x,y,z);if(!material)continue;
      for(const {n,u,v} of surfaceFaces){const other=this.get(x+n[0],y+n[1],z+n[2]);if(other&&(this.solid(other)||other===material))continue;
        const p=[x+(n[0]>0?1:0),y+(n[1]>0?1:0),z+(n[2]>0?1:0)];
        for(const [a,b] of surfaceCorners){for(let i=0;i<3;i++)out.positions.push(p[i]+u[i]*a+v[i]*b);out.normals.push(...n);out.uvs.push(a,b);}
        out.materials.push(material);
      }
    }return out;
  }
  inspection(){return{surface:'voxel-cells',bounds:this.bounds,chunkSize:this.chunkSize,cachedColumns:this.columns.size,changedColumns:this.edits.size,revision:this.serial};}
}
