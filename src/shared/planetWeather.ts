import {compileGenerationMaps,generationDataRevision} from './generationMaps.ts';
import {PLANET_LIMITS,type CompiledPlanet,type PlanetVector} from './planet.ts';

export interface PlanetWeatherRecipe {
  kind:'planet-weather';version:1;seed:number;coverageTarget?:number;resolution?:128|256|512;
  cycloneCount?:number;timeScale?:number;itczLatitudeDegrees?:number;
  orographicStrength?:number;landConvection?:number;coastalDecks?:number;
}
export type ResolvedPlanetWeatherRecipe=Required<PlanetWeatherRecipe>;
export interface PlanetWeatherCyclone {center:PlanetVector;angularRadius:number;spin:number;phase:number;strength:number;type:'tropical'|'frontal'}
export interface PlanetWeatherFrame {timeDays:number;cyclones:PlanetWeatherCyclone[]}
export interface PlanetWeatherAtlas {width:number;height:number;data:Uint8Array}
export interface PlanetWeatherBake {
  radiusMeters:number;revision:string;recipe:ResolvedPlanetWeatherRecipe;
  coverage:PlanetWeatherAtlas;environment:PlanetWeatherAtlas;coverageGain:number;
  targetCoverage:number;achievedCoverage:number;coverageThreshold:number;
  metric:'Area-weighted static weather mask: max(low,cumulus,cirrus)>0.5; not rendered optical cloud fraction';
}
export interface PlanetWeatherSample {
  low:number;cumulus:number;cirrus:number;coverage:number;land:number;
  elevationMeters:number;windward:number;rainShadow:number;coastal:number;windEastMetersPerSecond:number;
}
export interface CompiledPlanetWeather {
  readonly recipe:ResolvedPlanetWeatherRecipe;readonly revision:string;
  frame(timeSeconds?:number):PlanetWeatherFrame;
  sample(direction:PlanetVector,timeSeconds?:number,sunDirection?:PlanetVector):PlanetWeatherSample;
  bake():PlanetWeatherBake;
}
export const PLANET_WEATHER_LIMITS=Object.freeze({maxCyclones:16,maxAtlasWidth:512,maxAtlasBytes:1024*1024,maxTerrainSamplingCost:33_554_432,maxTimeSeconds:1e9});
const PI=Math.PI,TAU=PI*2,DEG=PI/180,EARTH=6371000;
type Vec=[number,number,number];
const clamp=(x:number,a=0,b=1)=>Math.max(a,Math.min(b,x));
const smooth=(a:number,b:number,x:number)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const fract=(x:number)=>x-Math.floor(x);
const dot=(a:PlanetVector,b:PlanetVector)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:PlanetVector,b:PlanetVector):Vec=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function unit(p:PlanetVector):Vec {if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))throw Error('Planet weather requires a finite direction.');const length=Math.hypot(...p);if(length<1e-12||length>1e12)throw Error('Planet weather requires a bounded nonzero direction.');return [p[0]/length,p[1]/length,p[2]/length];}
function value(n:unknown,name:string,a:number,b:number,integer=false){if(typeof n!=='number'||!Number.isFinite(n)||n<a||n>b||integer&&!Number.isInteger(n))throw Error('Planet weather '+name+' must be '+(integer?'an integer':'finite')+' in '+a+'..'+b+'.');return n;}
function random(seed:number,index:number){let h=Math.imul(seed^index,0x85ebca6b);h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);return ((h^(h>>>16))>>>0)/4294967296;}
function direction(latitude:number,longitude:number):Vec {const ring=Math.cos(latitude);return [Math.sin(longitude)*ring,Math.sin(latitude),Math.cos(longitude)*ring];}
function noise(p:PlanetVector,scale:number,seed:number){const a=p.map(v=>v*scale),base=a.map(Math.floor),t=a.map((v,i)=>smooth(0,1,v-base[i]));let result=0;for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++){const key=Math.imul(base[0]+x,73856093)^Math.imul(base[1]+y,19349663)^Math.imul(base[2]+z,83492791);result+=random(seed,key)*(x?t[0]:1-t[0])*(y?t[1]:1-t[1])*(z?t[2]:1-t[2]);}return result;}
const fbm=(p:PlanetVector,scale:number,seed:number)=>noise(p,scale,seed)*.67+noise(p,scale*2.07,seed+101)*.33;
/** East-west steering in metres/second: trades/polar easterlies are negative,
 * storm-track westerlies positive. Smooth boundaries avoid latitude seams. */
export function planetWeatherZonalWind(latitudeRadians:number):number {
  const a=Math.abs(latitudeRadians)/DEG;return -8+30*smooth(25,38,a)*(1-smooth(60,72,a));
}
export function createPlanetWeatherRecipe(seed=42):ResolvedPlanetWeatherRecipe {
  return {kind:'planet-weather',version:1,seed,coverageTarget:.67,resolution:512,cycloneCount:8,timeScale:1,itczLatitudeDegrees:0,orographicStrength:1,landConvection:1,coastalDecks:1};
}
function parse(input:PlanetWeatherRecipe):ResolvedPlanetWeatherRecipe {
  generationDataRevision(input);
  const defaults=createPlanetWeatherRecipe(input.seed),keys=Object.keys(defaults);
  if(input.kind!=='planet-weather'||input.version!==1||Object.keys(input).some(key=>!keys.includes(key)))throw Error('Use a version 1 planet-weather recipe with supported fields.');
  const r={...defaults,...input};value(r.seed,'seed',-2147483648,2147483647,true);value(r.coverageTarget,'coverage target',0,1);
  if(![128,256,512].includes(r.resolution))throw Error('Planet weather resolution must be 128, 256 or 512.');
  value(r.cycloneCount,'cyclone count',0,16,true);value(r.timeScale,'time scale',0,86400);value(r.itczLatitudeDegrees,'ITCZ latitude',-10,10);
  for(const name of ['orographicStrength','landConvection','coastalDecks'] as const)value(r[name],name,0,1);
  return Object.freeze(r);
}
interface StormSource {latitude:number;longitude:number;radius:number;phase:number;age:number;spin:number;type:'tropical'|'frontal'}
export function samplePlanetWeatherStorm(inputDirection:PlanetVector,storm:PlanetWeatherCyclone):[number,number] {
  const d=unit(inputDirection);
  if(dot(d,storm.center)<Math.cos(storm.angularRadius*1.55))return [0,0];
  const east=unit(cross([0,1,0],storm.center)),north=cross(storm.center,east),x=dot(d,east)/storm.angularRadius,y=dot(d,north)/storm.angularRadius,r=Math.hypot(x,y),angle=Math.atan2(y,x);
  const spiral=.5+.5*Math.cos(storm.spin*angle-storm.phase+r*(storm.type==='tropical'?12:5));
  const envelope=(1-smooth(.9,1.5,r))*storm.strength;
  if(storm.type==='tropical'){
    const eye=smooth(.055,.13,r),core=Math.exp(-(((r-.19)/.10)**2)),arms=smooth(.35,.88,spiral)*(1-smooth(.5,1.3,r));
    return [clamp(Math.max(core,arms*.88)*eye*envelope),clamp(envelope*.5*eye*(.45+.55*spiral))];
  }
  const head=Math.exp(-((x+.14)**2+(y-.12)**2)*9)*(.65+.35*spiral),tail=Math.exp(-(((y+storm.spin*(.1+.42*x+.24*x*x))/.10)**2))*smooth(-1.35,-.4,x)*(1-smooth(.6,1.4,x));
  return [clamp(Math.max(head,tail*.88)*envelope),clamp(Math.max(head*.7,tail)*envelope)];
}
function coastalCells(u:number,v:number):number {
  u=fract(u);
  const qx=u*512,qy=v*256,ix=Math.floor(qx),iy=Math.floor(qy);let first=Infinity,second=Infinity;
  for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){
    const cx=ix+x,cy=iy+y;let h=Math.imul(cx&511,374761393)^Math.imul(cy,668265263);h=Math.imul(h^(h>>>13),1274126177);h=(h^(h>>>16))>>>0;
    const px=cx+(h&65535)/65535-qx,py=cy+(h>>>16)/65535-qy,distance=px*px+py*py;if(distance<first){second=first;first=distance;}else if(distance<second)second=distance;
  }
  const edge=1-smooth(.03,.18,Math.sqrt(second)-Math.sqrt(first)),closed=.5+.5*Math.sin(u*TAU*3+(v-.5)*PI*9);
  return (.18+.82*edge)*(1-closed)+(1-.45*edge)*closed;
}
function sampleAtlas(atlas:PlanetWeatherAtlas,u:number,v:number):[number,number,number,number] {
  const px=fract(u)*atlas.width-.5,py=clamp(v)*atlas.height-.5,x=Math.floor(px),y=Math.floor(py),fx=px-x,fy=py-y,result:[number,number,number,number]=[0,0,0,0];
  for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const ix=((x+dx)%atlas.width+atlas.width)%atlas.width,iy=clamp(y+dy,0,atlas.height-1),offset=(iy*atlas.width+ix)*4,weight=(dx?fx:1-fx)*(dy?fy:1-fy);for(let c=0;c<4;c++)result[c]+=atlas.data[offset+c]/255*weight;}
  return result;
}
function coverageAt(radius:number,frame:PlanetWeatherFrame,d:PlanetVector,sun:PlanetVector,readCoverage:(u:number,v:number)=>readonly number[],readEnvironment:(u:number,v:number)=>readonly number[],gain=1):[number,number,number] {
  const latitude=Math.asin(clamp(d[1],-1,1)),longitude=Math.atan2(d[0],d[2]),u=longitude/TAU+.5,v=latitude/PI+.5;
  const angular=planetWeatherZonalWind(latitude)*86400/radius;
  const advected=readCoverage(u-frame.timeDays*angular/TAU,v),environment=readEnvironment(u,v),local=readCoverage(u,v);
  const east:PlanetVector=[Math.cos(longitude),0,-Math.sin(longitude)],localSunAngle=Math.atan2(-dot(sun,east),dot(sun,d)),afternoon=smooth(-.15,.4,localSunAngle)*(1-smooth(1.2,1.8,localSunAngle))*smooth(-.12,.15,dot(sun,d));
  let low=advected[0],cumulus=advected[1],cirrus=advected[2];
  low=clamp(low+environment[1]*.42-environment[2]*.24);
  const coastal=environment[3]*(1-smooth(45,55,Math.abs(latitude)/DEG));
  if(coastal>.01){const cells=coastalCells(u-frame.timeDays*angular/TAU,v);low*=1-coastal*.8+coastal*.8*(.2+.8*cells);}
  cumulus=clamp(cumulus*(1-environment[2]*.7)+environment[1]*.48+local[3]*afternoon*.38);
  for(const storm of frame.cyclones){const value=samplePlanetWeatherStorm(d,storm);cumulus=Math.max(cumulus,value[0]);cirrus=Math.max(cirrus,value[1]);}
  return [clamp(low*gain),clamp(cumulus*gain),clamp(cirrus*gain)];
}

/** Deterministic parametric circulation, not a fluid solver or forecast. Noise
 * supplies cells inside circulation regimes; it never replaces their structure.
 * Atlas preparation belongs to a worker. frame() is bounded and never bakes. */
export function compilePlanetWeather(input:PlanetWeatherRecipe,radiusMeters:number,planet?:CompiledPlanet):CompiledPlanetWeather {
  const recipe=parse(input),radius=value(radiusMeters,'radius',PLANET_LIMITS.minRadiusMeters,PLANET_LIMITS.maxRadiusMeters),heightScale=radius/EARTH;
  if(planet&&planet.radius!==radius)throw Error('Planet weather and terrain radii must match.');
  const revision=generationDataRevision({recipe,radius,terrain:planet?.revision??null});
  const terrain=planet?compileGenerationMaps(planet.recipe.surface.maps):undefined,sea=planet?.recipe.seaLevelMeters??0;
  if(terrain&&terrain.output(planet!.recipe.surface.height).cost*recipe.resolution**2/2>PLANET_WEATHER_LIMITS.maxTerrainSamplingCost)throw Error('Planet weather terrain sampling budget exceeded; reduce atlas resolution or simplify the surface graph.');
  const height=(d:PlanetVector)=>terrain?terrain.sample(planet!.recipe.surface.height,{world:d.map(v=>v*radius) as Vec}): -1000*heightScale;
  const storms:StormSource[]=[];
  for(let i=0;i<recipe.cycloneCount;i++){
    const spin=i%2===0?1:-1,type=i<Math.ceil(recipe.cycloneCount/2)?'tropical':'frontal';let latitude=spin*(type==='tropical'?7+random(recipe.seed,i*17+2)*11:38+random(recipe.seed,i*17+2)*20)*DEG,longitude=(random(recipe.seed,i*17+3)*2-1)*PI;
    if(type==='tropical'&&planet){let accepted=false;for(let j=0;j<48;j++){longitude=(random(recipe.seed,i*101+j+1001)*2-1)*PI;if(height(direction(latitude,longitude))<=sea){accepted=true;break;}}if(!accepted)continue;}
    storms.push({latitude,longitude,radius:(type==='tropical'?.065:.19)*(1+random(recipe.seed,i+77)*.5),phase:random(recipe.seed,i+501)*TAU,age:random(recipe.seed,i+901)*24,spin,type});
  }
  const frame=(timeSeconds=0):PlanetWeatherFrame=>{
    const timeDays=value(timeSeconds,'time',-1e9,1e9)*recipe.timeScale/86400;
    return {timeDays,cyclones:recipe.coverageTarget===0?[]:storms.map(storm=>{
      if(storm.type==='frontal')return {center:direction(storm.latitude+Math.sin(timeDays*.27+storm.phase)*2*DEG,storm.longitude+timeDays*.23),angularRadius:storm.radius,spin:storm.spin,phase:storm.phase+timeDays*1.7,strength:.82,type:storm.type};
      const age=((timeDays+storm.age)%24+24)%24,recurve=smooth(11,22,age),latitude=storm.latitude+storm.spin*(age*.7+recurve*6)*DEG,longitude=storm.longitude-age*.09+recurve*1.8;
      return {center:direction(latitude,longitude),angularRadius:storm.radius*(.7+Math.sin(age/24*PI)*.5),spin:storm.spin,phase:storm.phase+timeDays*2.6,strength:smooth(0,2,age)*(1-smooth(21,24,age)),type:storm.type};
    })};
  };
  const width=recipe.resolution,heightPixels=width/2;
  // Fixed response calibrated against equal-area global samples. A point query
  // never computes a histogram or allocates an atlas. Actual coverage is
  // measured by bake(), and remains an art-direction target rather than a
  // promise about projected optical cloud opacity.
  const threshold=recipe.coverageTarget===0?2:recipe.coverageTarget===1?-1:.95-.997*recipe.coverageTarget-(planet ? -.007 : .045);
  const cellIndex=(x:number,y:number)=>clamp(y,0,heightPixels-1)*width+((x%width)+width)%width;
  const heightCache=new Map<number,number>(),cellCache=new Map<number,{coverage:number[];environment:number[]}>();
  const directionAt=(x:number,y:number)=>direction(((clamp(y,0,heightPixels-1)+.5)/heightPixels-.5)*PI,((((x%width)+width)%width+.5)/width-.5)*TAU);
  const heightAt=(x:number,y:number)=>{const key=cellIndex(x,y),cached=heightCache.get(key);if(cached!==undefined)return cached;const result=height(directionAt(x,y));if(heightCache.size>=2048)heightCache.clear();heightCache.set(key,result);return result;};
  const landAt=(x:number,y:number,readHeight:typeof heightAt)=>smooth(-100*heightScale,100*heightScale,readHeight(x,y)-sea);
  const evaluateCell=(x:number,y:number,readHeight:typeof heightAt)=>{
    const latitude=((y+.5)/heightPixels-.5)*PI,longitude=((x+.5)/width-.5)*TAU,d=direction(latitude,longitude),a=Math.abs(latitude)/DEG,land=landAt(x,y,readHeight),wind=planetWeatherZonalWind(latitude),upstream=wind>=0?-1:1,stride=Math.max(1,width/256);
    const gradient=(readHeight(x+stride,y)-readHeight(x-stride,y))*(wind>=0?1:-1)/(1500*heightScale),windward=clamp(gradient)*recipe.orographicStrength,rainShadow=clamp(-gradient)*recipe.orographicStrength;
    let coast=0,wake=0;
    if(land<.5)for(let n=1;n<=5;n++){
      coast=Math.max(coast,landAt(x+n*stride,y,readHeight)*(1-n/6));
      for(let transverse=-1;transverse<=1;transverse++){
        const island=landAt(x+upstream*n*stride,y+transverse*stride,readHeight)*(1-landAt(x+upstream*n*stride,y+(transverse-2)*stride,readHeight))*(1-landAt(x+upstream*n*stride,y+(transverse+2)*stride,readHeight));
        if(island<.05)continue;
        const alternate=n%2===0?1:-1,px=(n%2.5)-1.25,py=-transverse-alternate*.65,r=Math.hypot(px,py),curl=.5+.5*Math.cos(alternate*Math.atan2(py,px)+r*5);
        wake=Math.max(wake,island*(1-n/6)*Math.exp(-r*r*.7)*smooth(.25,.8,curl));
      }
    }
    const marine=coast*smooth(12,20,a)*(1-smooth(32,42,a))*recipe.coastalDecks;
    // The highest octave stays below the atlas Nyquist limit. Fine puffs and
    // coastal cells are evaluated analytically/in 3D, never baked as aliased
    // point samples into this macro field.
    const band=width/(4*PI*2.07),broad=fbm(d,Math.min(7,band*.6),recipe.seed),cells=fbm(d,Math.min(16,band*.82),recipe.seed+17),small=fbm(d,Math.min(20,band*.95),recipe.seed+29),itcz=Math.exp(-(((latitude/DEG-recipe.itczLatitudeDegrees)/8.5)**2)),dry=Math.exp(-(((a-27)/9)**2)),track=smooth(30,39,a)*(1-smooth(60,70,a)),polar=smooth(65,78,a);
    const jet=track*(.5+.5*Math.sin(latitude*48+Math.sin(longitude*4+recipe.seed)*2+broad*3))**5;
    const low=clamp(.13+cells*.25+polar*small*.28+marine*(.55+broad*.15)+wake*.3-dry*.16)*(1-land*.16),conv=clamp(.12+itcz*(.28+.7*smooth(.25,.7,cells))+track*(.15+broad*.48)+small*.12-dry*.38-polar*.22),cirrus=clamp(.09+jet*.68+track*broad*.32+itcz*small*.22-dry*.10);
    const quantized=(n:number)=>Math.round(clamp(n)*255)/255;
    return {coverage:[...[low,conv,cirrus].map(n=>quantized(smooth(threshold-.12,threshold+.12,n))),quantized(land*recipe.landConvection)],
      environment:[quantized((readHeight(x,y)-sea)/(16000*heightScale)),quantized(windward),quantized(rainShadow),quantized(Math.max(marine,wake))]};
  };
  const cell=(x:number,y:number)=>{
    x=((x%width)+width)%width;y=clamp(y,0,heightPixels-1);const key=cellIndex(x,y),cached=cellCache.get(key);if(cached)return cached;
    // At a pole longitude collapses. Use a fixed eight-longitude quadrature in
    // both bake and point sampling, not a full row preparation.
    let result:{coverage:number[];environment:number[]};
    if(y===0||y===heightPixels-1){result={coverage:[0,0,0,0],environment:[0,0,0,0]};for(let i=0;i<8;i++){const sample=evaluateCell(Math.floor((i+.5)*width/8),y,heightAt);for(let c=0;c<4;c++){result.coverage[c]+=sample.coverage[c]/8;result.environment[c]+=sample.environment[c]/8;}}for(const key of ['coverage','environment'] as const)result[key]=result[key].map(v=>Math.round(v*255)/255);}
    else result=evaluateCell(x,y,heightAt);
    if(cellCache.size>=1024)cellCache.clear();cellCache.set(key,result);return result;
  };
  const pointAtlas=(kind:'coverage'|'environment',u:number,v:number):[number,number,number,number]=>{
    const px=fract(u)*width-.5,py=clamp(v)*heightPixels-.5,x=Math.floor(px),y=Math.floor(py),fx=px-x,fy=py-y,result:[number,number,number,number]=[0,0,0,0];
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const sample=cell(x+dx,y+dy)[kind],weight=(dx?fx:1-fx)*(dy?fy:1-fy);for(let c=0;c<4;c++)result[c]+=sample[c]*weight;}return result;
  };
  let prepared:PlanetWeatherBake|undefined;
  const prepare=():PlanetWeatherBake=>{
    if(prepared)return prepared;
    const count=width*heightPixels,coverage=new Uint8Array(count*4),environment=new Uint8Array(count*4),heights=new Float64Array(count);
    for(let y=0;y<heightPixels;y++)for(let x=0;x<width;x++)heights[y*width+x]=height(directionAt(x,y));
    const readHeight=(x:number,y:number)=>heights[cellIndex(x,y)];
    for(let y=0;y<heightPixels;y++)for(let x=0;x<width;x++){const data=y===0||y===heightPixels-1?cell(x,y):evaluateCell(x,y,readHeight),offset=(y*width+x)*4;coverage.set(data.coverage.map(v=>Math.round(v*255)),offset);environment.set(data.environment.map(v=>Math.round(v*255)),offset);}
    let occupied=0,total=0;
    for(let y=0;y<heightPixels;y++)for(let x=0;x<width;x++){const weight=Math.cos(((y+.5)/heightPixels-.5)*PI),offset=(y*width+x)*4;total+=weight;if(Math.max(coverage[offset],coverage[offset+1],coverage[offset+2])>127.5)occupied+=weight;}
    prepared={radiusMeters:radius,revision,recipe,coverage:{width,height:heightPixels,data:coverage},environment:{width,height:heightPixels,data:environment},coverageGain:recipe.coverageTarget===0?0:1,targetCoverage:recipe.coverageTarget,achievedCoverage:occupied/total,coverageThreshold:threshold,metric:'Area-weighted static weather mask: max(low,cumulus,cirrus)>0.5; not rendered optical cloud fraction'};return prepared;
  };
  return Object.freeze({recipe,revision,frame,sample(inputDirection:PlanetVector,timeSeconds=0,sunDirection:PlanetVector=[1,0,0]):PlanetWeatherSample{
    const d=unit(inputDirection),sun=unit(sunDirection),readCoverage=(u:number,v:number)=>prepared?sampleAtlas(prepared.coverage,u,v):pointAtlas('coverage',u,v),readEnvironment=(u:number,v:number)=>prepared?sampleAtlas(prepared.environment,u,v):pointAtlas('environment',u,v);
    const current=frame(timeSeconds),fields=coverageAt(radius,current,d,sun,readCoverage,readEnvironment,recipe.coverageTarget===0?0:1),u=Math.atan2(d[0],d[2])/TAU+.5,v=Math.asin(d[1])/PI+.5,env=readEnvironment(u,v),land=readCoverage(u,v)[3];
    return {low:fields[0],cumulus:fields[1],cirrus:fields[2],coverage:1-(1-fields[0])*(1-fields[1])*(1-fields[2]),land,elevationMeters:env[0]*16000*heightScale,windward:env[1],rainShadow:env[2],coastal:env[3],windEastMetersPerSecond:planetWeatherZonalWind(Math.asin(d[1]))};
  },bake(){const data=prepare();return{...data,coverage:{...data.coverage,data:data.coverage.data.slice()},environment:{...data.environment,data:data.environment.data.slice()}};}});
}

/** Shader and CPU transport use the same regime masks, diurnal and storm math.
 * Explicit LOD zero is required when these helpers are called inside ray loops. */
export const planetWeatherCoverageGLSL=/* glsl */`
float planetWeatherCells(vec2 uv){
  vec2 q=uv*vec2(512.0,256.0);ivec2 base=ivec2(floor(q));float nearest=1000000.0,second=1000000.0;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){ivec2 cell=base+ivec2(x,y);uint h=(uint(cell.x&511)*374761393u)^(uint(cell.y)*668265263u);h=(h^(h>>13u))*1274126177u;h=h^(h>>16u);vec2 jitter=vec2(float(h&65535u),float(h>>16u))/65535.0;vec2 delta=vec2(cell)+jitter-q;float distance=dot(delta,delta);if(distance<nearest){second=nearest;nearest=distance;}else if(distance<second){second=distance;}}
  float edge=1.0-smoothstep(0.03,0.18,sqrt(second)-sqrt(nearest)),closed=0.5+0.5*sin(uv.x*6.283185307179586*3.0+(uv.y-0.5)*3.141592653589793*9.0);return mix(0.18+0.82*edge,1.0-0.45*edge,closed);
}
vec3 planetWeatherCoverage(sampler2D coverageTexture,sampler2D environmentTexture,vec3 direction,vec3 sunDirection,float timeDays,vec4 stormCenters[16],vec4 stormProperties[16],int stormCount,float coverageGain){
  const float weatherPI=3.141592653589793;float latitude=asin(clamp(direction.y,-1.0,1.0)),longitude=atan(direction.x,direction.z),degrees=abs(latitude)*180.0/weatherPI;
  vec2 uv=vec2(longitude/(2.0*weatherPI)+0.5,latitude/weatherPI+0.5);
  float wind=-8.0+30.0*smoothstep(25.0,38.0,degrees)*(1.0-smoothstep(60.0,72.0,degrees));
  // Angular advection uses Earth-normalized days; renderer passes weather days
  // adjusted by Earth/radius for the same physical steering on small planets.
  vec4 field=textureLod(coverageTexture,vec2(fract(uv.x-timeDays*wind*86400.0/(6371000.0*2.0*weatherPI)),uv.y),0.0);
  vec4 environment=textureLod(environmentTexture,uv,0.0),localField=textureLod(coverageTexture,uv,0.0);
  vec3 east=vec3(cos(longitude),0.0,-sin(longitude));float solar=dot(sunDirection,direction),hour=atan(-dot(sunDirection,east),solar);
  float afternoon=smoothstep(-0.15,0.4,hour)*(1.0-smoothstep(1.2,1.8,hour))*smoothstep(-0.12,0.15,solar);
  vec3 result=vec3(clamp(field.r+environment.g*0.42-environment.b*0.24,0.0,1.0),clamp(field.g*(1.0-environment.b*0.7)+environment.g*0.48+localField.a*afternoon*0.38,0.0,1.0),field.b);
  float coastal=environment.a*(1.0-smoothstep(45.0,55.0,degrees));if(coastal>0.01){float cells=planetWeatherCells(vec2(uv.x-timeDays*wind*86400.0/(6371000.0*2.0*weatherPI),uv.y));result.r*=mix(1.0,0.2+0.8*cells,coastal*0.8);}
  for(int index=0;index<16;index++){if(index>=stormCount)break;vec4 center=stormCenters[index],properties=stormProperties[index];if(dot(direction,center.xyz)<cos(center.w*1.55))continue;
    vec3 stormEast=normalize(cross(vec3(0.0,1.0,0.0),center.xyz)),stormNorth=cross(center.xyz,stormEast);float x=dot(direction,stormEast)/center.w,y=dot(direction,stormNorth)/center.w,r=length(vec2(x,y)),angle=atan(y,x);
    float spiral=0.5+0.5*cos(properties.x*angle-properties.y+r*mix(12.0,5.0,properties.w)),envelope=(1.0-smoothstep(0.9,1.5,r))*properties.z;
    vec2 storm;
    if(properties.w<0.5){float eye=smoothstep(0.055,0.13,r),core=exp(-pow(abs((r-0.19)/0.10),2.0)),arms=smoothstep(0.35,0.88,spiral)*(1.0-smoothstep(0.5,1.3,r));storm=vec2(max(core,arms*0.88)*eye*envelope,envelope*0.5*eye*(0.45+0.55*spiral));}
    else{float head=exp(-((x+0.14)*(x+0.14)+(y-0.12)*(y-0.12))*9.0)*(0.65+0.35*spiral),tail=exp(-pow(abs((y+properties.x*(0.1+0.42*x+0.24*x*x))/0.10),2.0))*smoothstep(-1.35,-0.4,x)*(1.0-smoothstep(0.6,1.4,x));storm=vec2(max(head,tail*0.88),max(head*0.7,tail))*envelope;}
    result.gb=max(result.gb,clamp(storm,0.0,1.0));
  }return clamp(result*coverageGain,0.0,1.0);
}
`;
export const planetWeatherCoverageWGSL=/* wgsl */`
fn planetWeatherCells(uv:vec2<f32>)->f32{
  let q=uv*vec2<f32>(512.0,256.0);let base=vec2<i32>(floor(q));var nearest=1000000.0;var second=1000000.0;
  for(var y:i32=-1;y<=1;y++){for(var x:i32=-1;x<=1;x++){let cell=base+vec2<i32>(x,y);var h=(u32(cell.x&511)*374761393u)^(u32(cell.y)*668265263u);h=(h^(h>>13u))*1274126177u;h=h^(h>>16u);let jitter=vec2<f32>(f32(h&65535u),f32(h>>16u))/65535.0;let delta=vec2<f32>(cell)+jitter-q;let distance=dot(delta,delta);if(distance<nearest){second=nearest;nearest=distance;}else if(distance<second){second=distance;}}}
  let edge=1.0-smoothstep(0.03,0.18,sqrt(second)-sqrt(nearest));let closed=0.5+0.5*sin(uv.x*6.283185307179586*3.0+(uv.y-0.5)*3.141592653589793*9.0);return mix(0.18+0.82*edge,1.0-0.45*edge,closed);
}
fn planetWeatherCoverage(coverageTexture:texture_2d<f32>,environmentTexture:texture_2d<f32>,weatherSampler:sampler,direction:vec3<f32>,sunDirection:vec3<f32>,timeDays:f32,stormCenters:array<vec4<f32>,16>,stormProperties:array<vec4<f32>,16>,stormCount:i32,coverageGain:f32)->vec3<f32>{
  let weatherPI=3.141592653589793;let latitude=asin(clamp(direction.y,-1.0,1.0));let longitude=atan2(direction.x,direction.z);let degrees=abs(latitude)*180.0/weatherPI;
  let uv=vec2<f32>(longitude/(2.0*weatherPI)+0.5,latitude/weatherPI+0.5);
  let wind=-8.0+30.0*smoothstep(25.0,38.0,degrees)*(1.0-smoothstep(60.0,72.0,degrees));
  let field=textureSampleLevel(coverageTexture,weatherSampler,vec2<f32>(fract(uv.x-timeDays*wind*86400.0/(6371000.0*2.0*weatherPI)),uv.y),0.0);
  let environment=textureSampleLevel(environmentTexture,weatherSampler,uv,0.0);let localField=textureSampleLevel(coverageTexture,weatherSampler,uv,0.0);
  let east=vec3<f32>(cos(longitude),0.0,-sin(longitude));let solar=dot(sunDirection,direction);let hour=atan2(-dot(sunDirection,east),solar);
  let afternoon=smoothstep(-0.15,0.4,hour)*(1.0-smoothstep(1.2,1.8,hour))*smoothstep(-0.12,0.15,solar);
  var result=vec3<f32>(clamp(field.r+environment.g*0.42-environment.b*0.24,0.0,1.0),clamp(field.g*(1.0-environment.b*0.7)+environment.g*0.48+localField.a*afternoon*0.38,0.0,1.0),field.b);
  let coastal=environment.a*(1.0-smoothstep(45.0,55.0,degrees));if(coastal>0.01){let cells=planetWeatherCells(vec2<f32>(uv.x-timeDays*wind*86400.0/(6371000.0*2.0*weatherPI),uv.y));result=vec3<f32>(result.r*mix(1.0,0.2+0.8*cells,coastal*0.8),result.g,result.b);}
  for(var index:i32=0;index<16;index++){if(index>=stormCount){break;}let center=stormCenters[index];let properties=stormProperties[index];if(dot(direction,center.xyz)<cos(center.w*1.55)){continue;}
    let stormEast=normalize(cross(vec3<f32>(0.0,1.0,0.0),center.xyz));let stormNorth=cross(center.xyz,stormEast);let x=dot(direction,stormEast)/center.w;let y=dot(direction,stormNorth)/center.w;let r=length(vec2<f32>(x,y));let angle=atan2(y,x);
    let spiral=0.5+0.5*cos(properties.x*angle-properties.y+r*mix(12.0,5.0,properties.w));let envelope=(1.0-smoothstep(0.9,1.5,r))*properties.z;
    var storm:vec2<f32>;
    if(properties.w<0.5){let eye=smoothstep(0.055,0.13,r);let core=exp(-pow(abs((r-0.19)/0.10),2.0));let arms=smoothstep(0.35,0.88,spiral)*(1.0-smoothstep(0.5,1.3,r));storm=vec2<f32>(max(core,arms*0.88)*eye*envelope,envelope*0.5*eye*(0.45+0.55*spiral));}
    else{let head=exp(-((x+0.14)*(x+0.14)+(y-0.12)*(y-0.12))*9.0)*(0.65+0.35*spiral);let tail=exp(-pow(abs((y+properties.x*(0.1+0.42*x+0.24*x*x))/0.10),2.0))*smoothstep(-1.35,-0.4,x)*(1.0-smoothstep(0.6,1.4,x));storm=vec2<f32>(max(head,tail*0.88),max(head*0.7,tail))*envelope;}
    let combined=max(result.gb,clamp(storm,vec2<f32>(0.0),vec2<f32>(1.0)));result=vec3<f32>(result.r,combined.x,combined.y);
  }return clamp(result*coverageGain,vec3<f32>(0.0),vec3<f32>(1.0));
}
`;
