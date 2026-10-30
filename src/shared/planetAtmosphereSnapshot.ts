import type {PlanetVector} from './planet.ts';

/** Immutable render transfer from a persistent atmosphere solver. Coordinates
 * are body-fixed; longitude wraps and latitude runs south to north. Masses are
 * column kg/m², not artist coverage/opacity controls. */
export interface PlanetAtmosphereSnapshot {
  kind:'planet-atmosphere-snapshot';version:1;
  revision:string;planetRevision:string;epoch:number;sequence:number;timeSeconds:number;radiusMeters:number;
  width:number;height:number;
  /** RGBA: liquid lower, liquid upper, ice upper, airborne dust, all kg/m². */
  condensate:Float32Array;
  /** RGB: advected unit Cartesian material label; A: lower ice kg/m². */
  materialLower:Float32Array;
  /** RGB: upper material label; A: reserved zero. */
  materialUpper:Float32Array;
}
export interface PlanetAtmosphereSnapshotIdentity {radiusMeters:number;planetRevision?:string}
export const PLANET_ATMOSPHERE_SNAPSHOT_LIMITS=Object.freeze({maxWidth:512,maxMassKgM2:1000,maxBytes:512*256*4*4*3,maxTimeSeconds:1e12});
export const PLANET_ATMOSPHERE_OPTICS=Object.freeze({
  // Geometric-optics Qext=2: 3 Qext/(4 density effectiveRadius).
  liquidExtinctionM2Kg:150,iceExtinctionM2Kg:65.43,dustExtinctionM2Kg:600,
  dustScatteringAlbedo:[.90,.72,.48] as PlanetVector,
});
export interface PlanetAtmosphereColumnMass {liquidLowerKgM2:number;liquidUpperKgM2:number;iceLowerKgM2:number;iceUpperKgM2:number;dustKgM2:number;materialLower:PlanetVector;materialUpper:PlanetVector}
const identity=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=160;
export function validatePlanetAtmosphereSnapshot(snapshot:PlanetAtmosphereSnapshot,expected?:PlanetAtmosphereSnapshotIdentity):PlanetAtmosphereSnapshot {
  if(!snapshot||snapshot.kind!=='planet-atmosphere-snapshot'||snapshot.version!==1||!identity(snapshot.revision)||!identity(snapshot.planetRevision)
    ||!Number.isSafeInteger(snapshot.epoch)||snapshot.epoch<0||!Number.isSafeInteger(snapshot.sequence)||snapshot.sequence<0
    ||!Number.isFinite(snapshot.timeSeconds)||snapshot.timeSeconds<0||snapshot.timeSeconds>PLANET_ATMOSPHERE_SNAPSHOT_LIMITS.maxTimeSeconds
    ||!Number.isFinite(snapshot.radiusMeters)||snapshot.radiusMeters<1000||snapshot.radiusMeters>100_000_000
    ||![64,128,256,512].includes(snapshot.width)||snapshot.height!==snapshot.width/2)throw Error('Invalid atmosphere snapshot header or bounded grid.');
  if(expected&&(snapshot.radiusMeters!==expected.radiusMeters||expected.planetRevision!==undefined&&snapshot.planetRevision!==expected.planetRevision))throw Error('Atmosphere snapshot belongs to another planet.');
  const length=snapshot.width*snapshot.height*4;
  for(const plane of [snapshot.condensate,snapshot.materialLower,snapshot.materialUpper])if(!(plane instanceof Float32Array)||plane.length!==length)throw Error('Atmosphere snapshot planes must be complete bounded RGBA32F arrays.');
  for(let offset=0;offset<length;offset+=4){
    for(let channel=0;channel<4;channel++){const mass=snapshot.condensate[offset+channel];if(!Number.isFinite(mass)||mass<0||mass>1000)throw Error('Atmosphere snapshot contains invalid column mass.');}
    for(const plane of [snapshot.materialLower,snapshot.materialUpper])for(let channel=0;channel<3;channel++)if(!Number.isFinite(plane[offset+channel])||Math.abs(plane[offset+channel])>1.01)throw Error('Atmosphere snapshot contains invalid material labels.');
    const lowerIce=snapshot.materialLower[offset+3];if(!Number.isFinite(lowerIce)||lowerIce<0||lowerIce>1000||snapshot.materialUpper[offset+3]!==0)throw Error('Atmosphere snapshot contains invalid lower ice or reserved data.');
    for(const [plane,mass]of [[snapshot.materialLower,snapshot.condensate[offset]+lowerIce],[snapshot.materialUpper,snapshot.condensate[offset+1]+snapshot.condensate[offset+2]]] as const){
      const norm=Math.hypot(plane[offset],plane[offset+1],plane[offset+2]);if(mass>0&&(norm<.5||norm>1.5))throw Error('Occupied atmosphere columns require nonzero material labels.');
    }
  }
  return snapshot;
}
export function validatePlanetAtmospherePair(previous:PlanetAtmosphereSnapshot,current:PlanetAtmosphereSnapshot,expected?:PlanetAtmosphereSnapshotIdentity):void {
  validatePlanetAtmosphereSnapshot(previous,expected);if(current!==previous)validatePlanetAtmosphereSnapshot(current,expected);
  for(const key of ['revision','planetRevision','epoch','radiusMeters','width','height'] as const)if(previous[key]!==current[key])throw Error('Atmosphere snapshot pair has mismatched identity or grid.');
  if(previous.sequence>current.sequence||previous.timeSeconds>current.timeSeconds||previous.sequence===current.sequence&&previous.timeSeconds!==current.timeSeconds)throw Error('Atmosphere snapshot pair has reversed sequence or time.');
}
export function planetAtmosphereSnapshotAlpha(previous:PlanetAtmosphereSnapshot,current:PlanetAtmosphereSnapshot,timeSeconds:number):number {
  if(!Number.isFinite(timeSeconds))throw Error('Atmosphere render time must be finite.');
  return current.timeSeconds<=previous.timeSeconds?0:Math.max(0,Math.min(1,(timeSeconds-previous.timeSeconds)/(current.timeSeconds-previous.timeSeconds)));
}
/** CPU reference for the shaders' explicit bilinear RGBA32F loads. There is no
 * optional float32 filtering feature or longitude-seam interpolation shortcut. */
export function samplePlanetAtmosphereSnapshots(previous:PlanetAtmosphereSnapshot,current:PlanetAtmosphereSnapshot,timeSeconds:number,direction:PlanetVector):PlanetAtmosphereColumnMass {
  const length=Math.hypot(...direction);if(!Number.isFinite(length)||length<1e-12)throw Error('Atmosphere sampling needs a finite nonzero direction.');
  const d=direction.map(value=>value/length),u=Math.atan2(d[0],d[2])/(Math.PI*2)+.5,v=Math.asin(Math.max(-1,Math.min(1,d[1])))/Math.PI+.5,alpha=planetAtmosphereSnapshotAlpha(previous,current,timeSeconds);
  const read=(snapshot:PlanetAtmosphereSnapshot,plane:Float32Array)=>{
    const px=u*snapshot.width-.5,py=v*snapshot.height-.5,x=Math.floor(px),y=Math.floor(py),fx=px-x,fy=py-y,result=[0,0,0,0];
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const xx=((x+dx)%snapshot.width+snapshot.width)%snapshot.width,yy=Math.max(0,Math.min(snapshot.height-1,y+dy)),offset=(yy*snapshot.width+xx)*4,weight=(dx?fx:1-fx)*(dy?fy:1-fy);for(let channel=0;channel<4;channel++)result[channel]+=plane[offset+channel]*weight;}return result;
  };
  const mix=(a:readonly number[],b:readonly number[])=>a.map((value,index)=>value*(1-alpha)+b[index]*alpha);
  const unit=(value:readonly number[])=>{const norm=Math.hypot(value[0],value[1],value[2]);return norm>1e-4?[value[0]/norm,value[1]/norm,value[2]/norm]:d;};
  const mass=mix(read(previous,previous.condensate),read(current,current.condensate)),a=read(previous,previous.materialLower),b=read(current,current.materialLower),c=read(previous,previous.materialUpper),e=read(current,current.materialUpper);
  return {liquidLowerKgM2:mass[0],liquidUpperKgM2:mass[1],iceUpperKgM2:mass[2],dustKgM2:mass[3],iceLowerKgM2:a[3]*(1-alpha)+b[3]*alpha,materialLower:unit(mix(unit(a),unit(b))) as unknown as PlanetVector,materialUpper:unit(mix(unit(c),unit(e))) as unknown as PlanetVector};
}
export function planetAtmosphereColumnOpticalDepth(mass:PlanetAtmosphereColumnMass){const o=PLANET_ATMOSPHERE_OPTICS;return {lowerCloud:mass.liquidLowerKgM2*o.liquidExtinctionM2Kg+mass.iceLowerKgM2*o.iceExtinctionM2Kg,upperCloud:mass.liquidUpperKgM2*o.liquidExtinctionM2Kg+mass.iceUpperKgM2*o.iceExtinctionM2Kg,dust:mass.dustKgM2*o.dustExtinctionM2Kg};}
