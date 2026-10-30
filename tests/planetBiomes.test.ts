import {describe,expect,it} from 'vitest';
import {compilePlanet,type CompiledPlanet,type PlanetVector} from '../src/shared/planet.ts';
import {compilePlanetBiomes,createPlanetBiomeRecipe,type PlanetBiomeRecipe} from '../src/shared/planetBiomes.ts';

function planet(height=500):CompiledPlanet{return compilePlanet({kind:'planet',version:1,seed:42,radiusMeters:6371000,seaLevelMeters:0,surface:{maps:{kind:'generation-maps',version:1,seed:42,maps:{height:{type:'constant',value:height,unit:'metres'}}},height:'height'}});}
function recipe(moisture=.8):PlanetBiomeRecipe{return{...createPlanetBiomeRecipe(),fields:{kind:'generation-maps',version:1,seed:42,maps:{temperature:{type:'constant',value:.5,unit:'normalized'},moisture:{type:'constant',value:moisture,unit:'normalized'}}}};}
const direction=(latitude:number):PlanetVector=>[Math.cos(latitude),Math.sin(latitude),0];
describe('global planet climate fields',()=>{
  it('uses the same immutable deterministic field independent of order, normalized direction and render origin',()=>{
    const source=planet(),a=compilePlanetBiomes(source,createPlanetBiomeRecipe()),b=compilePlanetBiomes(source,createPlanetBiomeRecipe()),points=[[1,.2,.3],[-.5,.4,.8],[0,1,0],[0,-1,0]] as const;
    const expected=points.map(p=>a.sample(p));expect([...points].reverse().map(p=>b.sample(p)).reverse()).toEqual(expected);expect(a.sample([2,.4,.6])).toEqual(a.sample([1,.2,.3]));expect(a.revision).toBe(b.revision);expect(Object.isFrozen(a.recipe.fields)).toBe(true);
  });
  it('changes from tropical to conifer to tundra with latitude and gates shoreline/snow populations',()=>{
    const climate=compilePlanetBiomes(planet(),recipe());expect(climate.sample(direction(0)).id).toBe('tropical-forest');expect(climate.sample(direction(.5)).id).toBe('taiga');expect(climate.sample(direction(1.3)).id).toBe('tundra');
    for(const height of [-20,0,4,4500]){const sample=compilePlanetBiomes(planet(height),recipe()).sample([1,0,0]);expect(sample.treeDensity).toBe(0);expect(sample.buildingSuitability).toBe(0);expect(sample.forestFamily).toBe('none');}
    const desert=compilePlanetBiomes(planet(),recipe(.1)).sample([1,0,0]);expect(desert.id).toBe('desert');expect(desert.treeDensity).toBe(0);
  });
  it('blocks cliffs and honors density controls without affecting identity or climate',()=>{
    const original=planet(),cliff:CompiledPlanet={...original,sample(d){const sample=original.sample(d);return{...sample,normal:[.5,Math.sqrt(.75),0]};}},sample=compilePlanetBiomes(cliff,recipe()).sample([1,0,0]);expect(sample.slope).toBeCloseTo(60,6);expect(sample.treeDensity).toBe(0);expect(sample.buildingSuitability).toBe(0);
    const normal=compilePlanetBiomes(original,recipe()).sample([1,0,0]),disabled=compilePlanetBiomes(original,{...recipe(),forestDensity:0,settlementDensity:0}).sample([1,0,0]);expect(disabled.treeDensity).toBe(0);expect(disabled.buildingSuitability).toBe(0);expect(disabled.id).toBe(normal.id);expect(disabled.temperature).toBe(normal.temperature);
  });
  it('rejects executable, dynamic, identity-scoped and dimensional climate data before sampling',()=>{
    const source=planet();for(const node of [{type:'time',periodSeconds:3},{type:'random',scope:'object'},{type:'noise',space:'object',scaleMeters:100},{type:'constant',value:2,unit:'metres'}]){const input=recipe();input.fields.maps.temperature=node as never;expect(()=>compilePlanetBiomes(source,input)).toThrow();}
    let invoked=0;const input=recipe();Object.defineProperty(input,'forestDensity',{enumerable:true,get(){invoked++;return 1;}});expect(()=>compilePlanetBiomes(source,input)).toThrow(/accessor/);expect(invoked).toBe(0);expect(()=>compilePlanetBiomes(source,{...recipe(),settlementDensity:Infinity})).toThrow();
  });
});
