import {describe,expect,it} from 'vitest';
import {compilePlanetSky,createPlanetSkyRecipe,PLANET_SKY_QUALITIES,type PlanetSkyRecipe} from '../src/shared/planetSky.ts';

const EARTH=6_371_000;
const uniformWeather={output:'coverage',maps:{kind:'generation-maps',version:1,seed:91,maps:{coverage:{type:'constant',value:.7,unit:'normalized'}}}} as const;
const preset=(clouds:PlanetSkyRecipe['clouds']={}):PlanetSkyRecipe=>({kind:'planet-sky',version:1,seed:712,clouds:{weather:uniformWeather,...clouds}});
const point=(altitude:number):[number,number,number]=>[EARTH+altitude,0,0];

describe('shared planetary sky recipes',()=>{
  it('resolves portable defaults, freezes a detached snapshot, and scales dimensions to the planet',()=>{
    const source=preset({windMetersPerSecond:[12,1,3]}),sky=compilePlanetSky(source,EARTH);
    expect(sky.recipe).toMatchObject({style:'realistic',quality:'balanced',pixelSize:4,paletteSteps:12,atmosphere:{heightMeters:80_000},clouds:{bottomMeters:4500,thicknessMeters:3000}});
    source.clouds!.windMetersPerSecond=[90,0,0];source.seed=10;
    expect(sky.recipe.seed).toBe(712);expect(sky.recipe.clouds.windMetersPerSecond).toEqual([12,1,3]);
    expect(Object.isFrozen(sky.recipe.clouds.weather.maps.maps)).toBe(true);expect(Object.isFrozen(sky.recipe.clouds.windMetersPerSecond)).toBe(true);
    const small=compilePlanetSky({kind:'planet-sky',version:1,seed:712},80_000);
    expect(small.recipe.clouds.bottomMeters/EARTH).toBeCloseTo(4500*80_000/EARTH**2,12);
    expect(small.recipe.atmosphere.heightMeters).toBeCloseTo(80_000*80_000/EARTH,10);
    expect(createPlanetSkyRecipe(2,1000).atmosphere!.heightMeters).toBeGreaterThan(0);
  });
  it('keeps seeded volumes stable across style, quality and uniform-only edits',()=>{
    const a=compilePlanetSky(preset(),EARTH),b=compilePlanetSky({...preset({density:3,coverage:.9,erosion:.8}),style:'pixel',quality:'high',pixelSize:7,paletteSteps:5,atmosphere:{rayleighColor:'#e28968',mieStrength:2}},EARTH);
    expect(a.bakeKey).toBe(b.bakeKey);expect(a.revision).not.toBe(b.revision);
    const first=a.bake(),other=b.bake();expect(first.noise.data).toEqual(other.noise.data);expect(first.weather.data).toEqual(other.weather.data);
    const c=compilePlanetSky({...preset(),seed:713},EARTH);expect(c.bakeKey).not.toBe(a.bakeKey);expect(c.bake().noise.data).not.toEqual(first.noise.data);
    const d=compilePlanetSky(preset({weather:{...uniformWeather,maps:{...uniformWeather.maps,seed:92}}}),EARTH);
    expect(d.bakeKey).not.toBe(a.bakeKey);
  });
  it('produces bounded upload volumes with independent channels and deterministic byte contents',()=>{
    const sky=compilePlanetSky(preset(),EARTH),bake=sky.bake(),again=compilePlanetSky(preset(),EARTH).bake();
    expect(bake.noise.size).toBe(32);expect(bake.weather.size).toBe(32);
    expect(bake.noise.data.byteLength+bake.weather.data.byteLength).toBe(163_840);
    expect(bake.noise.data).toEqual(again.noise.data);expect(bake.weather.data).toEqual(again.weather.data);
    expect(bake.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(bake.weather.data.every(value=>value===179)).toBe(true);
    expect(bake.noise.data.filter((v,i)=>i%4===0&&v!==bake.noise.data[i+1]).length).toBeGreaterThan(30_000);
    const sample=sky.sampleCloudDensity(point(6000),2);
    bake.noise.data.fill(0);bake.weather.data.fill(0);
    expect(sky.sampleCloudDensity(point(6000),2)).toBe(sample);
    expect(sky.bake().noise.data).toEqual(again.noise.data);
  });
  it('uses shared weather graphs while enforcing a bounded static normalized world field',()=>{
    const implicit=compilePlanetSky({kind:'planet-sky',version:1,seed:35},EARTH);
    expect(implicit.recipe.clouds.weather.maps.seed).toBe(35);expect(implicit.recipe.clouds.weather.output).toBe('coverage');
    expect(implicit.bake().weather.data.some(value=>value!==implicit.bake().weather.data[0])).toBe(true);
    for(const node of [{type:'constant',value:1,unit:'metres'},{type:'random',scope:'object'},{type:'time',periodSeconds:3},{type:'noise',space:'object',scaleMeters:100}] as const){
      const source=preset({weather:{output:'coverage',maps:{kind:'generation-maps',version:1,seed:3,maps:{coverage:node}}}});
      expect(()=>compilePlanetSky(source,EARTH)).toThrow(/weather/);
    }
    const maps:Record<string,unknown>={};for(let i=0;i<8;i++)maps['n'+i]={type:'noise',space:'world',scaleMeters:50,octaves:8};
    maps.coverage={type:'mix',inputs:Array.from({length:8},(_,i)=>({map:'n'+i}))};
    expect(()=>compilePlanetSky(preset({weather:{output:'coverage',maps:{kind:'generation-maps',version:1,seed:2,maps} as never}}),EARTH)).toThrow(/sampling budget/);
  });
  it('rejects malformed or unbounded input without invoking authored accessors',()=>{
    for(const change of [{seed:NaN},{seed:2.5},{style:'photo'},{quality:'ultra'},{pixelSize:0},{paletteSteps:100},{extra:1}])expect(()=>compilePlanetSky({...preset(),...change} as PlanetSkyRecipe,EARTH)).toThrow();
    for(const radius of [999,1e9,Infinity])expect(()=>compilePlanetSky(preset(),radius)).toThrow(/radius/);
    for(const clouds of [{density:6},{coverage:-.1},{erosion:2},{shapeScaleMeters:0},{detailScaleMeters:Infinity},{bottomMeters:80_000},{windMetersPerSecond:[1001,0,0] as const},{weather:{...uniformWeather,output:'missing'}}])expect(()=>compilePlanetSky(preset(clouds),EARTH)).toThrow();
    for(const atmosphere of [{heightMeters:0},{mieAnisotropy:1},{mieStrength:-1},{rayleighColor:'blue'},{sunIntensity:101},{rayleighScaleHeightMeters:90_000}])expect(()=>compilePlanetSky({...preset(),atmosphere},EARTH)).toThrow();
    const source=preset();let called=false;Object.defineProperty(source,'seed',{get(){called=true;return 1;},enumerable:true});
    expect(()=>compilePlanetSky(source,EARTH)).toThrow(/accessor/);expect(called).toBe(false);
    const wind=[0,0,0];Object.defineProperty(wind,'1',{get(){called=true;return 1;},enumerable:true});
    expect(()=>compilePlanetSky(preset({windMetersPerSecond:wind as [number,number,number]}),EARTH)).toThrow(/accessor/);expect(called).toBe(false);
  });
  it('keeps explicit quality budgets finite and independent of the rendering style',()=>{
    for(const name of ['low','balanced','high'] as const){
      const normal=compilePlanetSky({...preset(),quality:name},EARTH),pixel=compilePlanetSky({...preset(),quality:name,style:'pixel'},EARTH);
      expect(normal.quality).toBe(PLANET_SKY_QUALITIES[name]);expect(pixel.quality).toBe(normal.quality);
      expect(Object.isFrozen(normal.quality)).toBe(true);expect(normal.quality.maxPixels).toBeLessThanOrEqual(360_000);
      expect(normal.quality.cloudSteps).toBeLessThanOrEqual(32);expect(normal.quality.cloudLightSteps).toBeLessThanOrEqual(4);
    }
  });
});

describe('reference cloud volume sampling',()=>{
  it('is deterministic and spatially continuous inside the bounded spherical layer',()=>{
    const sky=compilePlanetSky(preset({coverage:.8,erosion:.2}),EARTH),p=point(6000),density=sky.sampleCloudDensity(p,40);
    expect(density).toBe(sky.sampleCloudDensity(p,40));expect(density).toBeGreaterThan(0);expect(density).toBeLessThanOrEqual(5);
    expect(Math.abs(sky.sampleCloudDensity([p[0]+.001,p[1],p[2]],40)-density)).toBeLessThan(.001);
    expect(sky.sampleCloudDensity(p,0)).not.toBe(density);
    for(const height of [0,4499,4500,7500,7501,100_000])expect(sky.sampleCloudDensity(point(height),40)).toBe(0);
  });
  it('keeps opacity intact when disabled, uncovered or empty rather than baking a different random field',()=>{
    for(const clouds of [{enabled:false},{coverage:0},{density:0}]){
      const source=compilePlanetSky(preset(clouds),EARTH);expect(source.sampleCloudDensity(point(6000),30)).toBe(0);
      expect(source.bakeKey).toBe(compilePlanetSky(preset(),EARTH).bakeKey);
    }
  });
  it('samples the same volume in pixel and realistic styles and rejects invalid query coordinates',()=>{
    const normal=compilePlanetSky(preset(),EARTH),pixel=compilePlanetSky({...preset(),style:'pixel'},EARTH);
    for(const time of [0,10,100])expect(pixel.sampleCloudDensity(point(6000),time)).toBe(normal.sampleCloudDensity(point(6000),time));
    expect(()=>normal.sampleCloudDensity([Infinity,0,0])).toThrow(/sample position/);
    expect(()=>normal.sampleCloudDensity(point(6000),Infinity)).toThrow(/sample time/);
  });
});
