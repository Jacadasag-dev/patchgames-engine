import {DataTexture,FloatType,NearestFilter,NoColorSpace,RGBAFormat} from 'three';
import {planetAtmosphereSnapshotAlpha,samplePlanetAtmosphereSnapshots,validatePlanetAtmospherePair,type PlanetAtmosphereRenderColumn,type PlanetAtmosphereSnapshot,type PlanetAtmosphereSnapshotIdentity} from '../shared/planetAtmosphereSnapshot.ts';
import type {PlanetVector} from '../shared/planet.ts';

const names=['condensate','materialLower','materialUpper','cloudAltitudeMoments'] as const;
type Pair={previous:PlanetAtmosphereSnapshot;current:PlanetAtmosphereSnapshot};
type Bank={planes:DataTexture[];snapshot?:PlanetAtmosphereSnapshot};
type Pending=Pair&{previousBank:Bank;currentBank:Bank;jobs:{bank:Bank;plane:number;snapshot:PlanetAtmosphereSnapshot}[]};
const same=(a:PlanetAtmosphereSnapshot|undefined,b:PlanetAtmosphereSnapshot)=>a?.epoch===b.epoch&&a.sequence===b.sequence&&a.revision===b.revision&&a.planetRevision===b.planetRevision;
const texture=()=>{const result=new DataTexture(new Float32Array(4),1,1,RGBAFormat,FloatType);result.minFilter=result.magFilter=NearestFilter;result.generateMipmaps=false;result.colorSpace=NoColorSpace;result.unpackAlignment=1;result.needsUpdate=true;return result;};

/** Four fixed texture banks: two rendered endpoints and at most two staged
 * endpoints. Exactly one RGBA32F plane uploads per call; complete pairs become
 * visible atomically. Upload errors keep the last valid pair. */
export class PlanetAtmosphereSnapshotBuffer {
  private readonly banks:Bank[]=Array.from({length:4},()=>({planes:names.map(()=>texture())}));
  readonly textures={condensate0:this.banks[0].planes[0],condensate1:this.banks[1].planes[0],materialLower0:this.banks[0].planes[1],materialLower1:this.banks[1].planes[1],materialUpper0:this.banks[0].planes[2],materialUpper1:this.banks[1].planes[2],cloudAltitudeMoments0:this.banks[0].planes[3],cloudAltitudeMoments1:this.banks[1].planes[3]};
  private enabled=false;private disposed=false;private active?:Pending;private pending?:Pending;private queued?:Pair;private accepted?:PlanetAtmosphereSnapshot;private error='';private uploads=0;
  private readonly expected:PlanetAtmosphereSnapshotIdentity;
  constructor(expected:PlanetAtmosphereSnapshotIdentity){this.expected=expected;}
  setAtmosphereHeightMeters(height:number):void {
    if(this.disposed)throw Error('Atmosphere snapshot buffer is disposed.');
    if(!Number.isFinite(height)||height<=0||height>this.expected.radiusMeters*.1)throw Error('Atmosphere height must be finite, positive and bounded by the planet radius.');
    if(this.enabled&&this.expected.atmosphereHeightMeters!==undefined&&height!==this.expected.atmosphereHeightMeters)throw Error('Physical atmosphere height changed; create a replacement sky view and simulation session.');
    this.expected.atmosphereHeightMeters=height;
  }
  enable():void {if(this.disposed)throw Error('Atmosphere snapshot buffer is disposed.');this.enabled=true;}
  set(previous:PlanetAtmosphereSnapshot,current:PlanetAtmosphereSnapshot=previous):boolean {
    if(this.disposed)throw Error('Atmosphere snapshot buffer is disposed.');
    validatePlanetAtmospherePair(previous,current,this.expected);
    const last=this.accepted;
    if(last&&(current.epoch<last.epoch||current.epoch===last.epoch&&(current.sequence<last.sequence||current.timeSeconds<last.timeSeconds)))throw Error('Stale atmosphere snapshot sequence, epoch or time.');
    if(last&&current.epoch===last.epoch&&current.revision!==last.revision)throw Error('Atmosphere parameter revision changed without a new epoch.');
    if(last&&current.epoch===last.epoch&&(current.width!==last.width||current.height!==last.height))throw Error('Atmosphere grid changed without a new epoch.');
    if(last&&current.epoch===last.epoch&&current.atmosphereHeightMeters!==last.atmosphereHeightMeters)throw Error('Atmosphere height changed without a new epoch.');
    if(last&&same(last,current))return false;
    this.enabled=true;this.accepted=current;this.error='';this.queued={previous,current};return true;
  }
  private begin():void {
    if(this.pending||!this.queued)return;
    const pair=this.queued;this.queued=undefined;const reserved=new Set<Bank>();
    const choose=(snapshot:PlanetAtmosphereSnapshot)=>{
      let bank=this.banks.find(candidate=>same(candidate.snapshot,snapshot));
      if(!bank)bank=this.banks.find(candidate=>!reserved.has(candidate)&&candidate!==this.active?.previousBank&&candidate!==this.active?.currentBank);
      if(!bank)throw Error('Atmosphere snapshot staging bank exhausted.');reserved.add(bank);return bank;
    };
    const previousBank=choose(pair.previous),currentBank=same(pair.previous,pair.current)?previousBank:choose(pair.current),jobs:Pending['jobs']=[];
    for(const [bank,snapshot]of [[previousBank,pair.previous],[currentBank,pair.current]] as const){if(same(bank.snapshot,snapshot)||jobs.some(job=>job.bank===bank))continue;for(let plane=0;plane<names.length;plane++)jobs.push({bank,plane,snapshot});}
    this.pending={...pair,previousBank,currentBank,jobs};
  }
  uploadNext(renderer:{initTexture(texture:DataTexture):void}):boolean {
    if(!this.enabled||this.disposed)return false;
    try{
      this.begin();const pending=this.pending;if(!pending)return false;
      const job=pending.jobs.shift();
      if(job){const source=job.snapshot,plane=job.bank.planes[job.plane];job.bank.snapshot=undefined;
        // Three does not resize an uploaded DataTexture allocation when only
        // image dimensions change. Release that allocation first; the stable
        // TextureNode/uniform rebinds the recreated resource without compiling.
        if(plane.image.width!==source.width||plane.image.height!==source.height)plane.dispose();
        plane.image={data:source[names[job.plane]],width:source.width,height:source.height};plane.needsUpdate=true;renderer.initTexture(plane);this.uploads++;if(!pending.jobs.some(next=>next.bank===job.bank))job.bank.snapshot=source;}
      if(pending.jobs.length)return false;
      this.active=pending;this.pending=undefined;
      const a=pending.previousBank.planes,b=pending.currentBank.planes;
      Object.assign(this.textures,{condensate0:a[0],condensate1:b[0],materialLower0:a[1],materialLower1:b[1],materialUpper0:a[2],materialUpper1:b[2],cloudAltitudeMoments0:a[3],cloudAltitudeMoments1:b[3]});return true;
    }catch(error){this.error=(error instanceof Error?error.message:String(error)).slice(0,1000);this.pending=undefined;this.queued=undefined;return false;}
  }
  frame(timeSeconds:number){
    if(!Number.isFinite(timeSeconds))throw Error('Atmosphere render time must be finite.');
    const active=this.active;
    const cloudBoundsMeters:[number,number,number,number]=[0,0,0,0];
    if(active)for(const offset of [0,2]){
      const a=active.previous.cloudBoundsMeters,b=active.current.cloudBoundsMeters,liveA=a[offset+1]>a[offset],liveB=b[offset+1]>b[offset];
      if(liveA||liveB){cloudBoundsMeters[offset]=Math.min(liveA?a[offset]:Infinity,liveB?b[offset]:Infinity);cloudBoundsMeters[offset+1]=Math.max(liveA?a[offset+1]:0,liveB?b[offset+1]:0);}
    }
    return {enabled:this.enabled,active:!!active,alpha:active?planetAtmosphereSnapshotAlpha(active.previous,active.current,timeSeconds):0,timeSeconds:active?Math.max(active.previous.timeSeconds,Math.min(active.current.timeSeconds,timeSeconds)):0,cloudBoundsMeters,atmosphereHeightMeters:active?.current.atmosphereHeightMeters??null};
  }
  sample(direction:PlanetVector,timeSeconds:number):PlanetAtmosphereRenderColumn|undefined {
    const active=this.active;
    return active?samplePlanetAtmosphereSnapshots(active.previous,active.current,timeSeconds,direction):undefined;
  }
  inspection(){const active=this.active,pending=this.pending??this.queued;return {enabled:this.enabled,active:!!active,staging:!!pending,epoch:active?.current.epoch??null,sequence:active?.current.sequence??null,revision:active?.current.revision??null,fromTime:active?.previous.timeSeconds??null,toTime:active?.current.timeSeconds??null,cloudBoundsMeters:active?this.frame(active.current.timeSeconds).cloudBoundsMeters:null,atmosphereHeightMeters:active?.current.atmosphereHeightMeters??null,pendingSequence:pending?.current.sequence??null,pendingPlanes:this.pending?.jobs.length??0,uploads:this.uploads,error:this.error,estimatedTextureBytes:this.banks.reduce((sum,bank)=>sum+bank.planes.reduce((bytes,plane)=>bytes+plane.image.width*plane.image.height*16,0),0)};}
  clear():void {this.enabled=false;this.active=this.pending=this.queued=this.accepted=undefined;this.error='';}
  dispose():void {if(this.disposed)return;this.clear();this.disposed=true;for(const bank of this.banks)for(const plane of bank.planes)plane.dispose();}
}
