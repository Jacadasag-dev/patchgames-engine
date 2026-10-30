import {describe,expect,it} from 'vitest';
import {compilePlanet,createPlanetRecipe,planetCoordinates,planetDirection,planetTileBounds,planetTileChildren,planetTileKey,type PlanetPatchData,type PlanetRecipe,type PlanetVector} from '../src/shared/planet.ts';

const flat=(radius=6_371_000,height=0):PlanetRecipe=>({kind:'planet',version:1,seed:42,radiusMeters:radius,segments:8,maxLevel:24,
  surface:{height:'height',maps:{kind:'generation-maps',version:1,seed:42,maps:{height:{type:'constant',value:height,unit:'metres'}}}}});
const position=(p:PlanetPatchData,i:number)=>p.origin.map((v,j)=>v+p.positions[i*3+j]);
const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:readonly number[],b:readonly number[])=>a.reduce((n,v,i)=>n+v*b[i],0);
const sub=(a:readonly number[],b:readonly number[])=>a.map((v,i)=>v-b[i]);

describe('planet recipes and radial source queries',()=>{
  it('freezes a detached recipe and keeps cache identity deterministic',()=>{
    const source=createPlanetRecipe(37),planet=compilePlanet(source),other=compilePlanet(source),sample=planet.sample([1,.25,-.4]);
    expect(planet.revision).toBe(other.revision);expect(planet.sample([2,.5,-.8])).toEqual(sample);
    source.surface.maps.maps.height={type:'constant',value:1,unit:'metres'};
    expect(planet.sample([1,.25,-.4])).toEqual(sample);expect(Object.isFrozen(planet.recipe.surface.maps.maps)).toBe(true);
    expect(compilePlanet(source).revision).not.toBe(planet.revision);
    expect(Math.hypot(...sample.position)).toBeCloseTo(planet.radius+sample.heightMeters,7);
    expect(Math.hypot(...sample.normal)).toBeCloseTo(1,12);expect(dot(sample.normal,sample.position)).toBeGreaterThan(0);
  });
  it('uses a shared planet-centred field without face or LOD randomness',()=>{
    const planet=compilePlanet(createPlanetRecipe(99)),point=planetDirection(0,-1,1),same=planetDirection(2,1,-1);
    expect(point).toEqual(same);expect(planet.sample(point)).toEqual(planet.sample(same));
    expect(planet.sample([1,0,0]).heightMeters).not.toBe(planet.sample([0,0,1]).heightMeters);
  });
  it('rejects unsupported recipes, fields, scales and expensive bakes',()=>{
    for(const change of [{radiusMeters:999},{radiusMeters:1e9},{segments:6},{segments:64},{maxLevel:25},{seaLevelMeters:1e9}])
      expect(()=>compilePlanet({...flat(),...change})).toThrow(/Planet/);
    expect(()=>compilePlanet({...flat(),colors:{ocean:'blue'}})).toThrow(/colors/);
    expect(()=>compilePlanet(flat(1000,101))).toThrow(/height/);
    for(const node of [{type:'constant',value:1,unit:'normalized'},{type:'random',scope:'object'},{type:'time',periodSeconds:5},{type:'noise',space:'object',scaleMeters:1}] as const){
      const source=flat();source.surface.maps.maps.height=node;expect(()=>compilePlanet(source)).toThrow(/height/);
    }
    const expensive=flat();expensive.segments=32;const maps=expensive.surface.maps.maps;
    for(let i=0;i<16;i++)maps['n'+i]={type:'noise',space:'world',scaleMeters:20,octaves:8};
    maps.blend={type:'mix',inputs:Array.from({length:16},(_,i)=>({map:'n'+i}))};
    maps.height={type:'remap',input:'blend',from:[0,1],to:[0,100],unit:'metres'};
    expect(()=>compilePlanet(expensive)).toThrow(/sampling budget/);
    const accessor=flat();Object.defineProperty(accessor,'seed',{get(){throw Error('accessed');},enumerable:true});
    expect(()=>compilePlanet(accessor)).toThrow(/accessor/);
  });
});

describe('cube-sphere topology and bounded patch preparation',()=>{
  it('names stable tiles and creates exactly four children',()=>{
    expect(planetTileKey({face:3,level:2,x:1,y:3})).toBe('3/2/1/3');
    expect(planetTileChildren({face:0,level:0,x:0,y:0})).toEqual([
      {face:0,level:1,x:0,y:0},{face:0,level:1,x:1,y:0},{face:0,level:1,x:0,y:1},{face:0,level:1,x:1,y:1},
    ]);
    for(const tile of [{face:6,level:0,x:0,y:0},{face:0,level:0,x:1,y:0},{face:0,level:1,x:0,y:-1},{face:0,level:25,x:0,y:0}])
      expect(()=>planetTileKey(tile)).toThrow(/Planet/);
    expect(()=>planetTileChildren({face:0,level:24,x:0,y:0})).toThrow(/maximum/);
  });
  it('round-trips every face and canonically resolves shared edge/corner coordinates',()=>{
    for(let face=0;face<6;face++)for(const u of [-1,-.5,0,.75,1])for(const v of [-1,-.25,0,.5,1]){
      const unit=planetDirection(face,u,v),inverse=planetCoordinates(unit);
      expect(Math.hypot(...sub(planetDirection(inverse.face,inverse.u,inverse.v),unit))).toBeLessThan(1e-15);
      if(Math.abs(u)<1&&Math.abs(v)<1)expect(inverse.face).toBe(face);
    }
    expect(planetCoordinates([1,1,1])).toEqual({face:0,u:-1,v:1});
    expect(planetCoordinates([-1,-1,-1])).toEqual({face:1,u:-1,v:-1});
    expect(planetCoordinates([0,2,2])).toEqual({face:2,u:0,v:-1});
    expect(()=>planetCoordinates([0,0,0])).toThrow(/nonzero/);
  });
  it('keeps outward surface winding on all six faces and includes bounded skirts',()=>{
    const planet=compilePlanet(flat(10_000)),segments=planet.recipe.segments;
    for(let face=0;face<6;face++){
      const patch=planet.patch({face,level:0,x:0,y:0});
      expect(patch.positions.length/3).toBe((segments+1)**2+segments*4);
      expect(patch.surfaceTriangles).toBe(segments*segments*2);expect(patch.skirtTriangles).toBe(segments*8);
      expect(patch.indices.length).toBe((patch.surfaceTriangles+patch.skirtTriangles)*3);
      expect(patch.byteLength).toBe(patch.positions.byteLength+patch.normals.byteLength+patch.colors.byteLength+patch.indices.byteLength);
      for(let t=0;t<patch.surfaceTriangles;t++){
        const a=position(patch,patch.indices[t*3]),b=position(patch,patch.indices[t*3+1]),c=position(patch,patch.indices[t*3+2]);
        expect(dot(cross(sub(b,a),sub(c,a)),a)).toBeGreaterThan(0);
      }
      for(let i=0;i<patch.positions.length;i+=3)expect(Math.hypot(...patch.positions.subarray(i,i+3))).toBeLessThanOrEqual(patch.bounds.radius);
      expect(patch.revision).toBe(planet.revision);
    }
  });
  it('shares exact source directions at root face seams and corners',()=>{
    // These edges traverse +X and +Z in matching directions.
    for(let i=0;i<=16;i++)expect(planetDirection(0,-1,-1+i/8)).toEqual(planetDirection(4,1,-1+i/8));
    const corner=planetDirection(0,-1,1);
    expect(corner).toEqual(planetDirection(2,1,-1));expect(corner).toEqual(planetDirection(4,1,1));
    const planet=compilePlanet(createPlanetRecipe(4)),a=planet.patch({face:0,level:2,x:1,y:1}),b=planet.patch({face:0,level:2,x:2,y:1}),s=planet.recipe.segments;
    // Different local Float32 origins introduce at most the patch-scale ULP.
    // Skirts cover this gap; deep surface tiles have micron-scale local error.
    const floatError=Math.max(a.bounds.radius,b.bounds.radius)*2e-7;
    for(let y=0;y<=s;y++)expect(Math.hypot(...sub(position(a,y*(s+1)+s),position(b,y*(s+1))))).toBeLessThan(floatError);
  });
  it('matches parent-child samples and retains centimetre precision near Earth at deep levels',()=>{
    const planet=compilePlanet(flat()),tile={face:2,level:20,x:123456,y:654321},patch=planet.patch(tile),s=planet.recipe.segments;
    const u=-1+2*tile.x/2**tile.level,v=-1+2*tile.y/2**tile.level;
    const source=planet.sample(planetDirection(tile.face,u,v));
    expect(Math.hypot(...sub(position(patch,0),source.position))).toBeLessThan(1e-5);
    const children=planetTileChildren(tile),child=planet.patch(children[0]);
    expect(Math.hypot(...sub(position(patch,0),position(child,0)))).toBeLessThan(1e-5);
    expect(Math.hypot(...sub(position(patch,1),position(patch,0)))).toBeGreaterThan(.1);
    expect(Math.hypot(...patch.positions.subarray((s+1)**2*3,(s+1)**2*3+3))).toBeLessThan(planet.radius*.001);
  });
  it('surface bounds enclose arbitrary samples across every root and deep rectangle',()=>{
    const planet=compilePlanet(createPlanetRecipe(25));
    for(const tile of [...Array.from({length:6},(_,face)=>({face,level:0,x:0,y:0})),{face:3,level:7,x:93,y:1}]){
      const bounds=planetTileBounds(tile,planet.radius,planet.minHeight,planet.maxHeight),width=2**tile.level;
      for(let y=0;y<=5;y++)for(let x=0;x<=5;x++){
        const unit=planetDirection(tile.face,-1+2*(tile.x+x/5)/width,-1+2*(tile.y+y/5)/width);
        for(const height of [planet.minHeight,planet.maxHeight]){
          const point=unit.map(v=>v*(planet.radius+height)) as unknown as PlanetVector;
          expect(Math.hypot(...sub(point,bounds.center))).toBeLessThanOrEqual(bounds.radius+1e-6);
        }
      }
    }
  });
  it('retains a measurable angular envelope at the deepest supported Earth tile',()=>{
    const bounds=planetTileBounds({face:2,level:24,x:8_388_608,y:8_388_608},6_371_000);
    expect(bounds.angularRadius).toBeGreaterThan(8e-8);expect(bounds.angularRadius).toBeLessThan(9e-8);
    expect(bounds.radius).toBeGreaterThan(.5);expect(bounds.radius).toBeLessThan(.6);
  });
  it('skirt bottoms cover the complete height range even across mismatched detail',()=>{
    const source=flat(1000),maps=source.surface.maps.maps;
    maps.field={type:'gradient',space:'world',axis:'y',from:-1000,to:1000};
    maps.height={type:'remap',input:'field',from:[0,1],to:[-80,80],unit:'metres'};
    const planet=compilePlanet(source),s=planet.recipe.segments,grid=(s+1)**2;
    for(const tile of [{face:2,level:0,x:0,y:0},{face:0,level:5,x:18,y:12}]){
      const patch=planet.patch(tile);
      for(let i=grid;i<patch.positions.length/3;i++)expect(Math.hypot(...position(patch,i))).toBeLessThan(planet.radius+planet.minHeight);
    }
  });
});
