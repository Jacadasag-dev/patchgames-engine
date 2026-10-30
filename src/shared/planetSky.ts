import {compileGenerationMaps,generationDataRevision,type GenerationMapRecipe} from './generationMaps.ts';
import {PLANET_LIMITS,type PlanetVector} from './planet.ts';

export type PlanetSkyStyle='realistic'|'pixel';
export type PlanetSkyQualityName='low'|'balanced'|'high';
export interface PlanetSkyQuality {
  resolutionScale:number;maxPixels:number;atmosphereSteps:number;atmosphereLightSteps:number;cloudSteps:number;cloudLightSteps:number;
}
export interface PlanetAtmosphereRecipe {
  enabled?:boolean;heightMeters?:number;rayleighScaleHeightMeters?:number;mieScaleHeightMeters?:number;
  rayleighColor?:string;rayleighStrength?:number;mieStrength?:number;mieAnisotropy?:number;sunIntensity?:number;
}
export interface PlanetCloudRecipe {
  enabled?:boolean;bottomMeters?:number;thicknessMeters?:number;coverage?:number;density?:number;
  shapeScaleMeters?:number;detailScaleMeters?:number;erosion?:number;windMetersPerSecond?:PlanetVector;
  weather?:{maps:GenerationMapRecipe;output:string};
}
export interface PlanetSkyRecipe {
  kind:'planet-sky';version:1;seed:number;style?:PlanetSkyStyle;quality?:PlanetSkyQualityName;
  pixelSize?:number;paletteSteps?:number;atmosphere?:PlanetAtmosphereRecipe;clouds?:PlanetCloudRecipe;
}
export interface ResolvedPlanetSkyRecipe extends Omit<PlanetSkyRecipe,'style'|'quality'|'pixelSize'|'paletteSteps'|'atmosphere'|'clouds'> {
  style:PlanetSkyStyle;quality:PlanetSkyQualityName;pixelSize:number;paletteSteps:number;
  atmosphere:Required<PlanetAtmosphereRecipe>;clouds:Required<PlanetCloudRecipe>;
}
export interface PlanetSkyBake {
  recipe:ResolvedPlanetSkyRecipe;radiusMeters:number;revision:string;bakeKey:string;
  noise:{size:number;data:Uint8Array};weather:{size:number;data:Uint8Array};elapsedMs:number;
}
export interface CompiledPlanetSky {
  readonly recipe:ResolvedPlanetSkyRecipe;readonly radiusMeters:number;readonly revision:string;readonly bakeKey:string;
  readonly quality:Readonly<PlanetSkyQuality>;
  /** Reference sample of the same quantized, linearly filtered fields as the GPU.
   * This samples a few lattice points; it never prepares an entire volume. */
  sampleCloudDensity(position:PlanetVector,timeSeconds?:number):number;
  /** Prepare disposable upload data outside animation frames, normally in a worker. */
  bake():PlanetSkyBake;
}
export const PLANET_SKY_LIMITS=Object.freeze({volumeSize:32,maxWeatherSamplingCost:8_388_608,maxTimeSeconds:1e9});
export const PLANET_SKY_QUALITIES:Readonly<Record<PlanetSkyQualityName,Readonly<PlanetSkyQuality>>>=Object.freeze({
  low:Object.freeze({resolutionScale:.25,maxPixels:65_536,atmosphereSteps:8,atmosphereLightSteps:2,cloudSteps:12,cloudLightSteps:2}),
  balanced:Object.freeze({resolutionScale:.4,maxPixels:180_000,atmosphereSteps:12,atmosphereLightSteps:3,cloudSteps:20,cloudLightSteps:3}),
  high:Object.freeze({resolutionScale:.6,maxPixels:360_000,atmosphereSteps:20,atmosphereLightSteps:4,cloudSteps:32,cloudLightSteps:4}),
});
const EARTH_RADIUS=6_371_000;
const VOLUME_SIZE=PLANET_SKY_LIMITS.volumeSize;
const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
const smooth=(a:number,b:number,value:number)=>{const t=clamp((value-a)/(b-a));return t*t*(3-2*t);};
const clock=()=>typeof performance==='undefined'?Date.now():performance.now();

function plain(input:unknown,keys:readonly string[],name:string):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('Planet sky '+name+' requires supported plain data.');
  if(Object.getOwnPropertySymbols(input).length)throw Error('Planet sky '+name+' does not allow symbol fields.');
  for(const key of Object.getOwnPropertyNames(input)){
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(!keys.includes(key)||!descriptor||!('value'in descriptor)||!descriptor.enumerable)throw Error('Planet sky '+name+' has an unsupported field or accessor: '+key+'.');
  }
  return input as Record<string,unknown>;
}
function numeric(value:unknown,name:string,min:number,max:number,integer=false):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value))throw Error('Planet sky '+name+' must be '+(integer?'an integer':'finite')+' in '+min+'..'+max+'.');
  return value;
}
function flag(value:unknown,name:string):boolean {if(typeof value!=='boolean')throw Error('Planet sky '+name+' must be boolean.');return value;}
function choice<T extends string>(value:unknown,options:readonly T[],name:string):T {
  if(typeof value!=='string'||!options.includes(value as T))throw Error('Planet sky '+name+' must be '+options.join(', ')+'.');return value as T;
}
function vector(value:unknown,name:string,limit:number):PlanetVector {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length!==3||Object.keys(value).length!==3||Object.getOwnPropertyNames(value).length!==4||Object.getOwnPropertySymbols(value).length)throw Error('Planet sky '+name+' requires three finite coordinates.');
  return [0,1,2].map(index=>{const descriptor=Object.getOwnPropertyDescriptor(value,String(index));if(!descriptor||!('value'in descriptor))throw Error('Planet sky '+name+' does not allow array accessors.');return numeric(descriptor.value,name,-limit,limit);}) as [number,number,number];
}
function freeze<T>(input:T):T {
  if(input&&typeof input==='object'){for(const child of Object.values(input))freeze(child);Object.freeze(input);}return input;
}
function defaultWeather(seed:number,radius:number):PlanetCloudRecipe['weather'] {
  return {output:'coverage',maps:{kind:'generation-maps',version:1,seed,maps:{coverage:{type:'noise',space:'world',scaleMeters:Math.min(1_000_000,radius*.1),octaves:2}}}};
}
/** Both the planet identity and its implicit shared weather field receive this
 * seed. Explicit weather graphs keep their own seed, just like other generators. */
export function createPlanetSkyRecipe(seed=42,radiusMeters=EARTH_RADIUS):PlanetSkyRecipe {
  return compilePlanetSky({kind:'planet-sky',version:1,seed},radiusMeters).recipe;
}
/** Independent channels in a periodic random lattice. Upload data is 8-bit;
 * CPU reference samples deliberately use the same quantized values. */
function noiseByte(seed:number,x:number,y:number,z:number,channel:number):number {
  const wrap=(n:number)=>((n%VOLUME_SIZE)+VOLUME_SIZE)%VOLUME_SIZE;
  let h=Math.imul(seed^wrap(x),0x85ebca6b)^Math.imul(wrap(y)+31,0xc2b2ae35)^Math.imul(wrap(z)+73,0x27d4eb2f)^Math.imul(channel+101,0x165667b1);
  h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);return (h^(h>>>16))>>>24;
}
/** Texture coordinates address texel centres at (index+.5)/size. */
function trilinear(uvw:PlanetVector,read:(x:number,y:number,z:number)=>number):number {
  const p=uvw.map(v=>v*VOLUME_SIZE-.5),base=p.map(Math.floor),f=p.map((v,i)=>v-base[i]);
  let value=0;
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++)value+=read(base[0]+x,base[1]+y,base[2]+z)*(x?f[0]:1-f[0])*(y?f[1]:1-f[1])*(z?f[2]:1-f[2]);
  return value/255;
}

export function compilePlanetSky(input:PlanetSkyRecipe,radiusMeters:number):CompiledPlanetSky {
  const radius=numeric(radiusMeters,'radius',PLANET_LIMITS.minRadiusMeters,PLANET_LIMITS.maxRadiusMeters),scale=radius/EARTH_RADIUS;
  const data=plain(input,['kind','version','seed','style','quality','pixelSize','paletteSteps','atmosphere','clouds'],'recipe');
  if(data.kind!=='planet-sky'||data.version!==1)throw Error('Use kind:planet-sky, version:1.');
  const seed=numeric(data.seed,'seed',-2147483648,2147483647,true);
  const a=data.atmosphere===undefined?{}:plain(data.atmosphere,['enabled','heightMeters','rayleighScaleHeightMeters','mieScaleHeightMeters','rayleighColor','rayleighStrength','mieStrength','mieAnisotropy','sunIntensity'],'atmosphere');
  const heightMeters=numeric(a.heightMeters??80_000*scale,'atmosphere height',.1,radius*.1);
  const rayleighColor=a.rayleighColor??'#5b97ff';
  if(typeof rayleighColor!=='string'||!/^#[a-f0-9]{6}$/i.test(rayleighColor))throw Error('Planet sky Rayleigh color requires six-digit hexadecimal RGB.');
  const atmosphere:Required<PlanetAtmosphereRecipe>={
    enabled:flag(a.enabled??true,'atmosphere enabled'),heightMeters,
    rayleighScaleHeightMeters:numeric(a.rayleighScaleHeightMeters??Math.min(heightMeters,8000*scale),'Rayleigh scale height',.01,heightMeters),
    mieScaleHeightMeters:numeric(a.mieScaleHeightMeters??Math.min(heightMeters,1200*scale),'Mie scale height',.01,heightMeters),
    rayleighColor,rayleighStrength:numeric(a.rayleighStrength??1,'Rayleigh strength',0,10),
    mieStrength:numeric(a.mieStrength??1,'Mie strength',0,10),mieAnisotropy:numeric(a.mieAnisotropy??.76,'Mie anisotropy',-.9,.95),
    sunIntensity:numeric(a.sunIntensity??18,'sun intensity',0,100),
  };
  const c=data.clouds===undefined?{}:plain(data.clouds,['enabled','bottomMeters','thicknessMeters','coverage','density','shapeScaleMeters','detailScaleMeters','erosion','windMetersPerSecond','weather'],'clouds');
  const bottomMeters=numeric(c.bottomMeters??4500*scale,'cloud bottom',0,radius*.1);
  const thicknessMeters=numeric(c.thicknessMeters??3000*scale,'cloud thickness',.1,radius*.1);
  if(bottomMeters+thicknessMeters>heightMeters)throw Error('Planet sky cloud top must fit inside the declared atmosphere height.');
  const w=c.weather===undefined?defaultWeather(seed,radius)!:plain(c.weather,['maps','output'],'weather');
  if(typeof w.output!=='string'||!w.output.length)throw Error('Planet sky weather requires an output map ID.');
  const weatherMaps=compileGenerationMaps(w.maps as GenerationMapRecipe),weatherOutput=weatherMaps.output(w.output);
  if(weatherOutput.unit!=='normalized'||weatherOutput.dynamic||weatherOutput.scopes.length||weatherOutput.spaces.some(space=>space!=='world'))throw Error('Planet sky weather requires a static normalized world-space map without object identities.');
  if(weatherOutput.cost*VOLUME_SIZE**3>PLANET_SKY_LIMITS.maxWeatherSamplingCost)throw Error('Planet sky weather sampling budget exceeded; simplify the weather graph.');
  const clouds:Required<PlanetCloudRecipe>={
    enabled:flag(c.enabled??true,'clouds enabled'),bottomMeters,thicknessMeters,
    coverage:numeric(c.coverage??.58,'cloud coverage',0,1),density:numeric(c.density??1.25,'cloud density',0,5),
    shapeScaleMeters:numeric(c.shapeScaleMeters??15_000*scale,'cloud shape scale',.1,radius*.5),
    detailScaleMeters:numeric(c.detailScaleMeters??3000*scale,'cloud detail scale',.1,radius*.5),
    erosion:numeric(c.erosion??.28,'cloud erosion',0,1),
    windMetersPerSecond:vector(c.windMetersPerSecond??[12,0,3],'cloud wind',1000),
    weather:{maps:weatherMaps.recipe,output:w.output},
  };
  const recipe=freeze({kind:'planet-sky',version:1,seed,
    style:choice(data.style??'realistic',['realistic','pixel'],'style'),quality:choice(data.quality??'balanced',['low','balanced','high'],'quality'),
    pixelSize:numeric(data.pixelSize??4,'pixel size',1,32,true),paletteSteps:numeric(data.paletteSteps??12,'palette steps',2,64,true),
    atmosphere,clouds} satisfies ResolvedPlanetSkyRecipe);
  const revision=generationDataRevision({radiusMeters:radius,recipe});
  const bakeKey=generationDataRevision({kind:'planet-sky-volumes',version:1,size:VOLUME_SIZE,radiusMeters:radius,seed,weather:clouds.weather});
  const weatherByte=(x:number,y:number,z:number)=>{
    const world=[x,y,z].map(value=>((clamp(value,0,VOLUME_SIZE-1)+.5)/VOLUME_SIZE-.5)*radius*2.2) as [number,number,number];
    return Math.round(clamp(weatherMaps.sample(clouds.weather.output,{world}))*255);
  };
  let prepared:{noise:Uint8Array;weather:Uint8Array}|undefined;
  return Object.freeze({recipe,radiusMeters:radius,revision,bakeKey,quality:PLANET_SKY_QUALITIES[recipe.quality],
    sampleCloudDensity(position:PlanetVector,timeSeconds=0):number {
      const p=vector(position,'sample position',1e9),time=numeric(timeSeconds,'sample time',-PLANET_SKY_LIMITS.maxTimeSeconds,PLANET_SKY_LIMITS.maxTimeSeconds);
      if(!clouds.enabled||clouds.coverage===0||clouds.density===0)return 0;
      const altitude=Math.hypot(...p)-radius,h=(altitude-clouds.bottomMeters)/clouds.thicknessMeters;
      if(h<=0||h>=1)return 0;
      const uvw=(meters:number)=>p.map((value,index)=>(value+clouds.windMetersPerSecond[index]*time)/(meters*VOLUME_SIZE)) as [number,number,number];
      const base=trilinear(uvw(clouds.shapeScaleMeters),(x,y,z)=>noiseByte(seed,x,y,z,0));
      const detail=trilinear(uvw(clouds.detailScaleMeters),(x,y,z)=>noiseByte(seed,x,y,z,1));
      const weather=trilinear(p.map(value=>value/(radius*2.2)+.5) as [number,number,number],weatherByte);
      const field=clamp((weather*.6+base*.4-.5)*2.5+.5);
      const shape=smooth(1-clouds.coverage-.04,1-clouds.coverage+.04,field);
      const height=smooth(0,.16,h)*(1-smooth(.65,1,h));
      return Math.max(0,(shape*height-clouds.erosion*(1-detail)*.4)/(1-.4*clouds.erosion))*clouds.density;
    },
    bake():PlanetSkyBake {
      const start=clock();
      if(!prepared){
        const count=VOLUME_SIZE**3,noise=new Uint8Array(count*4),weather=new Uint8Array(count);
        for(let z=0;z<VOLUME_SIZE;z++)for(let y=0;y<VOLUME_SIZE;y++)for(let x=0;x<VOLUME_SIZE;x++){
          const index=(z*VOLUME_SIZE+y)*VOLUME_SIZE+x;
          for(let channel=0;channel<4;channel++)noise[index*4+channel]=noiseByte(seed,x,y,z,channel);
          weather[index]=weatherByte(x,y,z);
        }
        prepared={noise,weather};
      }
      // Uploaders may transfer/detach or edit their copies without changing
      // deterministic source queries or a future bake from this compiler.
      return {recipe,radiusMeters:radius,revision,bakeKey,noise:{size:VOLUME_SIZE,data:prepared.noise.slice()},weather:{size:VOLUME_SIZE,data:prepared.weather.slice()},elapsedMs:clock()-start};
    },
  });
}
