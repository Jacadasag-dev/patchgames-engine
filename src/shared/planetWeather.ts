import {compileGenerationMaps,generationDataRevision} from './generationMaps.ts';
import {PLANET_LIMITS,type CompiledPlanet,type PlanetVector} from './planet.ts';

export interface PlanetWeatherRecipe {
  kind:'planet-weather';version:1;seed:number;coverageTarget?:number;resolution?:128|256|512;
  cycloneCount?:number;timeScale?:number;itczLatitudeDegrees?:number;
  orographicStrength?:number;landConvection?:number;coastalDecks?:number;
  rotationPeriodSeconds?:number;moisture?:number;pressureStrength?:number;
}
export type ResolvedPlanetWeatherRecipe=Required<PlanetWeatherRecipe>;
export interface PlanetWeatherCyclone {center:PlanetVector;angularRadius:number;spin:number;phase:number;strength:number;type:'tropical'|'frontal'}
export interface PlanetWeatherFrame {timeDays:number;rotationScale:number;cyclones:PlanetWeatherCyclone[]}
export interface PlanetWeatherAtlas {width:number;height:number;data:Uint8Array}
export interface PlanetWeatherBake {
  radiusMeters:number;revision:string;recipe:ResolvedPlanetWeatherRecipe;
  coverage:PlanetWeatherAtlas;environment:PlanetWeatherAtlas;coverageGain:number;
  targetCoverage:number;achievedCoverage:number;coverageThreshold:number;condensationThreshold:number;
  referenceTimeSeconds:number;referenceSunDirection:PlanetVector;
  metric:'Area-weighted occupied atmospheric columns after pressure, moisture, fronts, terrain and sunlight; not rendered optical cloud fraction';
}
export interface PlanetWeatherSample {
  low:number;cumulus:number;cirrus:number;coverage:number;land:number;
  elevationMeters:number;windward:number;rainShadow:number;coastal:number;windEastMetersPerSecond:number;
  support:number;condensation:number;pressureHectopascals:number;relativeHumidity:number;
  windNorthMetersPerSecond:number;flowDirection:PlanetVector;coldFront:number;warmFront:number;temperatureKelvin:number;
}
export interface CompiledPlanetWeather {
  readonly recipe:ResolvedPlanetWeatherRecipe;readonly revision:string;readonly condensationThreshold:number;
  frame(timeSeconds?:number):PlanetWeatherFrame;
  sample(direction:PlanetVector,timeSeconds?:number,sunDirection?:PlanetVector):PlanetWeatherSample;
  bake():PlanetWeatherBake;
}
export const PLANET_WEATHER_LIMITS=Object.freeze({maxCyclones:16,maxAtlasWidth:512,maxAtlasBytes:1024*1024,maxTerrainSamplingCost:33_554_432,maxTimeSeconds:1e9,maxCalibrationSamples:512});
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
/** Fixed proper rotations decorrelate octave lattices. A low-frequency warp
 * bends their regular spacing without spending the atlas Nyquist headroom.
 * Its conservative Jacobian bound is <= 80% of the remaining bandwidth. */
const rotateDomain=(p:PlanetVector):Vec=>[.36*p[0]+.48*p[1]-.8*p[2],-.8*p[0]+.6*p[1],.48*p[0]+.64*p[1]+.6*p[2]];
function fbm(p:PlanetVector,scale:number,seed:number,band:number):number {
  const rotated=rotateDomain(p),warpFrequency=1.7,headroom=Math.max(0,band/scale-1),amplitude=Math.min(.35/Math.max(8,scale),headroom*.8/(3*1.5*warpFrequency));
  const warped=rotated.map((v,index)=>v+(noise(rotated,warpFrequency,seed+[1103,3301,5501][index])-.5)*amplitude) as Vec;
  return noise(warped,scale,seed)*.67+noise(rotateDomain(warped),scale*2.07,seed+101)*.33;
}
/** East-west steering in metres/second: trades/polar easterlies are negative,
 * storm-track westerlies positive. Smooth boundaries avoid latitude seams. */
export function planetWeatherZonalWind(latitudeRadians:number):number {
  const a=Math.abs(latitudeRadians)/DEG;return -8+30*smooth(25,38,a)*(1-smooth(60,72,a));
}
export function createPlanetWeatherRecipe(seed=42):ResolvedPlanetWeatherRecipe {
  return {kind:'planet-weather',version:1,seed,coverageTarget:.67,resolution:512,cycloneCount:8,timeScale:1,itczLatitudeDegrees:0,orographicStrength:1,landConvection:1,coastalDecks:1,rotationPeriodSeconds:86400,moisture:1,pressureStrength:1};
}
function parse(input:PlanetWeatherRecipe):ResolvedPlanetWeatherRecipe {
  generationDataRevision(input);
  const defaults=createPlanetWeatherRecipe(input.seed),keys=Object.keys(defaults);
  if(input.kind!=='planet-weather'||input.version!==1||Object.keys(input).some(key=>!keys.includes(key)))throw Error('Use a version 1 planet-weather recipe with supported fields.');
  const r={...defaults,...input};value(r.seed,'seed',-2147483648,2147483647,true);value(r.coverageTarget,'coverage target',0,1);
  if(![128,256,512].includes(r.resolution))throw Error('Planet weather resolution must be 128, 256 or 512.');
  value(r.cycloneCount,'cyclone count',0,16,true);value(r.timeScale,'time scale',0,86400);value(r.itczLatitudeDegrees,'ITCZ latitude',-10,10);
  value(r.rotationPeriodSeconds,'rotation period',10,1e9);value(r.moisture,'moisture',0,2);value(r.pressureStrength,'pressure strength',0,2);
  for(const name of ['orographicStrength','landConvection','coastalDecks'] as const)value(r[name],name,0,1);
  return Object.freeze(r);
}
interface StormSource {latitude:number;longitude:number;radius:number;phase:number;age:number;spin:number;type:'tropical'|'frontal'}
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
interface ColumnState {score:number;humidity:number;pressure:number;temperature:number;wind:[number,number];flow:Vec;weights:Vec;coldFront:number;warmFront:number;orographicLift:number}
const calibrationCache=new Map<string,number>();
/** Linear surface drag/Coriolis balance: pressure is a normalized 40 hPa
 * anomaly, air density 1.2 kg/m³, drag time four hours. This is a bounded
 * diagnostic balance, not a prognostic momentum/energy integration. */
function columnAt(radius:number,frame:PlanetWeatherFrame,d:PlanetVector,sun:PlanetVector,readField:(u:number,v:number)=>readonly number[],readEnvironment:(u:number,v:number)=>readonly number[]):ColumnState {
  const latitude=Math.asin(clamp(d[1],-1,1)),longitude=Math.atan2(d[0],d[2]),u=longitude/TAU+.5,v=latitude/PI+.5,east:Vec=[Math.cos(longitude),0,-Math.sin(longitude)],north=cross(d,east),epsilon=.025;
  const read=(p:PlanetVector)=>readField(Math.atan2(p[0],p[2])/TAU+.5,Math.asin(clamp(p[1],-1,1))/PI+.5);
  const field=read(d),fieldEast=read(unit(d.map((n,i)=>n+east[i]*epsilon) as Vec)),fieldNorth=read(unit(d.map((n,i)=>n+north[i]*epsilon) as Vec)),environment=readEnvironment(u,v);
  let pressure=field[1]-128/255,gradientEast=(fieldEast[1]-field[1])/epsilon,gradientNorth=(fieldNorth[1]-field[1])/epsilon,lift=0,subsidence=0;
  for(const storm of frame.cyclones){if(dot(d,storm.center)<Math.cos(storm.angularRadius*2.2))continue;const se=unit(cross([0,1,0],storm.center)),sn=cross(storm.center,se),x=dot(d,se)/storm.angularRadius,y=dot(d,sn)/storm.angularRadius,r=Math.hypot(x,y),ellipticity=storm.type==='frontal'?1.8:1.12,angle=storm.phase*.15,c=Math.cos(angle),s=Math.sin(angle),rx=c*x+s*y,ry=(-s*x+c*y)*ellipticity,q=rx*rx+ry*ry;
    const envelope=(1-smooth(1.8,2.2,r))*storm.strength,core=Math.exp(-q*1.4)*envelope,dx=(c*rx-s*ry*ellipticity)*2.8*core/storm.angularRadius,dy=(s*rx+c*ry*ellipticity)*2.8*core/storm.angularRadius;
    pressure-=core*.65;gradientEast+=.65*(dx*dot(se,east)+dy*dot(sn,east));gradientNorth+=.65*(dx*dot(se,north)+dy*dot(sn,north));lift+=core*.65;if(storm.type==='tropical'){const eye=1-smooth(.08,.18,r),wall=Math.exp(-(((r-.24)/.11)**2));subsidence+=eye*storm.strength*.3;lift+=(wall*.7-eye*.8)*storm.strength;}
  }
  const drag=1/14400,coriolis=4*PI/86400*frame.rotationScale*Math.sin(latitude),balance=drag*drag+coriolis*coriolis,forceEast=-gradientEast*4000/(radius*1.2),forceNorth=-gradientNorth*4000/(radius*1.2);
  let windEast=(drag*forceEast+coriolis*forceNorth)/balance,windNorth=(drag*forceNorth-coriolis*forceEast)/balance;const rawSpeed=Math.hypot(windEast,windNorth),limit=Math.min(1,100/Math.max(1e-9,rawSpeed));windEast*=limit;windNorth*=limit;const speed=Math.hypot(windEast,windNorth);
  const age=21600+7200*Math.sin(frame.timeDays*.31),angle=speed*(frame.timeDays*86400+age)/radius,trace=unit(d.map((n,i)=>n*Math.cos(angle)-(east[i]*windEast+north[i]*windNorth)/Math.max(1e-9,speed)*Math.sin(angle)) as Vec),advected=read(trace),solar=dot(sun,d),hour=Math.atan2(-dot(sun,east),solar),afternoon=smooth(-.15,.4,hour)*(1-smooth(1.2,1.8,hour))*smooth(-.12,.15,solar);
  const thermalEast=(read(unit(trace.map((n,i)=>n+east[i]*epsilon) as Vec))[2]-advected[2])/epsilon,thermalNorth=(read(unit(trace.map((n,i)=>n+north[i]*epsilon) as Vec))[2]-advected[2])/epsilon,thermalGradient=Math.hypot(thermalEast,thermalNorth),transport=(windEast*thermalEast+windNorth*thermalNorth)/Math.max(1,speed*thermalGradient),front=smooth(.2,1.2,thermalGradient)*smooth(1,12,speed),coldFront=front*clamp(-transport),warmFront=front*clamp(transport);
  const orographicLift=((environment[1]-128/255)*2*windEast+(environment[2]-128/255)*2*windNorth)/Math.max(5,speed),terrainLift=Math.max(0,orographicLift)*.7+Math.min(0,orographicLift)*.55;
  lift+=terrainLift+field[3]*afternoon*.35+coldFront*.8+warmFront*.5;
  const humidity=clamp(advected[0]-subsidence),temperature=300-55*d[1]*d[1]+(advected[2]-.5)*18-environment[0]*104,condensation=humidity-(.55+.045*(advected[2]-.5)-clamp(lift,-1,2)*.19+Math.max(0,pressure)*.20);
  const track=smooth(30,39,Math.abs(latitude)/DEG)*(1-smooth(60,70,Math.abs(latitude)/DEG)),polar=smooth(65,78,Math.abs(latitude)/DEG),itcz=Math.exp(-(((latitude/DEG)/12)**2)),coastal=environment[3]*(1-smooth(45,55,Math.abs(latitude)/DEG));
  const cells=coastal>.01?coastalCells(Math.atan2(trace[0],trace[2])/TAU+.5,Math.asin(trace[1])/PI+.5):1;
  return {score:humidity<=0?-2:condensation,humidity,pressure,temperature,wind:[windEast,windNorth],flow:trace,coldFront,warmFront,orographicLift,weights:[clamp(.24+polar*.65+coastal*.6+warmFront*.35-coldFront*.10)*(.3+.7*cells),clamp(.30+itcz*.62+lift*.28+coldFront*.45-polar*.25),clamp(.18+track*.65+warmFront*.25+coldFront*.2)]};
}
function coverageAt(state:ColumnState,threshold:number,gain=1):{support:number;layers:Vec} {
  const support=gain<=0||state.humidity<=0?0:smooth(threshold,threshold+.065,state.score);
  return {support,layers:state.weights.map(n=>clamp(n*support*gain)) as Vec};
}

/** Deterministic parametric circulation, not a fluid solver or forecast. Noise
 * supplies cells inside circulation regimes; it never replaces their structure.
 * Atlas preparation belongs to a worker. frame() is bounded and never bakes. */
export function compilePlanetWeather(input:PlanetWeatherRecipe,radiusMeters:number,planet?:CompiledPlanet):CompiledPlanetWeather {
  const recipe=parse(input),radius=value(radiusMeters,'radius',PLANET_LIMITS.minRadiusMeters,PLANET_LIMITS.maxRadiusMeters),heightScale=radius/EARTH;
  if(planet&&planet.radius!==radius)throw Error('Planet weather and terrain radii must match.');
  const revision=generationDataRevision({algorithm:'coupled-pressure-moisture-weather-5',recipe,radius,terrain:planet?.revision??null});
  const terrain=planet?compileGenerationMaps(planet.recipe.surface.maps):undefined,sea=planet?.recipe.seaLevelMeters??0;
  if(terrain&&terrain.output(planet!.recipe.surface.height).cost*recipe.resolution**2/2>PLANET_WEATHER_LIMITS.maxTerrainSamplingCost)throw Error('Planet weather terrain sampling budget exceeded; reduce atlas resolution or simplify the surface graph.');
  const height=(d:PlanetVector)=>terrain?terrain.sample(planet!.recipe.surface.height,{world:d.map(v=>v*radius) as Vec}): -1000*heightScale;
  const storms:StormSource[]=[];
  const frame=(timeSeconds=0):PlanetWeatherFrame=>{
    const timeDays=value(timeSeconds,'time',-1e9,1e9)*recipe.timeScale/86400;
    return {timeDays,rotationScale:86400/recipe.rotationPeriodSeconds,cyclones:recipe.coverageTarget===0?[]:storms.map(storm=>{
      if(storm.type==='frontal')return {center:direction(storm.latitude+Math.sin(timeDays*.27+storm.phase)*2*DEG,storm.longitude+timeDays*.23),angularRadius:storm.radius,spin:storm.spin,phase:storm.phase+timeDays*1.7,strength:(.65+.17*Math.sin(timeDays*.37+storm.phase))*recipe.pressureStrength,type:storm.type};
      const age=((timeDays+storm.age)%24+24)%24,recurve=smooth(11,22,age),latitude=storm.latitude+storm.spin*(age*.7+recurve*6)*DEG,longitude=storm.longitude-age*.09+recurve*1.8;
      return {center:direction(latitude,longitude),angularRadius:storm.radius*(.7+Math.sin(age/24*PI)*.5),spin:storm.spin,phase:storm.phase+timeDays*2.6,strength:smooth(0,2,age)*(1-smooth(21,24,age))*recipe.pressureStrength,type:storm.type};
    })};
  };
  const width=recipe.resolution,heightPixels=width/2;
  const cellIndex=(x:number,y:number)=>clamp(y,0,heightPixels-1)*width+((x%width)+width)%width;
  const heightCache=new Map<number,number>(),cellCache=new Map<number,{coverage:number[];environment:number[]}>();
  const directionAt=(x:number,y:number)=>direction(((clamp(y,0,heightPixels-1)+.5)/heightPixels-.5)*PI,((((x%width)+width)%width+.5)/width-.5)*TAU);
  const heightAt=(x:number,y:number)=>{const key=cellIndex(x,y),cached=heightCache.get(key);if(cached!==undefined)return cached;const result=height(directionAt(x,y));if(heightCache.size>=2048)heightCache.clear();heightCache.set(key,result);return result;};
  const landAt=(x:number,y:number,readHeight:typeof heightAt)=>smooth(-100*heightScale,100*heightScale,readHeight(x,y)-sea);
  const evaluateCell=(x:number,y:number,readHeight:typeof heightAt)=>{
    const latitude=((y+.5)/heightPixels-.5)*PI,longitude=((x+.5)/width-.5)*TAU,d=direction(latitude,longitude),a=Math.abs(latitude)/DEG,land=landAt(x,y,readHeight),wind=planetWeatherZonalWind(latitude),upstream=wind>=0?-1:1,stride=Math.max(1,width/256);
    const gradientEast=clamp((readHeight(x+stride,y)-readHeight(x-stride,y))/(1500*heightScale),-1,1)*recipe.orographicStrength,gradientNorth=clamp((readHeight(x,y+stride)-readHeight(x,y-stride))/(1500*heightScale),-1,1)*recipe.orographicStrength;
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
    const band=width/(4*PI*2.07),broad=fbm(d,Math.min(7,band*.6),recipe.seed,band),cells=fbm(d,Math.min(16,band*.82),recipe.seed+17,band),small=fbm(d,Math.min(20,band*.95),recipe.seed+29,band),itcz=Math.exp(-(((latitude/DEG-recipe.itczLatitudeDegrees)/8.5)**2)),dry=Math.exp(-(((a-27)/9)**2)),track=smooth(30,39,a)*(1-smooth(60,70,a)),polar=smooth(65,78,a);
    const humidity=clamp(.53+(cells-.5)*.42+itcz*.17+track*.08-dry*.19+marine*.13+polar*.025-land*.035),pressure=clamp(.5+(broad-.5)*.32+dry*.17+polar*.10-itcz*.12-track*.12),thermal=clamp(.52-Math.sin(latitude)**2*.34+(small-.5)*.34+land*.05);
    const quantized=(n:number)=>Math.round(clamp(n)*255)/255;
    return {coverage:[quantized(humidity*recipe.moisture),quantized(128/255+(pressure-.5)*recipe.pressureStrength),quantized(thermal),quantized(land*recipe.landConvection)],
      environment:[quantized((readHeight(x,y)-sea)/(16000*heightScale)),quantized(128/255+gradientEast*.5),quantized(128/255+gradientNorth*.5),quantized(Math.max(marine,wake))]};
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
  for(let i=0;i<recipe.cycloneCount;i++){
    const spin=i%2===0?1:-1,type=i<Math.ceil(recipe.cycloneCount/2)?'tropical':'frontal';let latitude=spin*(type==='tropical'?7+random(recipe.seed,i*17+2)*11:38+random(recipe.seed,i*17+2)*20)*DEG,longitude=(random(recipe.seed,i*17+3)*2-1)*PI;
    if(type==='tropical'){
      if(recipe.moisture<.5)continue;let accepted=false;
      for(let j=0;j<48;j++){
        latitude=spin*(7+random(recipe.seed,i*201+j+2001)*11)*DEG;longitude=(random(recipe.seed,i*101+j+1001)*2-1)*PI;
        const genesis=direction(latitude,longitude),field=pointAtlas('coverage',longitude/TAU+.5,latitude/PI+.5),temperature=300-55*genesis[1]*genesis[1]+(field[2]-.5)*18;
        if(height(genesis)<=sea&&field[0]>=.5&&temperature>=294){accepted=true;break;}
      }if(!accepted)continue;
    }
    storms.push({latitude,longitude,radius:(type==='tropical'?.065:.19)*(1+random(recipe.seed,i+77)*.5),phase:random(recipe.seed,i+501)*TAU,age:random(recipe.seed,i+901)*24,spin,type});
  }
  // Rank a fixed bounded equal-area sample once per actual weather/surface
  // revision. Uniform optical edits reuse this cache; no query builds an atlas
  // or reruns calibration. Calibrate the reference moisture budget so changing
  // moisture still changes condensation instead of being normalized away.
  const calibrationKey=generationDataRevision({revision:'coupled-weather-calibration-5',recipe:{...recipe,moisture:1,pressureStrength:1},radius,terrain:planet?.revision??null});
  let threshold=recipe.moisture===0?2:calibrationCache.get(calibrationKey);
  if(threshold===undefined&&(recipe.moisture!==1||recipe.pressureStrength!==1))threshold=compilePlanetWeather({...recipe,moisture:1,pressureStrength:1},radius,planet).condensationThreshold;
  if(threshold===undefined){
    if(recipe.coverageTarget===0)threshold=2;else if(recipe.coverageTarget===1)threshold=-2;
    else{
      const scores:number[]=[],reference=frame(0),count=PLANET_WEATHER_LIMITS.maxCalibrationSamples;
      const readField=(u:number,v:number)=>{const f=pointAtlas('coverage',u,v);f[0]/=Math.max(recipe.moisture,1e-9);return f;};
      for(let i=0;i<count;i++){const y=1-2*(i+.5)/count,longitude=i*PI*(3-Math.sqrt(5)),d:Vec=[Math.sin(longitude)*Math.sqrt(1-y*y),y,Math.cos(longitude)*Math.sqrt(1-y*y)];scores.push(columnAt(radius,reference,d,[1,0,0],readField,(u,v)=>pointAtlas('environment',u,v)).score);}
      scores.sort((a,b)=>a-b);threshold=clamp(scores[Math.floor((1-recipe.coverageTarget)*scores.length)],-2,2);
    }
    if(calibrationCache.size>=16)calibrationCache.delete(calibrationCache.keys().next().value!);calibrationCache.set(calibrationKey,threshold);
  }
  const condensationThreshold=threshold;
  let prepared:PlanetWeatherBake|undefined;
  const prepare=():PlanetWeatherBake=>{
    if(prepared)return prepared;
    const count=width*heightPixels,coverage=new Uint8Array(count*4),environment=new Uint8Array(count*4),heights=new Float64Array(count);
    for(let y=0;y<heightPixels;y++)for(let x=0;x<width;x++)heights[y*width+x]=height(directionAt(x,y));
    const readHeight=(x:number,y:number)=>heights[cellIndex(x,y)];
    for(let y=0;y<heightPixels;y++)for(let x=0;x<width;x++){const data=y===0||y===heightPixels-1?cell(x,y):evaluateCell(x,y,readHeight),offset=(y*width+x)*4;coverage.set(data.coverage.map(v=>Math.round(v*255)),offset);environment.set(data.environment.map(v=>Math.round(v*255)),offset);}
    let occupied=0,total=0;const coverageAtlas={width,height:heightPixels,data:coverage},environmentAtlas={width,height:heightPixels,data:environment},reference=frame(0);
    for(let y=0;y<heightPixels;y++)for(let x=0;x<width;x++){const weight=Math.cos(((y+.5)/heightPixels-.5)*PI),state=columnAt(radius,reference,directionAt(x,y),[1,0,0],(u,v)=>sampleAtlas(coverageAtlas,u,v),(u,v)=>sampleAtlas(environmentAtlas,u,v));total+=weight;if(coverageAt(state,condensationThreshold,recipe.coverageTarget===0?0:1).support>0)occupied+=weight;}
    prepared={radiusMeters:radius,revision,recipe,coverage:coverageAtlas,environment:environmentAtlas,coverageGain:recipe.coverageTarget===0?0:1,targetCoverage:recipe.coverageTarget,achievedCoverage:occupied/total,coverageThreshold:condensationThreshold,condensationThreshold,referenceTimeSeconds:0,referenceSunDirection:[1,0,0],metric:'Area-weighted occupied atmospheric columns after pressure, moisture, fronts, terrain and sunlight; not rendered optical cloud fraction'};return prepared;
  };
  return Object.freeze({recipe,revision,condensationThreshold,frame,sample(inputDirection:PlanetVector,timeSeconds=0,sunDirection:PlanetVector=[1,0,0]):PlanetWeatherSample{
    const d=unit(inputDirection),sun=unit(sunDirection),readCoverage=(u:number,v:number)=>prepared?sampleAtlas(prepared.coverage,u,v):pointAtlas('coverage',u,v),readEnvironment=(u:number,v:number)=>prepared?sampleAtlas(prepared.environment,u,v):pointAtlas('environment',u,v);
    const current=frame(timeSeconds),state=columnAt(radius,current,d,sun,readCoverage,readEnvironment),fields=coverageAt(state,condensationThreshold,recipe.coverageTarget===0?0:1),u=Math.atan2(d[0],d[2])/TAU+.5,v=Math.asin(d[1])/PI+.5,env=readEnvironment(u,v),land=readCoverage(u,v)[3];
    return {low:fields.layers[0],cumulus:fields.layers[1],cirrus:fields.layers[2],coverage:fields.support,support:fields.support,condensation:Math.max(0,state.score-condensationThreshold),pressureHectopascals:1013.25+state.pressure*40,relativeHumidity:state.humidity<=0?0:clamp(1+(state.score-condensationThreshold)*.8),windNorthMetersPerSecond:state.wind[1],flowDirection:state.flow,coldFront:state.coldFront,warmFront:state.warmFront,temperatureKelvin:state.temperature,land,elevationMeters:env[0]*16000*heightScale,windward:clamp(state.orographicLift),rainShadow:clamp(-state.orographicLift),coastal:env[3],windEastMetersPerSecond:state.wind[0]};
  },bake(){const data=prepare();return{...data,coverage:{...data.coverage,data:data.coverage.data.slice()},environment:{...data.environment,data:data.environment.data.slice()}};}});
}

/** Matching quantized CPU and shader circulation with explicit LOD zero. */
export const planetWeatherCoverageGLSL=/* glsl */`
struct PlanetWeatherState { vec3 coverage; vec3 flowDirection; float support; float pressure; float humidity; vec2 wind; float coldFront; float warmFront; };
float planetWeatherCells(vec2 inputUV){
  vec2 uv=vec2(fract(inputUV.x),inputUV.y),q=uv*vec2(512.0,256.0);ivec2 base=ivec2(floor(q));float nearest=1000000.0,second=1000000.0;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){ivec2 cell=base+ivec2(x,y);uint h=(uint(cell.x&511)*374761393u)^(uint(cell.y)*668265263u);h=(h^(h>>13u))*1274126177u;h=h^(h>>16u);vec2 jitter=vec2(float(h&65535u),float(h>>16u))/65535.0;vec2 delta=vec2(cell)+jitter-q;float distance=dot(delta,delta);if(distance<nearest){second=nearest;nearest=distance;}else if(distance<second){second=distance;}}
  float edge=1.0-smoothstep(0.03,0.18,sqrt(second)-sqrt(nearest)),closed=0.5+0.5*sin(uv.x*6.283185307179586*3.0+(uv.y-0.5)*3.141592653589793*9.0);return mix(0.18+0.82*edge,1.0-0.45*edge,closed);
}
vec4 planetWeatherRead(sampler2D fieldTexture,vec3 p,float timeDays,float radiusMeters){
  float latitude=asin(clamp(p.y,-1.0,1.0));
  return textureLod(fieldTexture,vec2(fract(atan(p.x,p.z)/6.283185307179586+0.5),latitude/3.141592653589793+0.5),0.0);
}
PlanetWeatherState planetWeatherState(sampler2D coverageTexture,sampler2D environmentTexture,vec3 direction,vec3 sunDirection,float timeDays,vec4 stormCenters[16],vec4 stormProperties[16],int stormCount,float coverageGain,float rotationScale,float condensationThreshold,float radiusMeters){
  float latitude=asin(clamp(direction.y,-1.0,1.0)),longitude=atan(direction.x,direction.z),degrees=abs(latitude)*57.29577951308232;
  vec2 uv=vec2(longitude/6.283185307179586+0.5,latitude/3.141592653589793+0.5);vec3 east=vec3(cos(longitude),0.0,-sin(longitude)),north=cross(direction,east);
  vec4 field=planetWeatherRead(coverageTexture,direction,timeDays,radiusMeters),fieldEast=planetWeatherRead(coverageTexture,normalize(direction+east*0.025),timeDays,radiusMeters),fieldNorth=planetWeatherRead(coverageTexture,normalize(direction+north*0.025),timeDays,radiusMeters),environment=textureLod(environmentTexture,uv,0.0);
  float pressure=field.g-128.0/255.0,gradientEast=(fieldEast.g-field.g)/0.025,gradientNorth=(fieldNorth.g-field.g)/0.025,lift=0.0,subsidence=0.0;
  for(int index=0;index<16;index++){if(index>=stormCount)break;vec4 center=stormCenters[index],properties=stormProperties[index];if(dot(direction,center.xyz)<cos(center.w*2.2))continue;
    vec3 se=normalize(cross(vec3(0.0,1.0,0.0),center.xyz)),sn=cross(center.xyz,se);float x=dot(direction,se)/center.w,y=dot(direction,sn)/center.w,r=length(vec2(x,y)),ellipticity=properties.w>0.5?1.8:1.12,angle=properties.y*0.15,c=cos(angle),s=sin(angle),rx=c*x+s*y,ry=(-s*x+c*y)*ellipticity,q=rx*rx+ry*ry;
    float envelope=(1.0-smoothstep(1.8,2.2,r))*properties.z,core=exp(-q*1.4)*envelope,dx=(c*rx-s*ry*ellipticity)*2.8*core/center.w,dy=(s*rx+c*ry*ellipticity)*2.8*core/center.w;
    pressure-=core*0.65;gradientEast+=0.65*(dx*dot(se,east)+dy*dot(sn,east));gradientNorth+=0.65*(dx*dot(se,north)+dy*dot(sn,north));lift+=core*0.65;if(properties.w<0.5){float eye=1.0-smoothstep(0.08,0.18,r),wall=exp(-pow(abs((r-0.24)/0.11),2.0));subsidence+=eye*properties.z*0.3;lift+=(wall*0.7-eye*0.8)*properties.z;}
  }
  float drag=1.0/14400.0,coriolis=12.566370614359172/86400.0*rotationScale*sin(latitude),balance=drag*drag+coriolis*coriolis,forceEast=-gradientEast*4000.0/(radiusMeters*1.2),forceNorth=-gradientNorth*4000.0/(radiusMeters*1.2);
  vec2 wind=vec2(drag*forceEast+coriolis*forceNorth,drag*forceNorth-coriolis*forceEast)/balance;float rawSpeed=length(wind);wind*=min(1.0,100.0/max(0.000000001,rawSpeed));float speed=length(wind);
  float age=21600.0+7200.0*sin(timeDays*0.31),flowAngle=speed*(timeDays*86400.0+age)/radiusMeters;vec3 trace=normalize(direction*cos(flowAngle)-(east*wind.x+north*wind.y)/max(0.000000001,speed)*sin(flowAngle));vec4 advected=planetWeatherRead(coverageTexture,trace,timeDays,radiusMeters);
  float solar=dot(sunDirection,direction),hour=atan(-dot(sunDirection,east),solar),afternoon=smoothstep(-0.15,0.4,hour)*(1.0-smoothstep(1.2,1.8,hour))*smoothstep(-0.12,0.15,solar);
  vec2 thermal=vec2(planetWeatherRead(coverageTexture,normalize(trace+east*0.025),timeDays,radiusMeters).b-advected.b,planetWeatherRead(coverageTexture,normalize(trace+north*0.025),timeDays,radiusMeters).b-advected.b)/0.025;float thermalGradient=length(thermal),transport=dot(wind,thermal)/max(1.0,speed*thermalGradient),front=smoothstep(0.2,1.2,thermalGradient)*smoothstep(1.0,12.0,speed),coldFront=front*clamp(-transport,0.0,1.0),warmFront=front*clamp(transport,0.0,1.0);
  float orographicLift=dot((environment.gb-vec2(128.0/255.0))*2.0,wind)/max(5.0,speed),terrainLift=max(0.0,orographicLift)*0.7+min(0.0,orographicLift)*0.55;
  lift+=terrainLift+field.a*afternoon*0.35+coldFront*0.8+warmFront*0.5;
  float humidity=clamp(advected.r-subsidence,0.0,1.0),score=humidity-(0.55+0.045*(advected.b-0.5)-clamp(lift,-1.0,2.0)*0.19+max(0.0,pressure)*0.20);
  float track=smoothstep(30.0,39.0,degrees)*(1.0-smoothstep(60.0,70.0,degrees)),polar=smoothstep(65.0,78.0,degrees),itcz=exp(-pow(abs(latitude*57.29577951308232/12.0),2.0)),coastal=environment.a*(1.0-smoothstep(45.0,55.0,degrees));
  float cells=coastal>0.01?planetWeatherCells(vec2(atan(trace.x,trace.z)/6.283185307179586+0.5,asin(clamp(trace.y,-1.0,1.0))/3.141592653589793+0.5)):1.0;
  vec3 weights=vec3(clamp(0.24+polar*0.65+coastal*0.6+warmFront*0.35-coldFront*0.10,0.0,1.0)*(0.3+0.7*cells),clamp(0.30+itcz*0.62+lift*0.28+coldFront*0.45-polar*0.25,0.0,1.0),clamp(0.18+track*0.65+warmFront*0.25+coldFront*0.2,0.0,1.0));
  float support=coverageGain<=0.0||humidity<=0.0?0.0:smoothstep(condensationThreshold,condensationThreshold+0.065,score);
  return PlanetWeatherState(clamp(weights*support*coverageGain,0.0,1.0),trace,support,1013.25+pressure*40.0,humidity<=0.0?0.0:clamp(1.0+(score-condensationThreshold)*0.8,0.0,1.0),wind,coldFront,warmFront);
}
vec3 planetWeatherCoverage(sampler2D coverageTexture,sampler2D environmentTexture,vec3 direction,vec3 sunDirection,float timeDays,vec4 stormCenters[16],vec4 stormProperties[16],int stormCount,float coverageGain,float rotationScale,float condensationThreshold,float radiusMeters){return planetWeatherState(coverageTexture,environmentTexture,direction,sunDirection,timeDays,stormCenters,stormProperties,stormCount,coverageGain,rotationScale,condensationThreshold,radiusMeters).coverage;}
`;
export const planetWeatherCoverageWGSL=/* wgsl */`
struct PlanetWeatherState { coverage:vec3<f32>, flowDirection:vec3<f32>, support:f32, pressure:f32, humidity:f32, wind:vec2<f32>, coldFront:f32, warmFront:f32 };
fn planetWeatherCells(inputUV:vec2<f32>)->f32{
  let uv=vec2<f32>(fract(inputUV.x),inputUV.y);let q=uv*vec2<f32>(512.0,256.0);let base=vec2<i32>(floor(q));var nearest=1000000.0;var second=1000000.0;
  for(var y:i32=-1;y<=1;y++){for(var x:i32=-1;x<=1;x++){let cell=base+vec2<i32>(x,y);var h=(u32(cell.x&511)*374761393u)^(u32(cell.y)*668265263u);h=(h^(h>>13u))*1274126177u;h=h^(h>>16u);let jitter=vec2<f32>(f32(h&65535u),f32(h>>16u))/65535.0;let delta=vec2<f32>(cell)+jitter-q;let distance=dot(delta,delta);if(distance<nearest){second=nearest;nearest=distance;}else if(distance<second){second=distance;}}}
  let edge=1.0-smoothstep(0.03,0.18,sqrt(second)-sqrt(nearest));let closed=0.5+0.5*sin(uv.x*6.283185307179586*3.0+(uv.y-0.5)*3.141592653589793*9.0);return mix(0.18+0.82*edge,1.0-0.45*edge,closed);
}
fn planetWeatherRead(fieldTexture:texture_2d<f32>,weatherSampler:sampler,p:vec3<f32>,timeDays:f32,radiusMeters:f32)->vec4<f32>{
  let latitude=asin(clamp(p.y,-1.0,1.0));
  return textureSampleLevel(fieldTexture,weatherSampler,vec2<f32>(fract(atan2(p.x,p.z)/6.283185307179586+0.5),latitude/3.141592653589793+0.5),0.0);
}
fn planetWeatherState(coverageTexture:texture_2d<f32>,environmentTexture:texture_2d<f32>,weatherSampler:sampler,direction:vec3<f32>,sunDirection:vec3<f32>,timeDays:f32,stormCenters:array<vec4<f32>,16>,stormProperties:array<vec4<f32>,16>,stormCount:i32,coverageGain:f32,rotationScale:f32,condensationThreshold:f32,radiusMeters:f32)->PlanetWeatherState{
  let latitude=asin(clamp(direction.y,-1.0,1.0));let longitude=atan2(direction.x,direction.z);let degrees=abs(latitude)*57.29577951308232;
  let uv=vec2<f32>(longitude/6.283185307179586+0.5,latitude/3.141592653589793+0.5);let east=vec3<f32>(cos(longitude),0.0,-sin(longitude));let north=cross(direction,east);
  let field=planetWeatherRead(coverageTexture,weatherSampler,direction,timeDays,radiusMeters);let fieldEast=planetWeatherRead(coverageTexture,weatherSampler,normalize(direction+east*0.025),timeDays,radiusMeters);let fieldNorth=planetWeatherRead(coverageTexture,weatherSampler,normalize(direction+north*0.025),timeDays,radiusMeters);let environment=textureSampleLevel(environmentTexture,weatherSampler,uv,0.0);
  var pressure=field.g-128.0/255.0;var gradientEast=(fieldEast.g-field.g)/0.025;var gradientNorth=(fieldNorth.g-field.g)/0.025;var lift=0.0;var subsidence=0.0;
  for(var index:i32=0;index<16;index++){if(index>=stormCount){break;}let center=stormCenters[index];let properties=stormProperties[index];if(dot(direction,center.xyz)<cos(center.w*2.2)){continue;}
    let se=normalize(cross(vec3<f32>(0.0,1.0,0.0),center.xyz));let sn=cross(center.xyz,se);let x=dot(direction,se)/center.w;let y=dot(direction,sn)/center.w;let r=length(vec2<f32>(x,y));let ellipticity=select(1.12,1.8,properties.w>0.5);let angle=properties.y*0.15;let c=cos(angle);let s=sin(angle);let rx=c*x+s*y;let ry=(-s*x+c*y)*ellipticity;let q=rx*rx+ry*ry;
    let envelope=(1.0-smoothstep(1.8,2.2,r))*properties.z;let core=exp(-q*1.4)*envelope;let dx=(c*rx-s*ry*ellipticity)*2.8*core/center.w;let dy=(s*rx+c*ry*ellipticity)*2.8*core/center.w;
    pressure-=core*0.65;gradientEast+=0.65*(dx*dot(se,east)+dy*dot(sn,east));gradientNorth+=0.65*(dx*dot(se,north)+dy*dot(sn,north));lift+=core*0.65;if(properties.w<0.5){let eye=1.0-smoothstep(0.08,0.18,r);let wall=exp(-pow(abs((r-0.24)/0.11),2.0));subsidence+=eye*properties.z*0.3;lift+=(wall*0.7-eye*0.8)*properties.z;}
  }
  let drag=1.0/14400.0;let coriolis=12.566370614359172/86400.0*rotationScale*sin(latitude);let balance=drag*drag+coriolis*coriolis;let forceEast=-gradientEast*4000.0/(radiusMeters*1.2);let forceNorth=-gradientNorth*4000.0/(radiusMeters*1.2);
  var wind=vec2<f32>(drag*forceEast+coriolis*forceNorth,drag*forceNorth-coriolis*forceEast)/balance;let rawSpeed=length(wind);wind*=min(1.0,100.0/max(0.000000001,rawSpeed));let speed=length(wind);
  let age=21600.0+7200.0*sin(timeDays*0.31);let flowAngle=speed*(timeDays*86400.0+age)/radiusMeters;let trace=normalize(direction*cos(flowAngle)-(east*wind.x+north*wind.y)/max(0.000000001,speed)*sin(flowAngle));let advected=planetWeatherRead(coverageTexture,weatherSampler,trace,timeDays,radiusMeters);
  let solar=dot(sunDirection,direction);let hour=atan2(-dot(sunDirection,east),solar);let afternoon=smoothstep(-0.15,0.4,hour)*(1.0-smoothstep(1.2,1.8,hour))*smoothstep(-0.12,0.15,solar);
  let thermal=vec2<f32>(planetWeatherRead(coverageTexture,weatherSampler,normalize(trace+east*0.025),timeDays,radiusMeters).b-advected.b,planetWeatherRead(coverageTexture,weatherSampler,normalize(trace+north*0.025),timeDays,radiusMeters).b-advected.b)/0.025;let thermalGradient=length(thermal);let transport=dot(wind,thermal)/max(1.0,speed*thermalGradient);let front=smoothstep(0.2,1.2,thermalGradient)*smoothstep(1.0,12.0,speed);let coldFront=front*clamp(-transport,0.0,1.0);let warmFront=front*clamp(transport,0.0,1.0);
  let orographicLift=dot((environment.gb-vec2<f32>(128.0/255.0))*2.0,wind)/max(5.0,speed);let terrainLift=max(0.0,orographicLift)*0.7+min(0.0,orographicLift)*0.55;
  lift+=terrainLift+field.a*afternoon*0.35+coldFront*0.8+warmFront*0.5;
  let humidity=clamp(advected.r-subsidence,0.0,1.0);let score=humidity-(0.55+0.045*(advected.b-0.5)-clamp(lift,-1.0,2.0)*0.19+max(0.0,pressure)*0.20);
  let track=smoothstep(30.0,39.0,degrees)*(1.0-smoothstep(60.0,70.0,degrees));let polar=smoothstep(65.0,78.0,degrees);let itcz=exp(-pow(abs(latitude*57.29577951308232/12.0),2.0));let coastal=environment.a*(1.0-smoothstep(45.0,55.0,degrees));
  var cells=1.0;if(coastal>0.01){cells=planetWeatherCells(vec2<f32>(atan2(trace.x,trace.z)/6.283185307179586+0.5,asin(clamp(trace.y,-1.0,1.0))/3.141592653589793+0.5));}
  let weights=vec3<f32>(clamp(0.24+polar*0.65+coastal*0.6+warmFront*0.35-coldFront*0.10,0.0,1.0)*(0.3+0.7*cells),clamp(0.30+itcz*0.62+lift*0.28+coldFront*0.45-polar*0.25,0.0,1.0),clamp(0.18+track*0.65+warmFront*0.25+coldFront*0.2,0.0,1.0));
  var support=0.0;if(coverageGain>0.0&&humidity>0.0){support=smoothstep(condensationThreshold,condensationThreshold+0.065,score);}
  return PlanetWeatherState(clamp(weights*support*coverageGain,vec3<f32>(0.0),vec3<f32>(1.0)),trace,support,1013.25+pressure*40.0,select(clamp(1.0+(score-condensationThreshold)*0.8,0.0,1.0),0.0,humidity<=0.0),wind,coldFront,warmFront);
}
fn planetWeatherCoverage(coverageTexture:texture_2d<f32>,environmentTexture:texture_2d<f32>,weatherSampler:sampler,direction:vec3<f32>,sunDirection:vec3<f32>,timeDays:f32,stormCenters:array<vec4<f32>,16>,stormProperties:array<vec4<f32>,16>,stormCount:i32,coverageGain:f32,rotationScale:f32,condensationThreshold:f32,radiusMeters:f32)->vec3<f32>{return planetWeatherState(coverageTexture,environmentTexture,weatherSampler,direction,sunDirection,timeDays,stormCenters,stormProperties,stormCount,coverageGain,rotationScale,condensationThreshold,radiusMeters).coverage;}
`;
