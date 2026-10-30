import {describe,expect,it} from 'vitest';
import {planetAtmosphereColumnOpticalDepth,samplePlanetAtmosphereSnapshots,validatePlanetAtmospherePair,validatePlanetAtmosphereSnapshot,type PlanetAtmosphereSnapshot} from '../src/shared/planetAtmosphereSnapshot.ts';
import {PlanetAtmosphereSnapshotBuffer} from '../src/sandbox/planetAtmosphereSnapshotBuffer.ts';
function snapshot(sequence=0,timeSeconds=sequence*10):PlanetAtmosphereSnapshot {
  const size=64*32*4,condensate=new Float32Array(size),materialLower=new Float32Array(size),materialUpper=new Float32Array(size);
  for(let i=0;i<size;i+=4){materialLower[i+2]=materialUpper[i+2]=1;}
  return {kind:'planet-atmosphere-snapshot',version:1,revision:'physics',planetRevision:'planet',epoch:1,sequence,timeSeconds,radiusMeters:6_371_000,width:64,height:32,condensate,materialLower,materialUpper};
}
describe('physical atmosphere render snapshots',()=>{
  it('validates complete physical planes, matching identity and monotone pair time',()=>{
    const a=snapshot(),b=snapshot(1);expect(validatePlanetAtmosphereSnapshot(a,{radiusMeters:a.radiusMeters,planetRevision:'planet'})).toBe(a);validatePlanetAtmospherePair(a,b);
    expect(()=>validatePlanetAtmosphereSnapshot({...a,condensate:new Float32Array(4)})).toThrow(/planes/);
    const bad=snapshot();bad.condensate[0]=NaN;expect(()=>validatePlanetAtmosphereSnapshot(bad)).toThrow(/mass/);
    expect(()=>validatePlanetAtmospherePair(a,{...b,epoch:2})).toThrow(/identity/);
    expect(()=>validatePlanetAtmospherePair(b,a)).toThrow(/sequence/);
  });
  it('interpolates conserved masses before opacity, retains lower ice and keeps dust out of white clouds',()=>{
    const a=snapshot(),b=snapshot(1);for(let i=0;i<b.condensate.length;i+=4){b.condensate[i]=.1;b.condensate[i+3]=.002;b.materialLower[i+3]=.2;}
    const mass=samplePlanetAtmosphereSnapshots(a,b,5,[0,0,1]);expect(mass.liquidLowerKgM2).toBeCloseTo(.05);expect(mass.iceLowerKgM2).toBeCloseTo(.1);expect(Math.hypot(...mass.materialLower)).toBeCloseTo(1);
    const optical=planetAtmosphereColumnOpticalDepth(mass);expect(optical.lowerCloud).toBeCloseTo(.05*150+.1*65.43);expect(optical.dust).toBeCloseTo(.001*600);
    const dust=snapshot();for(let i=3;i<dust.condensate.length;i+=4)dust.condensate[i]=.002;
    const dustOptical=planetAtmosphereColumnOpticalDepth(samplePlanetAtmosphereSnapshots(dust,dust,0,[0,0,1]));expect(dustOptical.lowerCloud).toBe(0);expect(dustOptical.upperCloud).toBe(0);expect(dustOptical.dust).toBeGreaterThan(0);
    const clear=samplePlanetAtmosphereSnapshots(a,a,0,[0,0,1]);expect(planetAtmosphereColumnOpticalDepth(clear)).toEqual({lowerCloud:0,upperCloud:0,dust:0});
  });
  it('wraps longitude without a field seam and normalizes spatially/temporally interpolated labels',()=>{
    const a=snapshot(),b=snapshot(1);for(let i=0;i<a.condensate.length;i+=4){a.condensate[i]=b.condensate[i]=i/4%64/100;}
    const left=samplePlanetAtmosphereSnapshots(a,b,5,[1e-8,0,-1]),right=samplePlanetAtmosphereSnapshots(a,b,5,[-1e-8,0,-1]);expect(left.liquidLowerKgM2).toBeCloseTo(right.liquidLowerKgM2,6);
  });
  it('stages one plane per frame and atomically commits complete temporal pairs',()=>{
    const buffer=new PlanetAtmosphereSnapshotBuffer({radiusMeters:6_371_000,planetRevision:'planet'}),uploads:unknown[]=[];const renderer={initTexture:(texture:unknown)=>{uploads.push(texture);}};
    buffer.enable();expect(buffer.frame(0)).toMatchObject({enabled:true,active:false});const a=snapshot(),b=snapshot(1);expect(buffer.set(a,b)).toBe(true);expect(buffer.set(a,b)).toBe(false);
    const before=buffer.textures.condensate0;for(let i=0;i<5;i++){expect(buffer.uploadNext(renderer)).toBe(false);expect(buffer.frame(5).active).toBe(false);expect(buffer.textures.condensate0).toBe(before);}
    expect(buffer.uploadNext(renderer)).toBe(true);expect(uploads).toHaveLength(6);expect(buffer.frame(5)).toMatchObject({active:true,alpha:.5,timeSeconds:5});expect(buffer.frame(100).timeSeconds).toBe(10);
    const c=snapshot(2);buffer.set(b,c);buffer.uploadNext(renderer);expect(buffer.inspection().sequence).toBe(1);expect(buffer.inspection().staging).toBe(true);buffer.uploadNext(renderer);buffer.uploadNext(renderer);expect(buffer.inspection().sequence).toBe(2);
    expect(()=>buffer.set(a,b)).toThrow(/Stale/);expect(()=>buffer.set({...c,revision:'other'}, {...snapshot(3),revision:'other'})).toThrow(/epoch/);buffer.dispose();expect(()=>buffer.set(c)).toThrow(/disposed/);
  });
  it('retains the last good pair on upload failure and suppresses stale content after clear/re-enable',()=>{
    const buffer=new PlanetAtmosphereSnapshotBuffer({radiusMeters:6_371_000}),a=snapshot(),b=snapshot(1),ok={initTexture:()=>{}};buffer.set(a);for(let i=0;i<3;i++)buffer.uploadNext(ok);
    buffer.set(a,b);buffer.uploadNext({initTexture:()=>{throw Error('upload failed');}});expect(buffer.inspection()).toMatchObject({active:true,sequence:0,error:'upload failed'});
    buffer.clear();buffer.enable();expect(buffer.frame(5)).toMatchObject({enabled:true,active:false,alpha:0});buffer.dispose();
  });
});
