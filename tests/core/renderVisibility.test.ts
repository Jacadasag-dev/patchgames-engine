import { describe, expect, it, vi } from 'vitest';
import {
  ArrayCamera, BatchedMesh, BoxGeometry, BufferAttribute, DirectionalLight, Frustum, FrustumArray, Group,
  InstancedBufferAttribute, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Scene,
  ShaderMaterial, SphereGeometry,
} from 'three';
import { hasDefaultRenderFrustum, RenderVisibility } from '../../src/sandbox/renderVisibility.ts';

function camera() { return new PerspectiveCamera(60, 1, .1, 1000); }
function frustum(view: PerspectiveCamera) {
  view.updateMatrixWorld();
  return new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
}
function sphereAt(distance: number, geometry = new SphereGeometry(1, 32, 24)) {
  const mesh = new Mesh(geometry, new MeshStandardMaterial()); mesh.position.z = -distance; return mesh;
}

describe('automatic render visibility and LOD', () => {
  it('checks LOD material state only for reducible geometry and shares it within one preparation', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), material = new MeshStandardMaterial();
    const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    const reads = (key: string) => descriptor.mock.calls.filter(([object, name]) => object === material && name === key).length;
    const box = new BoxGeometry(), low = new Mesh(box, material); low.position.z = -120; scene.add(low);
    policy.prepare(scene, view, 720); policy.restore();
    expect(reads('transparent')).toBe(0); expect(reads('wireframe')).toBe(0);
    const source = new SphereGeometry(1, 32, 24), a = new Mesh(source, material), b = new Mesh(source, material);
    a.position.z = b.position.z = -120; scene.add(a, b);
    policy.prepare(scene, view, 720);
    expect(a.geometry).not.toBe(source); expect(b.geometry).toBe(a.geometry);
    expect(reads('transparent')).toBe(1); expect(reads('wireframe')).toBe(1); policy.restore();
    material.transparent = true; policy.prepare(scene, view, 720);
    expect(a.geometry).toBe(source); expect(b.geometry).toBe(source); expect(reads('transparent')).toBe(2); policy.restore();
    material.transparent = false; material.wireframe = true; policy.prepare(scene, view, 720); expect(a.geometry).toBe(source); policy.restore();
    material.wireframe = false; source.drawRange.count = 3; policy.prepare(scene, view, 720); expect(a.geometry).toBe(source); policy.restore();
    source.drawRange.count = Infinity; policy.prepare(scene, view, 720); expect(a.geometry).not.toBe(source);
    descriptor.mockRestore(); policy.dispose(); source.dispose(); box.dispose(); material.dispose();
  });

  it('keeps full detail for changing material accessors without evaluating them', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), material = new MeshStandardMaterial();
    const source = new SphereGeometry(1, 32, 24), a = new Mesh(source, material), b = new Mesh(source, material);
    a.position.z = b.position.z = -120; scene.add(a, b);
    policy.prepare(scene, view, 720); expect(a.geometry).not.toBe(source); policy.restore();
    let next = false;
    const changing = vi.fn(() => next = !next);
    Object.defineProperty(material, 'transparent', { configurable: true, get: changing });
    policy.prepare(scene, view, 720); expect(a.geometry).toBe(source); expect(b.geometry).toBe(source); policy.restore();
    expect(changing).not.toHaveBeenCalled();
    Object.defineProperty(material, 'transparent', { configurable: true, writable: true, value: false });
    Object.defineProperty(material, 'wireframe', { configurable: true, get: changing });
    policy.prepare(scene, view, 720); expect(a.geometry).toBe(source); expect(b.geometry).toBe(source); policy.restore();
    expect(changing).not.toHaveBeenCalled();
    const authoredPrototype = Object.create(MeshStandardMaterial.prototype);
    Object.defineProperty(authoredPrototype, 'wireframe', { get: changing });
    delete (material as { wireframe?: boolean }).wireframe; Object.setPrototypeOf(material, authoredPrototype);
    policy.prepare(scene, view, 720); expect(a.geometry).toBe(source); expect(changing).not.toHaveBeenCalled();
    policy.dispose(); source.dispose(); material.dispose();
  });

  it('reuses world bounds until a parent transform or position buffer changes', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), parent = new Group();
    const geometry = new BoxGeometry(.2, 40, .2), mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.position.set(15, 0, -10); parent.add(mesh); scene.add(parent);
    const main = frustum(view);
    policy.prepare(scene, view, 720); expect(mesh.intersectsFrustum(main)).toBe(false); policy.restore();
    const entry = (policy as unknown as { meshes: WeakMap<Mesh, { bounds: { min: { set: (...values: number[]) => unknown } } }> }).meshes.get(mesh)!;
    const recompute = vi.spyOn(entry.bounds.min, 'set');
    policy.prepare(scene, view, 720); expect(mesh.intersectsFrustum(main)).toBe(false); expect(recompute).not.toHaveBeenCalled(); policy.restore();
    parent.position.x = -15; policy.prepare(scene, view, 720); expect(mesh.intersectsFrustum(main)).toBe(true); expect(recompute).toHaveBeenCalledOnce(); policy.restore();
    // Buffer replacement need not increment Three's upload version. It still
    // invalidates the engine's local bounds and derived world box immediately.
    const position = geometry.getAttribute('position') as BufferAttribute;
    const replacement = new Float32Array(position.array);
    for (let index = 0; index < replacement.length; index += 3) replacement[index] += 15;
    position.array = replacement; geometry.boundingSphere = null;
    policy.prepare(scene, view, 720); expect(mesh.intersectsFrustum(main)).toBe(false); expect(recompute).toHaveBeenCalledTimes(2);
    policy.dispose(); geometry.dispose(); (mesh.material as MeshBasicMaterial).dispose();
  });

  it('uses screen-space detail, shares variants, and restores full geometry before inspection', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera();
    const geometry = new SphereGeometry(1, 32, 24), near = sphereAt(4, geometry), far = sphereAt(120, geometry), other = sphereAt(130, geometry);
    scene.add(near, far, other);
    const sourcePositions = Array.from(geometry.getAttribute('position').array);
    policy.prepare(scene, view, 720);
    expect(near.geometry).toBe(geometry);
    expect(far.geometry).not.toBe(geometry);
    expect(far.geometry).toBe(other.geometry);
    expect(far.geometry.getAttribute('position').count).toBeLessThan(geometry.getAttribute('position').count);
    expect(policy.stats).toMatchObject({ lodMeshes: 2, frustumMeshes: 3, cachedGeometries: 1 });
    expect(hasDefaultRenderFrustum(far)).toBe(true);
    policy.restore();
    expect(far.geometry).toBe(geometry); expect(other.geometry).toBe(geometry);
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(sourcePositions);
    expect(far.intersectsFrustum).toBe(Mesh.prototype.intersectsFrustum);
    policy.dispose();
  });

  it('tightens broad sphere culling independently for gameplay and shadow cameras', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera();
    // The 40m vertical object has a broad bounding sphere overlapping the camera
    // even though the whole narrow box is to the right of its frustum.
    const mesh = new Mesh(new BoxGeometry(.2, 40, .2), new MeshBasicMaterial());
    mesh.position.set(15, 0, -10); mesh.castShadow = true; scene.add(mesh); scene.updateMatrixWorld();
    const main = frustum(view);
    expect(mesh.intersectsFrustum(main)).toBe(true);
    policy.prepare(scene, view, 720);
    expect(mesh.intersectsFrustum(main)).toBe(false);
    const shadowCamera = camera(); shadowCamera.position.set(15, 0, 0);
    expect(mesh.intersectsFrustum(frustum(shadowCamera))).toBe(true);
    expect(mesh.visible).toBe(true); expect(mesh.castShadow).toBe(true);
    policy.restore(); expect(mesh.intersectsFrustum(main)).toBe(true);
  });

  it('retains objects crossing the frustum edge with rotated and scaled parents', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), parent = new Group();
    parent.rotation.y = .4; parent.scale.set(2, 1, .5);
    const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()); mesh.position.set(0, 0, -4);
    parent.add(mesh); scene.add(parent);
    policy.prepare(scene, view, 720);
    expect(mesh.intersectsFrustum(frustum(view))).toBe(true);
    policy.restore();
  });

  it('keeps all views of an array camera when tightening bounds', () => {
    const policy = new RenderVisibility(), scene = new Scene(), left = camera(), right = camera();
    right.position.set(15, 0, -116); right.updateMatrixWorld(); left.updateMatrixWorld();
    const cameras = new ArrayCamera([left, right]), mesh = sphereAt(120), original = mesh.geometry; mesh.position.x = 15; scene.add(mesh);
    policy.prepare(scene, cameras, 720);
    const union = new FrustumArray().setFromArrayCamera(cameras);
    expect(mesh.intersectsFrustum(union)).toBe(true);
    expect(mesh.geometry).toBe(original); expect(policy.stats.lodMeshes).toBe(0);
    policy.restore();
  });

  it('does not reduce primitives edited after construction, including edits without a version bump', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera();
    const translated = new SphereGeometry(1, 32, 24); translated.translate(3, 0, 0);
    const edited = new SphereGeometry(1, 32, 24); edited.getAttribute('position').setX(10, 20);
    const a = sphereAt(120, translated), b = sphereAt(120, edited); scene.add(a, b);
    policy.prepare(scene, view, 720);
    expect(a.geometry).toBe(translated); expect(b.geometry).toBe(edited); expect(policy.stats.lodMeshes).toBe(0);
    policy.dispose();
  });

  it('invalidates LOD and bounds when an uploaded geometry changes', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), mesh = sphereAt(120), original = mesh.geometry;
    scene.add(mesh); policy.prepare(scene, view, 720);
    const variant = mesh.geometry, disposed = vi.fn(); variant.addEventListener('dispose', disposed);
    expect(variant).not.toBe(original); policy.restore();
    original.scale(4, 1, 1);
    policy.prepare(scene, view, 720);
    expect(mesh.geometry).toBe(original); expect(disposed).toHaveBeenCalledOnce();
    policy.dispose();
  });

  it('respects custom culling, deformations, shader hooks, and authored frustum disabling', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera();
    const disabled = sphereAt(120); disabled.frustumCulled = false;
    const custom = sphereAt(120), authoredTest = () => true; custom.intersectsFrustum = authoredTest;
    const morphed = sphereAt(120); morphed.geometry.morphAttributes.position = [new BufferAttribute(new Float32Array(morphed.geometry.getAttribute('position').array), 3)];
    const shader = new Mesh(new SphereGeometry(1, 32, 24), new ShaderMaterial()); shader.position.z = -120;
    const hook = sphereAt(120); hook.material.onBeforeCompile = () => {};
    const materialHook = sphereAt(120); materialHook.material.onBeforeRender = () => {};
    const instanced = new InstancedMesh(new SphereGeometry(1, 32, 24), new MeshStandardMaterial(), 2);
    const authoredRender = sphereAt(120); authoredRender.onBeforeRender = () => {};
    const objects = [disabled, custom, morphed, shader, hook, materialHook, instanced, authoredRender];
    const originals = objects.map(object => ({ geometry: object.geometry, culling: object.intersectsFrustum }));
    scene.add(...objects); policy.prepare(scene, view, 720);
    objects.forEach((object, index) => {
      expect(object.geometry).toBe(originals[index].geometry); expect(object.intersectsFrustum).toBe(originals[index].culling);
    });
    expect(policy.stats).toMatchObject({ lodMeshes: 0, frustumMeshes: 0 }); policy.dispose();
    expect(hasDefaultRenderFrustum(custom)).toBe(false);
  });

  it('keeps more geometry at higher display resolution and for detailed shadow maps', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), mesh = sphereAt(80), original = mesh.geometry;
    scene.add(mesh);
    policy.prepare(scene, view, 720); const lowCount = mesh.geometry.getAttribute('position').count; policy.restore();
    policy.prepare(scene, view, 2880); const highCount = mesh.geometry.getAttribute('position').count; policy.restore();
    expect(highCount).toBeGreaterThan(lowCount);
    const sun = new DirectionalLight(); sun.castShadow = true;
    sun.position.set(0,20,-80);sun.target.position.set(0,0,-80);scene.add(sun.target);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -2; sun.shadow.camera.right = sun.shadow.camera.top = 2;
    sun.shadow.camera.updateProjectionMatrix(); sun.shadow.mapSize.set(2048, 2048); mesh.castShadow = true; scene.add(sun);
    policy.prepare(scene, view, 720); expect(mesh.geometry).toBe(original); policy.dispose();
  });
  it('does not retain distant detail for a directional shadow volume that cannot contain it',()=>{
    const policy=new RenderVisibility(),scene=new Scene(),view=camera(),mesh=sphereAt(180),original=mesh.geometry,sun=new DirectionalLight();sun.castShadow=true;mesh.castShadow=true;
    sun.position.set(0,20,0);sun.shadow.camera.left=sun.shadow.camera.bottom=-2;sun.shadow.camera.right=sun.shadow.camera.top=2;sun.shadow.camera.updateProjectionMatrix();sun.shadow.mapSize.set(2048,2048);scene.add(mesh,sun,sun.target);
    policy.prepare(scene,view,720);expect(mesh.geometry).not.toBe(original);expect(policy.stats.lodMeshes).toBe(1);policy.dispose();
  });

  it('keeps LOD stable around its error threshold, then restores full detail when approached', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), mesh = sphereAt(80), original = mesh.geometry;
    scene.add(mesh); policy.prepare(scene, view, 720); const reduced = mesh.geometry; policy.restore();
    expect(reduced).not.toBe(original);
    mesh.position.z = -79; policy.prepare(scene, view, 720); expect(mesh.geometry).toBe(reduced); policy.restore();
    mesh.position.z = -4; policy.prepare(scene, view, 720); expect(mesh.geometry).toBe(original); policy.dispose();
  });

  it('bounds generated LOD resources and releases them with the source or renderer', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera();
    for (let index = 0; index < 132; index++) scene.add(sphereAt(120 + index));
    policy.prepare(scene, view, 720); expect(policy.stats.cachedGeometries).toBeLessThanOrEqual(128);
    const first = scene.children[0] as Mesh, reduced = first.geometry, released = vi.fn();
    reduced.addEventListener('dispose', released); policy.restore(); first.geometry.dispose();
    expect(released).toHaveBeenCalledOnce();
    policy.dispose(); expect(policy.stats.cachedGeometries).toBe(0);
  });

  it('leaves authored batched geometry and custom instance attributes on their native culling path', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), source = new BoxGeometry();
    const batch = new BatchedMesh(2, 100, 200, new MeshBasicMaterial());
    const geometry = batch.addGeometry(source); batch.addInstance(geometry);
    const custom = new Mesh(new InstancedBufferGeometry().setAttribute('position', source.getAttribute('position')), new MeshBasicMaterial());
    const attribute = sphereAt(120); attribute.geometry.setAttribute('offset', new InstancedBufferAttribute(new Float32Array([0, 0, 0]), 3));
    const originals = [batch, custom, attribute].map(mesh => ({ geometry: mesh.geometry, culling: mesh.intersectsFrustum }));
    scene.add(batch, custom, attribute); policy.prepare(scene, view, 720);
    [batch, custom, attribute].forEach((mesh, index) => {
      expect(mesh.geometry).toBe(originals[index].geometry); expect(mesh.intersectsFrustum).toBe(originals[index].culling);
    });
    expect(policy.stats.frustumMeshes).toBe(0); policy.dispose(); batch.dispose();
  });

  it('checks shared material and geometry eligibility again after later edits', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), mesh = sphereAt(120);
    scene.add(mesh); policy.prepare(scene, view, 720); expect(policy.stats.lodMeshes).toBe(1); policy.restore();
    mesh.material.onBeforeRender = () => {};
    policy.prepare(scene, view, 720); expect(policy.stats.frustumMeshes).toBe(0); policy.restore();
    mesh.material.onBeforeRender = MeshStandardMaterial.prototype.onBeforeRender;
    mesh.geometry.setAttribute('offset', new InstancedBufferAttribute(new Float32Array([0, 0, 0]), 3));
    policy.prepare(scene, view, 720); expect(policy.stats.frustumMeshes).toBe(0); policy.dispose();
  });

  it('defers box scans for source meshes consumed by render batching', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera();
    const geometry = new BoxGeometry(), mesh = new Mesh(geometry, new MeshBasicMaterial()); mesh.position.z = -20; scene.add(mesh);
    const positions = geometry.getAttribute('position'), read = vi.spyOn(positions, 'getX');
    policy.prepare(scene, view, 720);
    expect(read).not.toHaveBeenCalled(); // The batching pass can hide it without paying for its box.
    expect(mesh.intersectsFrustum(frustum(view))).toBe(true);
    expect(read).toHaveBeenCalled();
    policy.dispose();
  });

  it('releases every cached level and source when a dispose listener throws even undefined', () => {
    const policy = new RenderVisibility(), scene = new Scene(), view = camera(), a = sphereAt(80), b = sphereAt(90);
    const originals = [a.geometry, b.geometry]; scene.add(a, b);
    policy.prepare(scene, view, 720); const medium = [a.geometry, b.geometry]; policy.restore();
    a.position.z = -400; b.position.z = -410;
    policy.prepare(scene, view, 720); const coarse = [a.geometry, b.geometry];
    const variants = [medium[0], coarse[0], medium[1], coarse[1]], disposed = variants.map(() => vi.fn());
    expect(new Set(variants).size).toBe(4);
    variants.forEach((geometry, index) => geometry.addEventListener('dispose', disposed[index]));
    medium[0].addEventListener('dispose', () => { throw undefined; });
    coarse[0].addEventListener('dispose', () => { throw new Error('later disposal failure'); });
    let failed = false;
    try { policy.dispose(); }
    catch (error) { failed = true; expect(error).toBeUndefined(); }
    expect(failed).toBe(true);
    disposed.forEach(listener => expect(listener).toHaveBeenCalledOnce());
    expect(policy.stats.cachedGeometries).toBe(0);
    expect(a.geometry).toBe(originals[0]); expect(b.geometry).toBe(originals[1]);
    expect(a.intersectsFrustum).toBe(Mesh.prototype.intersectsFrustum);
    expect(() => { policy.dispose(); originals.forEach(geometry => geometry.dispose()); }).not.toThrow();
    disposed.forEach(listener => expect(listener).toHaveBeenCalledOnce());
    policy.prepare(scene, view, 720); expect(policy.stats.cachedGeometries).toBe(0);
  });
});
