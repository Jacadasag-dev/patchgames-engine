import {describe,expect,it} from 'vitest';
import {compilePlanet,createPlanetRecipe,type PlanetVector} from '../src/shared/planet.ts';
import {compilePlanetWeather,createPlanetWeatherRecipe,planetWeatherZonalWind} from '../src/shared/planetWeather.ts';

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
    const planet=compilePlanet(createPlanetRecipe(412)),weather=compilePlanetWeather({...createPlanetWeatherRecipe(73),resolution:128},planet.radius,planet),points=[direction(.1,Math.PI-1e-8),direction(.1,-Math.PI+1e-8),[0,1,0],[0,-1,0],direction(.55,2)] as [number,number,number][],before=points.map(p=>weather.sample(p,12345,[1,0,0])),bake=weather.bake();
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
  it('uses afternoon land heating as lift only when moisture can condense',()=>{
    for(const height of [-1000,1000]){const planet=flat(height),weather=compilePlanetWeather({...createPlanetWeatherRecipe(42),cycloneCount:0,resolution:128},planet.radius,planet);let increase=0;
      for(let i=0;i<64;i++){const point=direction((i%8)*7*DEG,i/64*Math.PI*2),east:PlanetVector=[Math.cos(i/64*Math.PI*2),0,-Math.sin(i/64*Math.PI*2)],morning=point.map((n,j)=>n*Math.cos(.7)+east[j]*Math.sin(.7)) as [number,number,number],afternoon=point.map((n,j)=>n*Math.cos(.7)-east[j]*Math.sin(.7)) as [number,number,number],am=weather.sample(point,0,morning),pm=weather.sample(point,0,afternoon);increase=Math.max(increase,pm.cumulus-am.cumulus);expect(pm.cumulus).toBeGreaterThanOrEqual(am.cumulus);}
      if(height>0)expect(increase).toBeGreaterThan(.05);else expect(increase).toBe(0);
    }
  });
  it('places mountain lift on the windward slope and rain shadow on the lee side',()=>{
    const center=direction(45*DEG),planet=compilePlanet({kind:'planet',version:1,seed:42,radiusMeters:6371000,surface:{height:'height',maps:{kind:'generation-maps',version:1,seed:42,maps:{mountain:{type:'distance',space:'world',center:center.map(v=>v*6371000) as [number,number,number],radiusMeters:1000000},height:{type:'remap',input:'mountain',from:[0,1],to:[0,4000],unit:'metres'}}}}}),weather=compilePlanetWeather({...createPlanetWeatherRecipe(42),cycloneCount:0},planet.radius,planet),west=weather.sample(direction(45*DEG,-.07)),east=weather.sample(direction(45*DEG,.07));
    for(const [sample,side] of [[west,-1],[east,1]] as const){const uphill=sample.windEastMetersPerSecond*side<0;expect(uphill?sample.windward:sample.rainShadow).toBeGreaterThan(.1);expect(uphill?sample.rainShadow:sample.windward).toBe(0);}
    const still=compilePlanetWeather({...createPlanetWeatherRecipe(42),cycloneCount:0,resolution:128,pressureStrength:0},planet.radius,planet);for(const point of [direction(45*DEG,-.07),direction(45*DEG,.07)]){const sample=still.sample(point);expect(sample.windward+sample.rainShadow).toBeLessThan(1e-10);}
  });
  it('keeps clouds exactly absent outside shared support, including completely dry moving air',()=>{
    const recipe={...createPlanetWeatherRecipe(73),resolution:128 as const},weather=compilePlanetWeather(recipe,6371000),dry=compilePlanetWeather({...recipe,moisture:0},6371000);let clear=0,moving=0;
    for(let i=0;i<256;i++){const p=direction(Math.asin(1-2*(i+.5)/256),i*Math.PI*(3-Math.sqrt(5))),a=weather.sample(p),b=dry.sample(p,3600);if(a.support===0){clear++;expect(a.low+a.cumulus+a.cirrus+a.condensation).toBe(0);}expect(b.support+b.low+b.cumulus+b.cirrus+b.relativeHumidity+b.condensation).toBe(0);moving=Math.max(moving,Math.hypot(b.windEastMetersPerSecond,b.windNorthMetersPerSecond));}
    expect(clear).toBeGreaterThan(40);expect(moving).toBeGreaterThan(1);
  });
  it('couples pressure to bounded wind, condensation and material transport',()=>{
    const recipe={...createPlanetWeatherRecipe(73),resolution:128 as const,cycloneCount:0},weather=compilePlanetWeather(recipe,6371000),still=compilePlanetWeather({...recipe,pressureStrength:0},6371000);let transport=0,condensation=0;
    for(let i=0;i<128;i++){const p=direction(Math.asin(1-2*(i+.5)/128),i*2.4),a=weather.sample(p),b=weather.sample(p,3600),off=still.sample(p),offLater=still.sample(p,3600);expect(Math.hypot(a.windEastMetersPerSecond,a.windNorthMetersPerSecond)).toBeLessThanOrEqual(100.000001);expect(Math.hypot(off.windEastMetersPerSecond,off.windNorthMetersPerSecond)).toBeLessThan(1e-8);expect(off.pressureHectopascals).toBeCloseTo(1013.25,10);expect(offLater.support).toBeCloseTo(off.support,8);transport=Math.max(transport,Math.hypot(...a.flowDirection.map((n,j)=>n-b.flowDirection[j])));condensation+=Math.abs(a.condensation-off.condensation);}
    expect(transport).toBeGreaterThan(.001);expect(condensation).toBeGreaterThan(.01);expect(still.condensationThreshold).toBe(weather.condensationThreshold);
  });
  it('has inward low pressure flow with opposite Coriolis turning in the two hemispheres',()=>{
    const recipe={...createPlanetWeatherRecipe(73),resolution:128 as const},weather=compilePlanetWeather(recipe,6371000),background=compilePlanetWeather({...recipe,cycloneCount:0},6371000);
    for(const spin of [-1,1]){let checked=false;for(let day=0;day<24&&!checked;day++){const t=day*86400,storm=weather.frame(t).cyclones.find(s=>s.type==='tropical'&&s.spin===spin&&s.strength>.7);if(!storm)continue;const lon=Math.atan2(storm.center[0],storm.center[2]),east:PlanetVector=[Math.cos(lon),0,-Math.sin(lon)],p=storm.center.map((n,j)=>n+east[j]*storm.angularRadius*.5) as [number,number,number],a=weather.sample(p,t),b=background.sample(p,t);expect(a.windEastMetersPerSecond-b.windEastMetersPerSecond).toBeLessThan(-1);expect((a.windNorthMetersPerSecond-b.windNorthMetersPerSecond)*spin).toBeGreaterThan(1);checked=true;}expect(checked).toBe(true);}
  });
  it('derives warm and cold frontal cloud forms from advected thermal gradients',()=>{
    const weather=compilePlanetWeather({...createPlanetWeatherRecipe(73),resolution:128},6371000);let cold=0,warm=0,coldClouds=0,warmClouds=0,evolution=0;
    for(let i=0;i<512;i++){const p=direction(Math.asin(1-2*(i+.5)/512),i*2.399963229728653),a=weather.sample(p),b=weather.sample(p,86400);if(a.coldFront>.1){cold++;if(a.cumulus>0)coldClouds++;}if(a.warmFront>.1){warm++;if(a.cirrus>0&&a.low>0)warmClouds++;}evolution+=Math.abs(a.support-b.support)/512;}
    expect(cold).toBeGreaterThan(10);expect(warm).toBeGreaterThan(10);expect(coldClouds).toBeGreaterThan(5);expect(warmClouds).toBeGreaterThan(5);expect(evolution).toBeGreaterThan(.02);
  });
  it('uses the physical rotation period in the drag/Coriolis balance and remains continuous in time',()=>{
    const recipe={...createPlanetWeatherRecipe(73),resolution:128 as const},normal=compilePlanetWeather(recipe,6371000),fast=compilePlanetWeather({...recipe,rotationPeriodSeconds:43200},6371000);let response=0;
    expect(normal.frame().rotationScale).toBe(1);expect(fast.frame().rotationScale).toBe(2);
    for(let i=0;i<32;i++){const p=direction((i/32-.5)*Math.PI,i*2.4),a=normal.sample(p,12345),b=normal.sample(p,12345.001),f=fast.sample(p,12345);response+=Math.abs(a.windEastMetersPerSecond-f.windEastMetersPerSecond)+Math.abs(a.windNorthMetersPerSecond-f.windNorthMetersPerSecond);expect(Math.abs(a.support-b.support)).toBeLessThan(.001);expect(Math.hypot(...a.flowDirection.map((n,j)=>n-b.flowDirection[j]))).toBeLessThan(.001);}
    expect(response).toBeGreaterThan(1);expect(compilePlanetWeather({...recipe,rotationPeriodSeconds:10},6371000).frame().rotationScale).toBe(8640);expect(compilePlanetWeather({...recipe,rotationPeriodSeconds:1e9},6371000).frame().rotationScale).toBeCloseTo(.0000864,12);
  });
  it('keeps deterministic actual surface/weather revisions and bounded fixed storage',()=>{
    const recipe={...createPlanetWeatherRecipe(73),resolution:128 as const},a=compilePlanetWeather(recipe,6371000),same=compilePlanetWeather(recipe,6371000),changed=compilePlanetWeather({...recipe,moisture:.8},6371000),terrain=compilePlanetWeather(recipe,6371000,flat(1000));expect(same.revision).toBe(a.revision);expect(same.condensationThreshold).toBe(a.condensationThreshold);expect(same.sample([1,0,0])).toEqual(a.sample([1,0,0]));expect(changed.revision).not.toBe(a.revision);expect(terrain.revision).not.toBe(a.revision);expect(a.frame().cyclones.length).toBeLessThanOrEqual(16);const bake=a.bake();expect(bake.coverage.data.byteLength+bake.environment.data.byteLength).toBe(128*64*8);expect(bake.referenceTimeSeconds).toBe(0);expect(bake.referenceSunDirection).toEqual([1,0,0]);expect(bake.condensationThreshold).toBe(a.condensationThreshold);
  });
  it('rejects executable/unbounded recipe input before accessors execute',()=>{
    const input=createPlanetWeatherRecipe();let invoked=0;Object.defineProperty(input,'coverageTarget',{enumerable:true,get(){invoked++;return .5;}});expect(()=>compilePlanetWeather(input,6371000)).toThrow(/accessor/);expect(invoked).toBe(0);
    expect(()=>compilePlanetWeather({...createPlanetWeatherRecipe(),cycloneCount:17},6371000)).toThrow();expect(()=>compilePlanetWeather({...createPlanetWeatherRecipe(),resolution:1024 as never},6371000)).toThrow();expect(()=>compilePlanetWeather(createPlanetWeatherRecipe(),100)).toThrow();
  });
});
