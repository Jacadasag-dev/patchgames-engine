import {describe,expect,it} from 'vitest';
import {compilePlanet,createPlanetRecipe,type PlanetVector} from '../src/shared/planet.ts';
import {compilePlanetWeather,createPlanetWeatherRecipe,planetWeatherZonalWind,samplePlanetWeatherStorm,type PlanetWeatherCyclone} from '../src/shared/planetWeather.ts';

const DEG=Math.PI/180;
const direction=(lat:number,lon=0):PlanetVector=>[Math.sin(lon)*Math.cos(lat),Math.sin(lat),Math.cos(lon)*Math.cos(lat)];
function flat(height:number){return compilePlanet({kind:'planet',version:1,seed:42,radiusMeters:6371000,surface:{height:'height',maps:{kind:'generation-maps',version:1,seed:42,maps:{height:{type:'constant',value:height,unit:'metres'}}}}});}
describe('deterministic planet circulation',()=>{
  it('steers trades west, storm tracks east and polar easterlies west continuously in both hemispheres',()=>{
    for(const sign of [-1,1]){expect(planetWeatherZonalWind(sign*10*DEG)).toBeLessThan(0);expect(planetWeatherZonalWind(sign*47*DEG)).toBeGreaterThan(0);expect(planetWeatherZonalWind(sign*80*DEG)).toBeLessThan(0);}
    expect(planetWeatherZonalWind(35*DEG)).toBeCloseTo(planetWeatherZonalWind(-35*DEG),12);
    expect(Math.abs(planetWeatherZonalWind(38*DEG)-planetWeatherZonalWind((38-1e-6)*DEG))).toBeLessThan(1e-8);
  });
  it('keeps tropical cyclones away from the equator and gives each hemisphere the correct spin',()=>{
    const weather=compilePlanetWeather(createPlanetWeatherRecipe(73),6371000);
    for(const t of [0,86400,86400*12,86400*23,86400*100,-86400*5]){
      const frame=weather.frame(t);expect(frame.cyclones.length).toBe(8);expect(frame.timeDays).toBe(t/86400);
      for(const storm of frame.cyclones){expect(Math.hypot(...storm.center)).toBeCloseTo(1,12);expect(storm.strength).toBeGreaterThanOrEqual(0);expect(storm.strength).toBeLessThanOrEqual(1);expect(Math.sign(storm.center[1])).toBe(storm.spin);if(storm.type==='tropical')expect(Math.abs(Math.asin(storm.center[1]))/DEG).toBeGreaterThanOrEqual(5);}
    }
    // Find the active early tropical phase without relying on a private seed
    // hash, then verify physical westward/poleward steering across two days.
    let checked=false;
    for(let day=0;day<24;day++){const a=weather.frame(day*86400).cyclones[0],b=weather.frame((day+1)*86400).cyclones[0],latA=Math.abs(Math.asin(a.center[1]))/DEG,latB=Math.abs(Math.asin(b.center[1]))/DEG,delta=Math.atan2(Math.sin(Math.atan2(b.center[0],b.center[2])-Math.atan2(a.center[0],a.center[2])),Math.cos(Math.atan2(b.center[0],b.center[2])-Math.atan2(a.center[0],a.center[2])));if(latA<18&&b.strength>.1&&latB>latA){expect(delta).toBeLessThan(0);checked=true;break;}}
    expect(checked).toBe(true);
  });
  it('does not generate tropical storms over an all-land surface',()=>{
    const planet=flat(1000),weather=compilePlanetWeather(createPlanetWeatherRecipe(73),planet.radius,planet);expect(weather.frame().cyclones.every(storm=>storm.type==='frontal')).toBe(true);
  });
  it('retains exact point/bake parity, stable seams and poles without mutating transferable atlas copies',()=>{
    const planet=compilePlanet(createPlanetRecipe(412)),weather=compilePlanetWeather({...createPlanetWeatherRecipe(73),resolution:128},planet.radius,planet),points=[direction(.1,Math.PI-1e-8),direction(.1,-Math.PI+1e-8),[0,1,0],[0,-1,0],direction(.55,2)] as PlanetVector[],before=points.map(p=>weather.sample(p,12345,[1,0,0])),bake=weather.bake();
    points.forEach((point,i)=>expect(weather.sample(point,12345,[1,0,0])).toEqual(before[i]));expect(before[0].coverage).toBeCloseTo(before[1].coverage,6);
    for(const atlas of [bake.coverage,bake.environment]){for(const row of [0,atlas.height-1])for(let x=1;x<atlas.width;x++)expect([...atlas.data.subarray((row*atlas.width+x)*4,(row*atlas.width+x)*4+4)]).toEqual([...atlas.data.subarray(row*atlas.width*4,row*atlas.width*4+4)]);atlas.data.fill(0);}
    expect(weather.sample(points[4],12345,[1,0,0])).toEqual(before[4]);expect(weather.bake().coverage.data.some(v=>v!==0)).toBe(true);
  });
  it('measures Earth-like static coverage separately from optical opacity and preserves latitude regimes',()=>{
    const planet=compilePlanet(createPlanetRecipe(412));
    for(const seed of [42,73,412]){const weather=compilePlanetWeather(createPlanetWeatherRecipe(seed),planet.radius,planet),bake=weather.bake();expect(bake.achievedCoverage).toBeGreaterThan(.65);expect(bake.achievedCoverage).toBeLessThan(.70);expect(bake.metric).toContain('not rendered optical');expect(bake.coverage.data.byteLength+bake.environment.data.byteLength).toBe(512*256*8);
      const mean=(latitude:number)=>{let cumulus=0,cirrus=0,low=0;for(let i=0;i<128;i++){const sample=weather.sample(direction(latitude*DEG,i/128*Math.PI*2),0,[0,1,0]);cumulus+=sample.cumulus/128;cirrus+=sample.cirrus/128;low+=sample.low/128;}return{cumulus,cirrus,low};};
      const equator=mean(0),subtropics=mean(27),stormTrack=mean(48),pole=mean(80);expect(equator.cumulus).toBeGreaterThan(subtropics.cumulus+.2);expect(stormTrack.cirrus).toBeGreaterThan(subtropics.cirrus+.2);expect(pole.cumulus).toBeLessThan(equator.cumulus);expect(pole.low).toBeGreaterThan(subtropics.low);
      const ocean=compilePlanetWeather(createPlanetWeatherRecipe(seed),planet.radius).bake();expect(ocean.achievedCoverage).toBeGreaterThan(.65);expect(ocean.achievedCoverage).toBeLessThan(.70);
    }
  });
  it('honors zero cover even with terrain lift, afternoon heating and storm defaults enabled',()=>{
    const planet=flat(1000),weather=compilePlanetWeather({...createPlanetWeatherRecipe(),coverageTarget:0,resolution:128},planet.radius,planet);expect(weather.sample([0,0,1],123,[1,0,1]).coverage).toBe(0);expect(weather.frame().cyclones).toEqual([]);expect(weather.bake().coverageGain).toBe(0);expect(weather.bake().achievedCoverage).toBe(0);
  });
  it('adds afternoon land convection while leaving ocean daily heating alone',()=>{
    const point=direction(27*DEG),morning:PlanetVector=[Math.sin(.7),point[1]*Math.cos(.7),point[2]*Math.cos(.7)],afternoon:PlanetVector=[-Math.sin(.7),point[1]*Math.cos(.7),point[2]*Math.cos(.7)];
    for(const height of [-1000,1000]){const planet=flat(height),weather=compilePlanetWeather({...createPlanetWeatherRecipe(42),cycloneCount:0,resolution:128},planet.radius,planet),am=weather.sample(point,0,morning),pm=weather.sample(point,0,afternoon);if(height>0)expect(pm.cumulus).toBeGreaterThan(am.cumulus+.25);else expect(pm.cumulus).toBe(am.cumulus);}
  });
  it('places mountain lift on the windward slope and rain shadow on the lee side',()=>{
    const center=direction(45*DEG),planet=compilePlanet({kind:'planet',version:1,seed:42,radiusMeters:6371000,surface:{height:'height',maps:{kind:'generation-maps',version:1,seed:42,maps:{mountain:{type:'distance',space:'world',center:center.map(v=>v*6371000) as [number,number,number],radiusMeters:1000000},height:{type:'remap',input:'mountain',from:[0,1],to:[0,4000],unit:'metres'}}}}}),weather=compilePlanetWeather({...createPlanetWeatherRecipe(42),cycloneCount:0},planet.radius,planet),west=weather.sample(direction(45*DEG,-.07)),east=weather.sample(direction(45*DEG,.07));
    expect(west.windEastMetersPerSecond).toBeGreaterThan(0);expect(west.windward).toBeGreaterThan(.3);expect(west.rainShadow).toBe(0);expect(east.rainShadow).toBeGreaterThan(.3);expect(east.windward).toBe(0);
  });
  it('rotates frontal cloud heads as well as tropical spiral arms',()=>{
    const up=direction(45*DEG),north:PlanetVector=[0,Math.cos(45*DEG),-Math.sin(45*DEG)],storm:PlanetWeatherCyclone={center:up,angularRadius:.2,spin:1,phase:0,strength:1,type:'frontal'},point=up.map((v,i)=>v+([1,0,0][i]*-.14+north[i]*.12)*storm.angularRadius) as [number,number,number];
    const a=samplePlanetWeatherStorm(point,storm),b=samplePlanetWeatherStorm(point,{...storm,phase:Math.PI});expect(Math.abs(a[0]-b[0])).toBeGreaterThan(.1);
  });
  it('rejects executable/unbounded recipe input before accessors execute',()=>{
    const input=createPlanetWeatherRecipe();let invoked=0;Object.defineProperty(input,'coverageTarget',{enumerable:true,get(){invoked++;return .5;}});expect(()=>compilePlanetWeather(input,6371000)).toThrow(/accessor/);expect(invoked).toBe(0);
    expect(()=>compilePlanetWeather({...createPlanetWeatherRecipe(),cycloneCount:17},6371000)).toThrow();expect(()=>compilePlanetWeather({...createPlanetWeatherRecipe(),resolution:1024 as never},6371000)).toThrow();expect(()=>compilePlanetWeather(createPlanetWeatherRecipe(),100)).toThrow();
  });
});
