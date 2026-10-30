import {expect,it} from 'vitest';
import {compilePlanet,createPlanetRecipe,planetDirection,planetTileKey,type PlanetTile,type PlanetVector} from '../src/shared/planet.ts';
import {planPlanetTiles,type PlanetLodFrame} from '../src/shared/planetLod.ts';

const earth=()=>compilePlanet({...createPlanetRecipe(17,6371000),segments:16,maxLevel:24});
const frame=(position:PlanetVector):PlanetLodFrame=>({position,viewportHeight:900,fovDegrees:60});
const coversGlobe=(tiles:readonly PlanetTile[])=>{
  expect(new Set(tiles.map(planetTileKey)).size).toBe(tiles.length);
  for(let face=0;face<6;face++)expect(tiles.filter(t=>t.face===face).reduce((area,t)=>area+4**-t.level,0)).toBeCloseTo(1,12);
  // Equality of area alone would not catch duplicated coverage plus a hole.
  const keys=new Set(tiles.map(planetTileKey));
  for(const tile of tiles)for(let level=0;level<tile.level;level++)expect(keys.has(planetTileKey({face:tile.face,level,x:Math.floor(tile.x/2**(tile.level-level)),y:Math.floor(tile.y/2**(tile.level-level))}))).toBe(false);
};

it('always returns a complete nonoverlapping six-face frontier from orbit to the surface',()=>{
  const planet=earth();
  for(const scale of [6,2,1.1,1.001]){const result=planPlanetTiles(planet,frame([planet.radius*scale,0,0]));coversGlobe(result.tiles);expect(result.tiles.length).toBeLessThanOrEqual(192);expect(result.visited).toBe(6+(result.tiles.length-6)/3*4);expect(result.visited).toBeLessThanOrEqual(254);}
});

it('is deterministic and leaves accepted recipe and prior plans immutable',()=>{
  const planet=earth(),before=structuredClone(planet.recipe),view=frame([planet.radius*1.02,30000,5000]),a=planPlanetTiles(planet,view),b=planPlanetTiles(planet,view);
  expect(a).toEqual(b);expect(planet.recipe).toEqual(before);expect(Object.isFrozen(a.tiles)).toBe(true);expect(Object.isFrozen(a.tiles[0])).toBe(true);expect(Object.isFrozen(a)).toBe(true);
});

it('clamps requested budgets to six through512 patches and bounds all traversal work',()=>{
  const planet=earth(),point=planet.sample([1,0,0]).position,view=frame([point[0]+1,point[1],point[2]]);
  for(const requested of [-10,0,6,8,9,17.8,192,512,999999]){const result=planPlanetTiles(planet,view,{maxPatches:requested,targetCellPixels:.25}),budget=Math.max(6,Math.min(512,Math.floor(requested)));coversGlobe(result.tiles);expect(result.tiles.length).toBeLessThanOrEqual(budget);expect(result.visited).toBeLessThanOrEqual(6+4*Math.floor((budget-6)/3));expect(result.visited).toBeLessThanOrEqual(678);expect(result.budgetLimited).toBe(true);}
});

it('reaches small local patches at Earth radius without a planet-sized traversal',()=>{
  const planet=earth(),ray=planetDirection(0,.2537,-.1721),surface=planet.sample(ray).position,position=surface.map((v,i)=>v+ray[i]) as [number,number,number],result=planPlanetTiles(planet,frame(position),{maxPatches:512,targetCellPixels:8});
  coversGlobe(result.tiles);expect(result.maxLevel).toBeGreaterThanOrEqual(20);expect(result.visited).toBeLessThanOrEqual(678);
  // A level20 cube face patch is approximately12 m wide at Earth's face centre;
  // sixteen cells provide sub-metre topology before the optional finer levels.
  expect(2*planet.radius/2**result.maxLevel/planet.recipe.segments).toBeLessThan(1);
});

it('does not refine the hidden hemisphere merely to keep its coverage present',()=>{
  const planet=earth(),surface=planet.sample([1,0,0]).position,result=planPlanetTiles(planet,frame([surface[0]+10,surface[1],surface[2]]),{maxPatches:512});
  expect(result.tiles.filter(t=>t.face===1)).toEqual([{face:1,level:0,x:0,y:0}]);expect(result.tiles.some(t=>t.face===0&&t.level>0)).toBe(true);coversGlobe(result.tiles);
});

it('handles rapid travel between opposite faces and cube boundaries without retaining stale demand',()=>{
  const planet=earth();
  for(const ray of [[1,0,0],[-1,0,0],[1,1,0],[1,1,1],[0,-1,0],[0,0,-1]] as const){const surface=planet.sample(ray).position,r=Math.hypot(...surface),position=surface.map(v=>v*(r+2)/r) as [number,number,number],view=frame(position),a=planPlanetTiles(planet,view,{maxPatches:96}),b=planPlanetTiles(planet,view,{maxPatches:96});coversGlobe(a.tiles);expect(a).toEqual(b);expect(a.tiles.length).toBeLessThanOrEqual(96);}
});

it('respects a finite maximum depth and can show a coarse whole globe',()=>{
  const planet=compilePlanet({...createPlanetRecipe(17,6371000),segments:16,maxLevel:0}),result=planPlanetTiles(planet,frame([planet.radius+1,0,0]),{maxPatches:512,targetCellPixels:.25});
  expect(result.tiles).toHaveLength(6);expect(result.visited).toBe(6);expect(result.maxLevel).toBe(0);expect(result.budgetLimited).toBe(false);coversGlobe(result.tiles);
});

it('rejects invalid frames and numeric options rather than returning an incomplete frontier',()=>{
  const planet=earth(),valid=frame([planet.radius+10,0,0]);
  for(const position of [[NaN,0,0],[Infinity,0,0],[1e13,0,0],[0,0],new Array(3)])expect(()=>planPlanetTiles(planet,{...valid,position:position as unknown as PlanetVector})).toThrow('Planet LOD');
  for(const fovDegrees of [0,176,NaN])expect(()=>planPlanetTiles(planet,{...valid,fovDegrees})).toThrow('Planet LOD');
  for(const viewportHeight of [0,Infinity,32769])expect(()=>planPlanetTiles(planet,{...valid,viewportHeight})).toThrow('Planet LOD');
  for(const maxPatches of [NaN,Infinity])expect(()=>planPlanetTiles(planet,valid,{maxPatches})).toThrow('Planet LOD');
  for(const targetCellPixels of [0,.1,Infinity,1025])expect(()=>planPlanetTiles(planet,valid,{targetCellPixels})).toThrow('Planet LOD');
});
