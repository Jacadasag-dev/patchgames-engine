import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, LOD, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene, SkinnedMesh, Vector4, WebGLRenderer } from 'three';
import { configureRenderPerformance, installRenderPerformance, renderPerformanceStats } from '../../src/sandbox/renderPerformance.ts';
import { PlayerAppearanceHost } from '../../src/sandbox/playerAppearance.ts';

function renderer(draw: WebGLRenderer['render']) {
  installRenderPerformance();
  const value = Object.create(WebGLRenderer.prototype) as WebGLRenderer;
  const dispose = vi.fn();
  value.dispose = dispose;
  value.getViewport = target => target.copy(new Vector4(0, 0, 1280, 720));
  value.getPixelRatio = () => 1;
  // Three assigns render before getRenderTarget; no caller opt-in.
  value.render = draw;
  value.getRenderTarget = () => null;
  return { value, dispose };
}
function fixture() {
  const scene = new Scene(), camera = new PerspectiveCamera(60, 16 / 9, .1, 1000);
  const geometry = new BoxGeometry(), material = new MeshBasicMaterial();
  const meshes = [1, 2, 3].map(x => {
    const mesh = new Mesh(geometry, material); mesh.position.set(x, 1, -10); scene.add(mesh); return mesh;
  });
  return { scene, camera, meshes, geometry, material };
}
function proxies(scene: Scene) {
  const result: Mesh[] = [];
  scene.traverse(object => { if (object instanceof Mesh && ('isInstancedMesh' in object || 'isBatchedMesh' in object)) result.push(object); });
  return result;
}

describe('default engine rendering policy', () => {
  it('automatically handles fresh resource copies and live edits without changing authored resource identities', () => {
    const scene = new Scene(), camera = new PerspectiveCamera();
    const meshes = Array.from({ length: 3 }, (_, index) => {
      const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0x3388aa }));
      mesh.position.set(index, 0, -10); scene.add(mesh); return mesh;
    });
    const materials = meshes.map(mesh => mesh.material), geometries = meshes.map(mesh => mesh.geometry);
    let merged = true;
    const { value } = renderer(() => {
      expect(proxies(scene)).toHaveLength(merged ? 1 : 0);
      meshes.forEach((mesh, index) => { expect(mesh.material).toBe(materials[index]); expect(mesh.geometry).toBe(geometries[index]); });
    });
    value.render(scene, camera);
    merged = false; meshes[0].material.color.setHex(0xffaa33); value.render(scene, camera);
    merged = true; meshes[0].material.color.setHex(0x3388aa); value.render(scene, camera);
    value.dispose();
    materials.forEach(material => material.dispose()); geometries.forEach(geometry => geometry.dispose());
  });

  it('automatically combines compatible meshes, reuses proxies and restores authored objects after every draw', () => {
    const { scene, camera, meshes } = fixture();
    let first: Mesh | undefined;
    const draw = vi.fn(() => {
      const combined = proxies(scene);
      expect(combined).toHaveLength(1);
      if (first) expect(combined[0]).toBe(first); else first = combined[0];
    });
    const { value } = renderer(draw);
    value.render(scene, camera); value.render(scene, camera);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(scene.children).toEqual(meshes);
    expect(meshes.every(mesh => mesh.visible && mesh.parent === scene)).toBe(true);
    expect(renderPerformanceStats(value).draws).toBe(2);
    configureRenderPerformance(value); value.render(scene, camera);
    expect(draw).toHaveBeenCalledTimes(3);
    value.dispose();
  });

  it('restores state on render errors and preserves custom scene callbacks', () => {
    const { scene, camera, meshes } = fixture();
    const { value } = renderer(() => { throw new Error('render failed'); });
    expect(() => value.render(scene, camera)).toThrow('render failed');
    expect(scene.children).toEqual(meshes);
    expect(meshes.every(mesh => mesh.visible)).toBe(true);
    value.dispose();
    scene.onBeforeRender = () => { /* authored draw mutation */ };
    const custom = renderer(() => {
      expect(proxies(scene)).toHaveLength(0);
      expect(meshes.every(mesh => mesh.visible)).toBe(true);
    });
    custom.value.render(scene, camera); custom.value.dispose();
  });

  it('isolates nested camera draws and restores the outer render-list proxy identities', () => {
    const { scene, camera, meshes } = fixture();
    const reflection = camera.clone(); reflection.position.x = 8;
    let nested = false, outer: Mesh | undefined, inner: Mesh | undefined;
    const { value } = renderer((_scene, activeCamera) => {
      if (activeCamera === camera) {
        outer = proxies(scene)[0];
        if (!nested) { nested = true; value.render(scene, reflection); }
        expect(proxies(scene)[0]).toBe(outer);
      } else { inner = proxies(scene)[0]; expect(inner).not.toBe(outer); }
    });
    value.render(scene, camera);
    expect(outer).toBeDefined(); expect(inner).toBeDefined();
    expect(scene.children).toEqual(meshes);
    value.dispose();
  });

  it('bounds retained scene contexts and releases owned buffers on renderer disposal', () => {
    const camera = new PerspectiveCamera(), { value, dispose } = renderer(() => {});
    for (let i = 0; i < 40; i++) value.render(new Group(), camera);
    expect(renderPerformanceStats(value).retainedScenes).toBeLessThanOrEqual(16);
    value.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(renderPerformanceStats(value).retainedScenes).toBe(0);
  });

  it('keeps sibling-mutating authored mesh callbacks on the original rendering path', () => {
    const { scene, camera, meshes } = fixture();
    const callback = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    callback.onBeforeRender = () => { meshes[0].position.x = 99; };
    scene.add(callback);
    const { value } = renderer(() => { expect(proxies(scene)).toHaveLength(0); });
    value.render(scene, camera); value.dispose();
  });

  it('keeps automatic batching active around engine first-person masks without batching the masked body', () => {
    const { scene, camera } = fixture();
    const body = new Group(), head = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    head.name = 'head'; body.add(head);
    const appearances = new PlayerAppearanceHost(scene);
    appearances.setPlayerAppearance('local', body); body.visible = true;
    const before = head.material.onBeforeRender, after = head.onAfterRender;
    const { value } = renderer(() => {
      expect(proxies(scene)).toHaveLength(1);
      expect(head.visible).toBe(true);
      head.material.onBeforeRender(value, scene, camera, head.geometry, head, null!);
      expect(head.material.colorWrite).toBe(false);
      head.onAfterRender(value, scene, camera, head.geometry, head.material, null!);
      expect(head.material.colorWrite).toBe(true);
    });
    appearances.withFirstPersonBody('local', camera, () => value.render(scene, camera));
    expect(head.material.onBeforeRender).toBe(before); expect(head.onAfterRender).toBe(after);
    value.dispose(); appearances.dispose();
  });

  it('does not trust camera masks that wrap authored callbacks', () => {
    const { scene, camera } = fixture();
    const body = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    body.material.onBeforeRender = () => {};
    const appearances = new PlayerAppearanceHost(scene);
    appearances.setPlayerAppearance('local', body); body.visible = true;
    const { value } = renderer(() => { expect(proxies(scene)).toHaveLength(0); });
    appearances.withHiddenFromCamera('local', camera, () => value.render(scene, camera));
    value.dispose(); appearances.dispose();
  });

  it('preserves override-material passes and cameras substituted by active XR', () => {
    const { scene, camera } = fixture();
    const { value } = renderer(() => { expect(proxies(scene)).toHaveLength(0); });
    scene.overrideMaterial = new MeshBasicMaterial(); value.render(scene, camera);
    scene.overrideMaterial = null;
    Object.defineProperty(value, 'xr', { value: { enabled: true, isPresenting: true } });
    value.render(scene, camera); value.dispose();
  });

  it('restores an outer pass when nested preparation throws, including an unsupported intermediate pass', () => {
    const { scene, camera } = fixture(), alternate = camera.clone(), unsupported = new Scene();
    unsupported.onBeforeRender = () => {};
    let throwViewport = false, outer: Mesh | undefined;
    const { value } = renderer((activeScene) => {
      if (activeScene === scene) {
        outer = proxies(scene)[0];
        value.render(unsupported, camera);
        expect(proxies(scene)[0]).toBe(outer);
      } else {
        throwViewport = true;
        expect(() => value.render(new Scene(), alternate)).toThrow('viewport failed');
        throwViewport = false;
        expect(proxies(scene)).toHaveLength(0);
      }
    });
    value.getViewport = target => { if (throwViewport) throw new Error('viewport failed'); return target.set(0, 0, 1280, 720); };
    value.render(scene, camera);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
    expect(proxies(scene)).toHaveLength(0);
    value.dispose();
  });

  it('disposes the renderer even when an owned buffer dispose listener throws', () => {
    const { scene, camera } = fixture();
    const { value, dispose } = renderer(() => {
      proxies(scene)[0].addEventListener('dispose', () => { throw new Error('buffer cleanup failed'); });
    });
    value.render(scene, camera);
    expect(() => value.dispose()).toThrow('buffer cleanup failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(renderPerformanceStats(value).retainedScenes).toBe(0);
  });

  it('shares one scene collection, retains inherited group order and recollects after hierarchy changes', () => {
    const { scene, camera, meshes, geometry, material } = fixture(), parent = new Group();
    parent.renderOrder = 7; scene.add(parent); parent.add(...meshes);
    const traverse = vi.spyOn(scene, 'traverseVisible');
    const { value } = renderer(() => {
      const combined = proxies(scene); expect(combined).toHaveLength(1); expect(combined[0].parent!.renderOrder).toBe(parent.renderOrder);
    });
    value.render(scene, camera);
    expect(traverse).not.toHaveBeenCalled();
    meshes[0].removeFromParent(); parent.add(new Mesh(geometry, material)); parent.renderOrder = 11;
    value.render(scene, camera); expect(traverse).not.toHaveBeenCalled(); value.dispose();
  });

  it.each([true, false])('preserves hierarchy-mutating matrix callbacks on %s-visible branches', visible => {
    const { scene, camera, meshes } = fixture(), custom = new Group(); custom.visible = visible; scene.add(custom);
    custom.updateMatrixWorld = function(force) { meshes[0].removeFromParent(); Object3D.prototype.updateMatrixWorld.call(this, force); };
    const { value } = renderer(() => { scene.updateMatrixWorld(); expect(proxies(scene)).toHaveLength(0); });
    value.render(scene, camera); expect(meshes[0].parent).toBeNull(); value.dispose();
  });

  it('accepts standard camera and skinned-mesh matrix methods in a shared scene collection', () => {
    const { scene, camera, geometry, material } = fixture();
    scene.add(camera, new SkinnedMesh(geometry, material));
    const { value } = renderer(() => { expect(proxies(scene)).toHaveLength(1); });
    value.render(scene, camera); value.dispose();
  });

  it('preserves authored Three LOD selection that changes child visibility inside render-list construction', () => {
    const { scene, camera, geometry, material } = fixture(), lod = new LOD();
    lod.addLevel(new Mesh(geometry, material), 0); lod.addLevel(new Mesh(geometry, material), 20); scene.add(lod);
    const { value } = renderer(() => { expect(proxies(scene)).toHaveLength(0); camera.updateMatrixWorld(); lod.update(camera); });
    value.render(scene, camera); camera.position.z = 30; value.render(scene, camera);
    expect(lod.levels[0].object.visible).toBe(false); expect(lod.levels[1].object.visible).toBe(true); value.dispose();
  });

  it('inherits Group rendering order only through layers selected by the current camera', () => {
    const { scene, camera, meshes } = fixture(), parent = new Group(); parent.layers.set(2); parent.renderOrder = 8;
    parent.add(...meshes); scene.add(parent); let expected = 0;
    const { value } = renderer(() => {
      const proxy = proxies(scene)[0]; expect(proxy.parent!.renderOrder).toBe(expected);
      expect(proxy.parent!.layers.test(camera.layers)).toBe(true);
    });
    value.render(scene, camera);
    camera.layers.enable(2); expected = 8; value.render(scene, camera);
    camera.layers.set(2); for (const mesh of meshes) mesh.layers.set(2); value.render(scene, camera);
    value.dispose();
  });
});
