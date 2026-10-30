import {describe,expect,it} from 'vitest';
import {compilePlanetSky,type PlanetSkyRecipe} from '../src/shared/planetSky.ts';
import {createPlanetWeatherRecipe} from '../src/shared/planetWeather.ts';
import type {PlanetRecipe,PlanetVector} from '../src/shared/planet.ts';

const R=6371000,TAU=Math.PI*2;
const base=():PlanetSkyRecipe=>({kind:'planet-sky',version:1,seed:73});
const polar=(height:number):PlanetVector=>[0,R+height,0];
function surface(height:number):PlanetRecipe{return{kind:'planet',version:1,seed:412,radiusMeters:R,surface:{height:'height',maps:{kind:'generation-maps',version:1,seed:412,maps:{height:{type:'constant',value:height,unit:'metres'}}}}};}

describe('planetary sky circulation contracts',()=>{
  it('invalidates climate upload data when actual terrain changes, including storm genesis eligibility',()=>{
    const ocean=compilePlanetSky({...base(),surface:surface(-1000)},R),land=compilePlanetSky({...base(),surface:surface(1000)},R);
    expect(ocean.bakeKey).not.toBe(land.bakeKey);expect(ocean.weather.revision).not.toBe(land.weather.revision);
    expect(ocean.weather.frame(0).cyclones.some(storm=>storm.type==='tropical')).toBe(true);
    expect(land.weather.frame(0).cyclones.every(storm=>storm.type==='frontal')).toBe(true);
  });
  it('reuses prepared weather for sun, stars, uniform wind, quality and optical edits',()=>{
    const source=compilePlanetSky(base(),R),edited=compilePlanetSky({...source.recipe,quality:'high',style:'pixel',
      celestial:{...source.recipe.celestial,dayLengthSeconds:120,phaseTurns:.25,axialTiltDegrees:40,seasonTurns:.75,sunEnabled:false,starsEnabled:false,starDensity:.2},
      clouds:{...source.recipe.clouds,windMetersPerSecond:[35,2,-11],shadowStrength:.2,godRayStrength:0,density:2.5,erosion:.1,layers:{...source.recipe.clouds.layers,fog:{...source.recipe.clouds.layers.fog,density:1.7}}},
      atmosphere:{...source.recipe.atmosphere,mieStrength:2,sunIntensity:12}},R);
    expect(edited.revision).not.toBe(source.revision);expect(edited.bakeKey).toBe(source.bakeKey);expect(edited.weather.frame(12345)).toEqual(source.weather.frame(12345));
  });
  it('rejects intersecting cloud shells and clouds outside the atmosphere before preparation',()=>{
    expect(()=>compilePlanetSky({...base(),clouds:{layers:{fog:{bottomMeters:900,thicknessMeters:600}}}},R)).toThrow(/ordered|overlap/);
    expect(()=>compilePlanetSky({...base(),clouds:{layers:{cumulus:{bottomMeters:7500,thicknessMeters:2000}}}},R)).toThrow(/ordered|overlap/);
    expect(()=>compilePlanetSky({...base(),clouds:{layers:{cirrus:{bottomMeters:79000,thicknessMeters:2000}}}},R)).toThrow(/atmosphere/);
    expect(()=>compilePlanetSky({...base(),atmosphere:{heightMeters:9000}},R)).toThrow(/atmosphere/);
  });
  it('supports dense sea-level fog at two metres while retaining exact lower and upper boundaries',()=>{
    const sky=compilePlanetSky({...base(),clouds:{layers:{cumulus:{enabled:false},cirrus:{enabled:false}}}},R);
    const close=sky.sampleCloudDensity(polar(2),0,[1,0,0]);expect(close).toBeGreaterThan(.25);expect(close).toBeGreaterThan(sky.sampleCloudDensity(polar(100),0,[1,0,0]));
    expect(sky.sampleCloudDensity(polar(0),0,[1,0,0])).toBe(0);expect(sky.sampleCloudDensity(polar(800),0,[1,0,0])).toBe(0);
    const disabled=compilePlanetSky({...sky.recipe,clouds:{...sky.recipe.clouds,layers:{...sky.recipe.clouds.layers,fog:{...sky.recipe.clouds.layers.fog,enabled:false}}}},R);expect(disabled.sampleCloudDensity(polar(2),0,[1,0,0])).toBe(0);
  });
  it('keeps cirrus continuous across the longitude seam even with an odd wrapped noise period',()=>{
    const sky=compilePlanetSky({...base(),clouds:{shapeScaleMeters:TAU*R/(105*32*8),coverage:1,erosion:0,
      layers:{fog:{enabled:false},cumulus:{enabled:false}},weather:{output:'coverage',maps:{kind:'generation-maps',version:1,seed:73,maps:{coverage:{type:'constant',value:1,unit:'normalized'}}}}}},R);
    let occupied=0;
    for(const latitudeDegrees of [36,40,44,48,52,56,60,64]){
      const lat=latitudeDegrees*Math.PI/180,p=(lon:number):PlanetVector=>[Math.sin(lon)*Math.cos(lat)*(R+10000),Math.sin(lat)*(R+10000),Math.cos(lon)*Math.cos(lat)*(R+10000)],a=sky.sampleCloudDensity(p(Math.PI-1e-9),0,[1,0,0]),b=sky.sampleCloudDensity(p(-Math.PI+1e-9),0,[1,0,0]);
      expect(Math.abs(a-b)).toBeLessThan(1e-5);occupied+=a;
    }
    expect(occupied).toBeGreaterThan(.01);
  });
  it('protects future density queries and upload bakes from mutations to transferred atlas data',()=>{
    const sky=compilePlanetSky({...base(),surface:surface(-1000)},R),points=[polar(2),polar(350),[R+3500,0,0],[0,(R+10000)*Math.sin(.8),(R+10000)*Math.cos(.8)]] as PlanetVector[],before=points.map(point=>sky.sampleCloudDensity(point,200,[1,0,0])),upload=sky.bake(),coverage=upload.circulation.coverage.data.slice(),environment=upload.circulation.environment.data.slice();
    upload.circulation.coverage.data.fill(0);upload.circulation.environment.data.fill(255);
    points.forEach((point,index)=>expect(sky.sampleCloudDensity(point,200,[1,0,0])).toBe(before[index]));
    const replacement=sky.bake();expect(replacement.circulation.coverage.data).toEqual(coverage);expect(replacement.circulation.environment.data).toEqual(environment);
  });
  it('keeps zero regional coverage empty in every cloud layer, including a deliberately white noise lattice point',()=>{
    const source=compilePlanetSky({...base(),clouds:{coverage:1,erosion:0,circulation:{...createPlanetWeatherRecipe(73),coverageTarget:0,resolution:128}}},R),bake=source.bake();
    for(const height of [2,350,3000,10000])expect(source.sampleCloudDensity(polar(height),12345,[1,0,0])).toBe(0);
    // This point would create cloud through a soft threshold centred at one if
    // the zero-coverage gate were omitted. A full-cover control proves the
    // sample lies inside active cumulus and has meaningful density.
    let white=-1;for(let i=0;i<32**3;i++)if(bake.noise.data[i*4]>=254&&bake.noise.data[i*4+2]>=128){white=i;break;}expect(white).toBeGreaterThanOrEqual(0);
    const x=white%32,y=Math.floor(white/32)%32,z=Math.floor(white/1024),scale=(R+3000)/(32000+x+.5),point:PlanetVector=[R+3000,(y+.5)*scale,(z+.5)*scale];
    const zero=compilePlanetSky({...source.recipe,clouds:{...source.recipe.clouds,shapeScaleMeters:scale,windMetersPerSecond:[0,0,0]}},R),full=compilePlanetSky({...zero.recipe,clouds:{...zero.recipe.clouds,circulation:{...zero.recipe.clouds.circulation,coverageTarget:1}}},R);
    expect(full.sampleCloudDensity(point,0,[1,0,0])).toBeGreaterThan(.1);expect(zero.sampleCloudDensity(point,0,[1,0,0])).toBe(0);
  });
});
