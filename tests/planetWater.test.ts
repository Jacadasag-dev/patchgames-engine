import {afterEach,describe,expect,it,vi} from 'vitest';
import {DataTexture,Mesh,MeshPhysicalMaterial,SphereGeometry,Triangle,Vector3,type BufferGeometry} from 'three';
import {compilePlanet,type CompiledPlanet,type PlanetVector} from '../src/shared/planet.ts';
import {compilePlanetWater,PlanetWaterView,samplePlanetWater} from '../src/sandbox/planetWaterView.ts';
import {sampleWaterWave,waterAppearance} from '../src/sandbox/water.ts';

function planet(height=-20,sea=17,radius=1000):CompiledPlanet {
  return compilePlanet({kind:'planet',version:1,seed:4,radiusMeters:radius,segments:4,maxLevel:5,seaLevelMeters:sea,
    surface:{maps:{kind:'generation-maps',version:1,seed:4,maps:{height:{type:'constant',value:height,unit:'metres'}}},height:'height'}});
}
const views:PlanetWaterView[]=[];
afterEach(()=>{for(const view of views)view.dispose();views.length=0;vi.restoreAllMocks();});
function view(source=planet(),options:ConstructorParameters<typeof PlanetWaterView>[1]={}) {
  const result=new PlanetWaterView(source,{segments:32,nearRings:8,farRings:16,farProxySegments:128,prepareVerticesPerFrame:4096,prepareTimeBudgetMs:16,...options});views.push(result);return result;
}
function ready(water:PlanetWaterView,position:PlanetVector=[0,0,1030],time=3) {
  for(let i=0;i<100&&!water.inspection().detailReady;i++)water.update({position,timeSeconds:time});
  expect(water.inspection().detailReady).toBe(true);
}
function active(water:PlanetWaterView):Mesh {
  return water.root.children.find(child=>child.visible&&child.name==='PlanetWater:radial-wave-sheet') as Mesh;
}
function minimumTriangleRadius(geometry:BufferGeometry):number {
  const positions=geometry.getAttribute('position'),index=geometry.index!,triangle=new Triangle(),point=new Vector3(),zero=new Vector3();let minimum=Infinity;
  for(let i=0;i<index.count;i+=3){triangle.a.fromBufferAttribute(positions,index.getX(i));triangle.b.fromBufferAttribute(positions,index.getX(i+1));triangle.c.fromBufferAttribute(positions,index.getX(i+2));triangle.closestPointToPoint(zero,point);minimum=Math.min(minimum,point.length());}
  return minimum;
}

describe('planetary engine water queries',()=>{
  it('places real water at the recipe sea level and reuses the engine wave and weather source',()=>{
    const source=planet(),water=compilePlanetWater(source,{windSpeed:8,windDirection:.7,currentSpeed:.4}),appearance=waterAppearance(water),time=9;
    const expected=sampleWaterWave(water,{x:0,z:0},time,appearance,{inside:true,level:0,depth:37,edgeDistance:37,flow:{x:Math.cos(.7),z:Math.sin(.7)}});
    const sample=samplePlanetWater(source,[0,1,0],time,{water});
    expect(sample.wet).toBe(true);expect(sample.depthMeters).toBe(37);expect(sample.heightMeters).toBeCloseTo(17+expected.height,10);
    expect(sample.position[1]).toBeCloseTo(1017+expected.height,10);
    // The small globe's radial curvature changes slope relative to a plane.
    expect(new Vector3(...sample.normal).distanceTo(new Vector3(expected.normal.x,expected.normal.y,expected.normal.z))).toBeLessThan(.001);
    expect(sample.roughness).toBe(appearance.roughness);expect(sample.foam).toBe(expected.foam);
    expect(samplePlanetWater(planet(40),[0,1,0],time).wet).toBe(false);
    expect(samplePlanetWater(planet(40),[0,1,0],time).heightMeters).toBe(17);
  });
  it('keeps the same wave phase through cube-face edges, poles, and repeated queries',()=>{
    const source=planet(),water=compilePlanetWater(source,{windSpeed:8}),options={water};
    for(const at of [[1,0,1],[0,1,0],[1,1,1]] as const){
      const a=samplePlanetWater(source,[at[0]+1e-9,at[1],at[2]],12,options),b=samplePlanetWater(source,[at[0]-1e-9,at[1],at[2]],12,options);
      expect(Math.abs(a.heightMeters-b.heightMeters)).toBeLessThan(.0001);
      expect(new Vector3(...a.normal).distanceTo(new Vector3(...b.normal))).toBeLessThan(.0001);
    }
    expect(samplePlanetWater(source,[1,2,3],12,options)).toEqual(samplePlanetWater(source,[2,4,6],12,options));
    expect(compilePlanetWater(compilePlanet({...source.recipe,seed:-42})).seed).toBe(4294967254);
  });
  it('supplies the geometric derivative normal of the blended spherical wave surface',()=>{
    const source=planet(),n=new Vector3(1,2,3).normalize(),east=new Vector3(0,1,0).cross(n).normalize(),north=n.clone().cross(east),epsilon=1e-6;
    const at=(axis:Vector3,sign:number)=>samplePlanetWater(source,n.clone().addScaledVector(axis,sign*epsilon).toArray() as [number,number,number],8);
    const dx=new Vector3(...at(east,1).position).sub(new Vector3(...at(east,-1).position));
    const dz=new Vector3(...at(north,1).position).sub(new Vector3(...at(north,-1).position));
    const normal=new Vector3(...samplePlanetWater(source,n.toArray() as [number,number,number],8).normal);
    expect(Math.abs(dx.normalize().dot(normal))).toBeLessThan(.00001);expect(Math.abs(dz.normalize().dot(normal))).toBeLessThan(.00001);
  });
});

describe('bounded native planetary water presentation',()=>{
  it('keeps every default orbital ocean triangle above a 2km-deep seabed instead of exposing a coarse lattice',()=>{
    const radius=6_371_000,source=planet(-2000,0,radius),water=new PlanetWaterView(source);views.push(water);
    const proxy=water.root.children.find(child=>child.name==='PlanetWater:initial-far-proxy') as Mesh,old=new SphereGeometry(1,96,48);
    const oldError=radius*(1-minimumTriangleRadius(old));old.dispose();expect(oldError).toBeGreaterThan(6000);
    const radialError=radius*(1-minimumTriangleRadius(proxy.geometry)),facts=water.inspection();
    expect(radius-radialError).toBeGreaterThan(radius-2000);
    expect(radialError).toBeLessThanOrEqual(facts.farProxyMaxInwardErrorMeters);expect(facts.farProxyMaxInwardErrorMeters).toBeLessThan(242);
    expect(facts.farProxySegments).toBe(512);expect(facts.farProxyTriangles).toBeLessThanOrEqual(262144);expect(facts.farProxyGeometryBytes).toBeLessThan(8*1024*1024);
    expect(proxy.scale.x).toBe(radius);expect(proxy.material).toBeInstanceOf(MeshPhysicalMaterial);
    expect((proxy.material as MeshPhysicalMaterial).vertexColors).toBe(false);expect(proxy.geometry.getAttribute('color')).toBeUndefined();
  });
  it('accepts an explicit lower orbital geometry budget with an honest larger chord-error bound',()=>{
    const source=planet(-2000,0,6_371_000),water=view(source,{farProxySegments:128}),facts=water.inspection();
    expect(facts.farProxySegments).toBe(128);expect(facts.farProxyTriangles).toBeLessThan(17000);expect(facts.farProxyGeometryBytes).toBeLessThan(512*1024);expect(facts.farProxyMaxInwardErrorMeters).toBeGreaterThan(3000);
    expect(()=>new PlanetWaterView(source,{farProxySegments:96 as 128})).toThrow(/far proxy segments/);
    const proxy=water.root.children.find(child=>child.name==='PlanetWater:initial-far-proxy') as Mesh,array=proxy.geometry.getAttribute('position').array;
    water.update({position:[0,0,15_000_000],timeSeconds:9,conditions:{windSpeed:22}});expect(proxy.geometry.getAttribute('position').array).toBe(array);
  });
  it('keeps a single water Fresnel interface and filters omitted wave slopes instead of a second glossy coat',()=>{
    const source=planet(),water=view(source),proxy=water.root.children.find(child=>child.name==='PlanetWater:initial-far-proxy') as Mesh;
    const far=proxy.material as MeshPhysicalMaterial;ready(water);const near=active(water).material as MeshPhysicalMaterial;
    expect(far.clearcoat).toBe(0);expect(near.clearcoat).toBe(0);expect(far.ior).toBe(1.333);expect(far.specularIntensity).toBe(1);
    expect(((far.ior-1)/(far.ior+1))**2).toBeCloseTo(.02037,4);
    expect(far.roughness).toBeGreaterThan(water.sample([0,0,1]).roughness);expect(far.roughnessMap).toBeNull();
    expect(near.roughnessMap).toBeInstanceOf(DataTexture);expect(near.roughness).toBe(1);
    const map=near.roughnessMap as DataTexture,pixels=map.image.data as Uint8Array;
    expect(pixels[1]/255).toBeCloseTo(water.sample([0,0,1]).roughness,2);
    expect(pixels[pixels.length-3]/255).toBeCloseTo(far.roughness,2);
    for(let row=1;row<map.image.height;row++)expect(pixels[row*4+1]).toBeGreaterThanOrEqual(pixels[(row-1)*4+1]);
    expect(water.inspection().roughnessTextureBytes).toBeLessThan(1024);
  });
  it('preserves a flat authored ocean and responds to wave steepness rather than absolute wave size',()=>{
    const source=planet(),make=(amplitude:number,wavelength:number)=>view(source,{water:compilePlanetWater(source,{profiles:[{id:'test',minWindSpeed:0,amplitude,wavelength,speed:1,roughness:.12,foam:0,shoreFoam:0,color:'#204050'}]})});
    const flat=make(0,10),small=make(.2,10),large=make(2,100),steep=make(.4,10);
    expect(flat.inspection().farRoughness).toBeCloseTo(.12,12);
    expect(small.inspection().farRoughness).toBeCloseTo(large.inspection().farRoughness,12);
    expect(small.inspection().farRoughness).toBeGreaterThan(flat.inspection().farRoughness);
    expect(steep.inspection().farRoughness).toBeGreaterThan(small.inspection().farRoughness);
    expect(steep.inspection().farRoughness).toBeLessThanOrEqual(1);
  });
  it('updates the stable roughness resource with weather and keeps the outer sheet matched to orbit',()=>{
    const water=view(planet(),{conditions:{windSpeed:0}});ready(water);
    const mesh=active(water),near=mesh.material as MeshPhysicalMaterial,map=near.roughnessMap as DataTexture,pixels=map.image.data,version=map.version,initial=water.inspection().farRoughness;
    water.update({position:[0,0,1030],timeSeconds:4,conditions:{windSpeed:22}});
    expect(near.roughnessMap).toBe(map);expect(map.image.data).toBe(pixels);expect(map.version).toBeGreaterThan(version);expect(water.inspection().farRoughness).toBeGreaterThan(initial);
    const values=map.image.data as Uint8Array;expect(values[values.length-3]/255).toBeCloseTo(water.inspection().farRoughness,2);
    const lastVersion=map.version;water.update({position:[0,0,5000],timeSeconds:4});expect(map.version).toBe(lastVersion);
    const uv=mesh.geometry.getAttribute('uv');expect(uv.getY(0)).toBeCloseTo(.5/map.image.height,6);expect(uv.getY(uv.count-1)).toBeCloseTo((map.image.height-.5)/map.image.height,6);
  });
  it('uses native physical material, resolves near waves, and atomically replaces its initial far proxy',()=>{
    const water=view();expect(water.root.children.filter(child=>child.visible)).toHaveLength(1);ready(water);
    const mesh=active(water),sample=water.sample([0,0,1]);expect(mesh.material).toBeInstanceOf(MeshPhysicalMaterial);
    const material=mesh.material as MeshPhysicalMaterial;expect(material.ior).toBe(1.333);expect(material.vertexColors).toBe(true);expect(material.transparent).toBe(false);
    expect(water.root.children.filter(child=>child.visible)).toHaveLength(1);
    expect(mesh.geometry.getAttribute('position').getZ(0)).toBeCloseTo(sample.heightMeters-17,5);
    expect(mesh.geometry.getAttribute('normal').getX(0)).toBeCloseTo(sample.normal[0],6);
    expect(water.inspection().waveSource).toBe('engine-water');expect(water.inspection().physicsBodies).toBe(0);expect(water.inspection().fluidCells).toBe(0);
    // Outward index winding matters on both native renderers, including poles.
    const positions=mesh.geometry.getAttribute('position'),index=mesh.geometry.index!,origin=new Vector3(0,0,1017);
    for(let i=0;i<index.count;i+=3){
      const a=new Vector3().fromBufferAttribute(positions,index.getX(i)),b=new Vector3().fromBufferAttribute(positions,index.getX(i+1)),c=new Vector3().fromBufferAttribute(positions,index.getX(i+2));
      const normal=b.sub(a).cross(c.sub(a)),radial=a.clone().add(origin);expect(normal.dot(radial)).toBeGreaterThan(0);
    }
  });
  it('preserves sub-metre floating-origin precision and changes only object offsets on rebasing',()=>{
    const source=planet(-20,17,100_000_000),water=view(source);ready(water,[0,0,100_000_025]);
    const mesh=active(water),positions=mesh.geometry.getAttribute('position'),array=positions.array,oldZ=positions.getZ(0),sample=water.sample([0,0,1]);
    expect(oldZ).toBeCloseTo(sample.heightMeters-17,5);
    water.update({position:[0,0,100_000_025],origin:[.125,.25,100_000_025.5],timeSeconds:3});
    expect(mesh.position.toArray()).toEqual([-.125,-.25,-8.5]);expect(positions.array).toBe(array);expect(positions.getZ(0)).toBe(oldZ);
    expect(water.sample([0,0,1])).toEqual(sample);
  });
  it('bounds preparation, keeps topology fixed across recentering, and never resets the accepted wave clock',()=>{
    const source=planet(),water=view(source,{prepareVerticesPerFrame:32}),geometries=water.root.children.map(child=>(child as Mesh).geometry),arrays=geometries.map(geometry=>geometry.getAttribute('position').array);
    ready(water);const point=[0,0,1] as const,before=water.sample(point),initialSwaps=water.inspection().swaps;
    for(let i=0;i<100&&water.inspection().swaps===initialSwaps;i++){
      water.update({position:[40,0,1030],timeSeconds:3});expect(water.inspection().preparedThisFrame).toBeLessThanOrEqual(32);
      expect(water.root.children.filter(child=>child.visible)).toHaveLength(1);
    }
    expect(water.inspection().swaps).toBeGreaterThan(initialSwaps);expect(water.sample(point)).toEqual(before);
    expect(water.root.children.map(child=>(child as Mesh).geometry)).toEqual(geometries);
    geometries.forEach((geometry,i)=>expect(geometry.getAttribute('position').array).toBe(arrays[i]));
    expect(water.inspection().banks).toBe(2);
  });
  it('uses the far proxy in orbit and resumes the same water field when descending',()=>{
    const water=view(),position=[0,0,1030] as const;ready(water,position);
    const expected=water.sample([0,0,1],9);
    water.update({position:[0,0,5000],timeSeconds:9});expect(water.inspection().detailVisible).toBe(false);
    expect(water.root.children.filter(child=>child.visible).map(child=>child.name)).toEqual(['PlanetWater:initial-far-proxy']);
    expect(water.inspection().preparedThisFrame).toBe(0);
    water.update({position,timeSeconds:9});expect(water.inspection().detailVisible).toBe(true);
    expect(water.sample([0,0,1])).toEqual(expected);
  });
  it('samples terrain only during bounded preparation and owns every generated GPU resource exactly once',()=>{
    const compiled=planet(),sample=vi.fn(compiled.sample),source={...compiled,sample},water=view(source);ready(water);sample.mockClear();
    for(let i=0;i<10;i++)water.update({position:[0,0,1030],timeSeconds:4+i/30});expect(sample).not.toHaveBeenCalled();
    const geometries=water.root.children.map(child=>vi.spyOn((child as Mesh).geometry,'dispose')),materials=new Set(water.root.children.map(child=>(child as Mesh).material as MeshPhysicalMaterial)),disposeMaterials=[...materials].map(material=>vi.spyOn(material,'dispose'));
    const map=active(water).material as MeshPhysicalMaterial,disposeRoughness=vi.spyOn(map.roughnessMap!,'dispose');
    water.dispose();water.dispose();expect(disposeRoughness).toHaveBeenCalledTimes(1);expect(water.root.children).toHaveLength(0);expect(water.inspection().disposed).toBe(true);
    for(const dispose of geometries)expect(dispose).toHaveBeenCalledTimes(1);for(const dispose of disposeMaterials)expect(dispose).toHaveBeenCalledTimes(1);
  });
});
