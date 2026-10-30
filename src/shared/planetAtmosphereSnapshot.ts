import type {PlanetVector} from './planet.ts';

/** Immutable render transfer from a persistent atmosphere solver. Coordinates
 * are body-fixed; longitude wraps and latitude runs south to north. Masses are
 * column kg/m², not artist coverage/opacity controls. */
export interface PlanetAtmosphereSnapshot {
  kind:'planet-atmosphere-snapshot';version:2;
  revision:string;planetRevision:string;epoch:number;sequence:number;timeSeconds:number;radiusMeters:number;
  width:number;height:number;
  atmosphereHeightMeters:number;
  /** Conservative occupied lower base/top, upper base/top, metres above reference sea level. */
  cloudBoundsMeters:readonly [number,number,number,number];
  /** RGBA: liquid lower, liquid upper, ice upper, airborne dust, all kg/m². */
  condensate:Float32Array;
  /** RGB: advected unit Cartesian material label; A: lower ice kg/m². */
  materialLower:Float32Array;
  /** RGB: upper material label; A: effective terrain/ocean surface height above sea level. */
  materialUpper:Float32Array;
  /** RGBA: lower base/top times lower condensate mass, upper base/top times
   * upper condensate mass (kg/m). Interpolate moments before dividing by mass:
   * clear neighbours cannot pull an occupied cloud toward altitude zero. */
  cloudAltitudeMoments:Float32Array;
}
export interface PlanetAtmosphereSnapshotIdentity {radiusMeters:number;planetRevision?:string;atmosphereHeightMeters?:number}
export const PLANET_ATMOSPHERE_SNAPSHOT_LIMITS=Object.freeze({maxWidth:512,maxMassKgM2:1000,maxBytes:512*256*4*4*4,maxTimeSeconds:1e12});
export const PLANET_ATMOSPHERE_OPTICS=Object.freeze({
  // Geometric-optics Qext=2: 3 Qext/(4 density effectiveRadius).
  liquidExtinctionM2Kg:150,iceExtinctionM2Kg:65.43,dustExtinctionM2Kg:600,
  dustScatteringAlbedo:[.90,.72,.48] as PlanetVector,
});
export interface PlanetAtmosphereColumnMass {liquidLowerKgM2:number;liquidUpperKgM2:number;iceLowerKgM2:number;iceUpperKgM2:number;dustKgM2:number;materialLower:PlanetVector;materialUpper:PlanetVector}
export interface PlanetAtmosphereRenderColumn extends PlanetAtmosphereColumnMass {surfaceHeightMetersAsl:number;lowerBaseMetersAsl:number;lowerTopMetersAsl:number;upperBaseMetersAsl:number;upperTopMetersAsl:number}
const identity=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=160;
export function validatePlanetAtmosphereSnapshot(snapshot:PlanetAtmosphereSnapshot,expected?:PlanetAtmosphereSnapshotIdentity):PlanetAtmosphereSnapshot {
  if(!snapshot||snapshot.kind!=='planet-atmosphere-snapshot'||snapshot.version!==2||!identity(snapshot.revision)||!identity(snapshot.planetRevision)
    ||!Number.isSafeInteger(snapshot.epoch)||snapshot.epoch<0||!Number.isSafeInteger(snapshot.sequence)||snapshot.sequence<0
    ||!Number.isFinite(snapshot.timeSeconds)||snapshot.timeSeconds<0||snapshot.timeSeconds>PLANET_ATMOSPHERE_SNAPSHOT_LIMITS.maxTimeSeconds
    ||!Number.isFinite(snapshot.radiusMeters)||snapshot.radiusMeters<1000||snapshot.radiusMeters>100_000_000
    ||!Number.isFinite(snapshot.atmosphereHeightMeters)||snapshot.atmosphereHeightMeters<=0||snapshot.atmosphereHeightMeters>snapshot.radiusMeters*.1
    ||![64,128,256,512].includes(snapshot.width)||snapshot.height!==snapshot.width/2)throw Error('Invalid atmosphere snapshot header or bounded grid.');
  if(expected&&(snapshot.radiusMeters!==expected.radiusMeters||expected.planetRevision!==undefined&&snapshot.planetRevision!==expected.planetRevision))throw Error('Atmosphere snapshot belongs to another planet.');
  if(expected?.atmosphereHeightMeters!==undefined&&Math.abs(snapshot.atmosphereHeightMeters-expected.atmosphereHeightMeters)>Math.max(.01,expected.atmosphereHeightMeters*1e-6))throw Error('Atmosphere snapshot height does not match the rendering atmosphere.');
  const length=snapshot.width*snapshot.height*4;
  for(const plane of [snapshot.condensate,snapshot.materialLower,snapshot.materialUpper,snapshot.cloudAltitudeMoments])if(!(plane instanceof Float32Array)||plane.length!==length)throw Error('Atmosphere snapshot planes must be complete bounded RGBA32F arrays.');
  const bounds=snapshot.cloudBoundsMeters,tolerance=Math.max(.01,snapshot.atmosphereHeightMeters*2e-6);
  if(!Array.isArray(bounds)||bounds.length!==4||bounds.some(value=>!Number.isFinite(value)||value<0||value>snapshot.atmosphereHeightMeters+tolerance)||bounds[0]>bounds[1]||bounds[2]>bounds[3])throw Error('Atmosphere snapshot cloud bounds are invalid.');
  for(let offset=0;offset<length;offset+=4){
    for(let channel=0;channel<4;channel++){const mass=snapshot.condensate[offset+channel];if(!Number.isFinite(mass)||mass<0||mass>1000)throw Error('Atmosphere snapshot contains invalid column mass.');}
    for(const plane of [snapshot.materialLower,snapshot.materialUpper])for(let channel=0;channel<3;channel++)if(!Number.isFinite(plane[offset+channel])||Math.abs(plane[offset+channel])>1.01)throw Error('Atmosphere snapshot contains invalid material labels.');
    const lowerIce=snapshot.materialLower[offset+3],surface=snapshot.materialUpper[offset+3];if(!Number.isFinite(lowerIce)||lowerIce<0||lowerIce>1000)throw Error('Atmosphere snapshot contains invalid lower ice mass.');
    if(!Number.isFinite(surface)||surface<0||surface>snapshot.atmosphereHeightMeters+tolerance)throw Error('Atmosphere snapshot contains invalid surface height.');
    for(let layer=0;layer<2;layer++){
      const mass=layer?snapshot.condensate[offset+1]+snapshot.condensate[offset+2]:snapshot.condensate[offset]+lowerIce;
      const baseMoment=snapshot.cloudAltitudeMoments[offset+layer*2],topMoment=snapshot.cloudAltitudeMoments[offset+layer*2+1];
      if(!Number.isFinite(baseMoment)||!Number.isFinite(topMoment)||baseMoment<0||topMoment<0||mass===0&&(baseMoment!==0||topMoment!==0))throw Error('Atmosphere snapshot contains invalid cloud altitude moments.');
      if(mass>0){const base=baseMoment/mass,top=topMoment/mass;if(base<0||top<=base||top>snapshot.atmosphereHeightMeters+tolerance||base<bounds[layer*2]-tolerance||top>bounds[layer*2+1]+tolerance)throw Error('Atmosphere cloud geometry escapes its atmosphere or occupied bounds.');}
    }
    for(const [plane,mass]of [[snapshot.materialLower,snapshot.condensate[offset]+lowerIce],[snapshot.materialUpper,snapshot.condensate[offset+1]+snapshot.condensate[offset+2]]] as const){
      const norm=Math.hypot(plane[offset],plane[offset+1],plane[offset+2]);if(mass>0&&(norm<.5||norm>1.5))throw Error('Occupied atmosphere columns require nonzero material labels.');
    }
  }
  return snapshot;
}
export function validatePlanetAtmospherePair(previous:PlanetAtmosphereSnapshot,current:PlanetAtmosphereSnapshot,expected?:PlanetAtmosphereSnapshotIdentity):void {
  validatePlanetAtmosphereSnapshot(previous,expected);if(current!==previous)validatePlanetAtmosphereSnapshot(current,expected);
  for(const key of ['revision','planetRevision','epoch','radiusMeters','atmosphereHeightMeters','width','height'] as const)if(previous[key]!==current[key])throw Error('Atmosphere snapshot pair has mismatched identity or grid.');
  if(previous.sequence>current.sequence||previous.timeSeconds>current.timeSeconds||previous.sequence===current.sequence&&previous.timeSeconds!==current.timeSeconds)throw Error('Atmosphere snapshot pair has reversed sequence or time.');
}
export function planetAtmosphereSnapshotAlpha(previous:PlanetAtmosphereSnapshot,current:PlanetAtmosphereSnapshot,timeSeconds:number):number {
  if(!Number.isFinite(timeSeconds))throw Error('Atmosphere render time must be finite.');
  return current.timeSeconds<=previous.timeSeconds?0:Math.max(0,Math.min(1,(timeSeconds-previous.timeSeconds)/(current.timeSeconds-previous.timeSeconds)));
}
/** CPU reference for the shaders' explicit bilinear RGBA32F loads. There is no
 * optional float32 filtering feature or longitude-seam interpolation shortcut. */
export function samplePlanetAtmosphereSnapshots(previous:PlanetAtmosphereSnapshot,current:PlanetAtmosphereSnapshot,timeSeconds:number,direction:PlanetVector):PlanetAtmosphereRenderColumn {
  const length=Math.hypot(...direction);if(!Number.isFinite(length)||length<1e-12)throw Error('Atmosphere sampling needs a finite nonzero direction.');
  const d=direction.map(value=>value/length),u=Math.atan2(d[0],d[2])/(Math.PI*2)+.5,v=Math.asin(Math.max(-1,Math.min(1,d[1])))/Math.PI+.5,alpha=planetAtmosphereSnapshotAlpha(previous,current,timeSeconds);
  const read=(snapshot:PlanetAtmosphereSnapshot,plane:Float32Array)=>{
    const px=u*snapshot.width-.5,py=v*snapshot.height-.5,x=Math.floor(px),y=Math.floor(py),fx=px-x,fy=py-y,result=[0,0,0,0];
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const xx=((x+dx)%snapshot.width+snapshot.width)%snapshot.width,yy=Math.max(0,Math.min(snapshot.height-1,y+dy)),offset=(yy*snapshot.width+xx)*4,weight=(dx?fx:1-fx)*(dy?fy:1-fy);for(let channel=0;channel<4;channel++)result[channel]+=plane[offset+channel]*weight;}return result;
  };
  const mix=(a:readonly number[],b:readonly number[])=>a.map((value,index)=>value*(1-alpha)+b[index]*alpha);
  const unit=(value:readonly number[])=>{const norm=Math.hypot(value[0],value[1],value[2]);return norm>1e-4?[value[0]/norm,value[1]/norm,value[2]/norm]:d;};
  const mass=mix(read(previous,previous.condensate),read(current,current.condensate)),a=read(previous,previous.materialLower),b=read(current,current.materialLower),c=read(previous,previous.materialUpper),e=read(current,current.materialUpper);
  const lowerIce=a[3]*(1-alpha)+b[3]*alpha,lowerMass=mass[0]+lowerIce,upperMass=mass[1]+mass[2],moments=mix(read(previous,previous.cloudAltitudeMoments),read(current,current.cloudAltitudeMoments));
  return {liquidLowerKgM2:mass[0],liquidUpperKgM2:mass[1],iceUpperKgM2:mass[2],dustKgM2:mass[3],iceLowerKgM2:lowerIce,materialLower:unit(mix(unit(a),unit(b))) as unknown as PlanetVector,materialUpper:unit(mix(unit(c),unit(e))) as unknown as PlanetVector,surfaceHeightMetersAsl:c[3]*(1-alpha)+e[3]*alpha,lowerBaseMetersAsl:lowerMass>0?moments[0]/lowerMass:0,lowerTopMetersAsl:lowerMass>0?moments[1]/lowerMass:0,upperBaseMetersAsl:upperMass>0?moments[2]/upperMass:0,upperTopMetersAsl:upperMass>0?moments[3]/upperMass:0};
}
export function planetAtmosphereColumnOpticalDepth(mass:PlanetAtmosphereColumnMass){const o=PLANET_ATMOSPHERE_OPTICS;return {lowerCloud:mass.liquidLowerKgM2*o.liquidExtinctionM2Kg+mass.iceLowerKgM2*o.iceExtinctionM2Kg,upperCloud:mass.liquidUpperKgM2*o.liquidExtinctionM2Kg+mass.iceUpperKgM2*o.iceExtinctionM2Kg,dust:mass.dustKgM2*o.dustExtinctionM2Kg};}
