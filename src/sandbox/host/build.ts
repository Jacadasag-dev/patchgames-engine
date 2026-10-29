import { buildSync, type Metafile } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedGameImport, GAME_LIBRARIES, RAPIER_PACKAGE } from '../libraries.ts';
import { scanFeatures, FEATURE_DIRECTORY, FEATURE_ORDER_PATH, type SourceFeature } from '../../shared/featureManifest.ts';
import { validateFeatureImports } from './featureImports.ts';
import { quickJSReady, Sandbox } from './quickjs.ts';
import { GAME_LOGIC_CODE_MAX_BYTES, GAME_WORLD_PLAN_MAX_BYTES } from '../../shared/customGames.ts';
import { readRosterFile } from '../../shared/rosterFile.ts';
import { normalizeTags } from '../../shared/gameTags.ts';
import { packageViewRendererBundle, VIEW_RENDERER_MAX_PAYLOAD_BYTES, VIEW_RENDERER_MAX_PACKAGE_BYTES,
  type ViewRendererAlternative } from '../../shared/rendererBundle.ts';

// Bundles the game module for its sandboxes. Bundling only reads and
// transforms files; no game code runs here. The bundle may contain only the
// game module's own files, the sandbox runtime, and approved game libraries:
// any other import (the Patch Engine, Node, other packages) is refused, so game
// code can't bring anything into the sandbox that it doesn't already have.

export const GAME_DIR = 'src/game';
export const GAME_TESTS_DIR = 'tests/game';

// The locked files that go into bundles: the build root's own copies when
// it has them (see entryFile), else this checkout's, wherever the game module is.
const SANDBOX_DIR = fileURLToPath(new URL('..', import.meta.url));
const sandboxFile = (name: string) => join(SANDBOX_DIR, name);
const NODE_MODULES = resolve(SANDBOX_DIR, '../../node_modules');
/**
 * Paths compare by their real location: agent worktrees link node_modules (a
 * junction on Windows). Falls back to the path itself when it doesn't exist
 * (a production server bundles this module but never builds).
 */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
/** src/sandbox files that run inside the sandboxes, next to game code. */
const SANDBOX_NAMES = ['media.ts', 'materialRecipes.ts', 'audio.ts', 'lockdown.ts', 'match.ts', 'runtime.ts', 'testkit.ts', 'testRuntime.ts', 'viewRuntime.ts', 'viewDiagnostics.ts', 'inspectionFocus.ts', 'inspectionCamera.ts', 'inspectionGeometry.ts', 'inspectionTelemetry.ts', 'features.ts', 'featureViewHost.ts', 'playerAppearance.ts', 'characters.ts', 'physics.ts', 'rig.ts', 'rigView.ts', 'actorAnimation.ts', 'actorLocomotion.ts', 'animation.ts', 'animationView.ts', 'equipmentView.ts', 'equipmentOrientation.ts', 'equipmentMotion.ts', 'humanoidRig.ts', 'animationLibrary.ts', 'defaultLocomotionData.ts', 'creatureRigs.ts', 'creatureAnimationLibrary.ts', 'creatureAnimationView.ts', 'creatureModelView.ts', 'creatureModelData.ts', 'creatureMotion.ts', 'creatureFootPlacement.ts', 'flight.ts', 'creatureAnimationData.ts', 'locomotion.ts', 'motionMatching.ts', 'animationImport.ts', 'model.ts', 'modelView.ts', 'modelRuntime.ts', 'modelStarters.ts', 'spawnView.ts', 'lighting.ts', 'terrain.ts', 'terrainView.ts', 'terrainPresets.ts', 'terrainQueries.ts', 'terrainWorld.ts', 'terrainStreaming.ts', 'preparationTransfer.ts', 'health.ts', 'damage.ts', 'battleRoyale.ts'];
SANDBOX_NAMES.push('audioListener.ts', 'terrainEnvironment.ts', 'terrainWindView.ts', 'environmentRuntime.ts');
SANDBOX_NAMES.push('terrainVolumes.ts', 'terrainVolumesView.ts');
SANDBOX_NAMES.push('waterWorld.ts', 'waterWorldDetail.ts', 'buildingWaterGeometry.ts', 'waterSupportGeometry.ts');
SANDBOX_NAMES.push('voxels.ts', 'voxelWorld.ts', 'voxelView.ts');
SANDBOX_NAMES.push('building.ts', 'buildingView.ts', 'city.ts');
SANDBOX_NAMES.push('assetFamilies.ts', 'assetFamilyPresets.ts', 'assetFamilyView.ts', 'furnishing.ts', 'town.ts');
SANDBOX_NAMES.push('worldPlan.ts', 'worldRoads.ts', 'worldPlanView.ts', 'worldFoundations.ts');
SANDBOX_NAMES.push('buildingLayout.ts', 'buildingFootprints.ts', 'buildingSlabs.ts', 'buildingAttachments.ts', 'buildingFixtures.ts', 'buildingDoors.ts');
SANDBOX_NAMES.push('mapAssembly.ts', 'mapAssemblyView.ts');
SANDBOX_NAMES.push('assetDressing.ts');
SANDBOX_NAMES.push('variation.ts');
SANDBOX_NAMES.push('deformation.ts', 'deformationView.ts', 'water.ts', 'waterView.ts', 'waterDomain.ts', 'liquidCollision.ts', 'liquidCoupling.ts', 'liquidFlowShading.ts', 'proceduralWater.ts');
SANDBOX_NAMES.push('waterBody.ts', 'waterBodyGrid.ts', 'waterBodyCapillary.ts', 'waterBodyCurrents.ts', 'waterCurrentShader.ts', 'waterBodyDispersion.ts', 'waterBodyPressure.ts', 'waterBodyHulls.ts', 'waterBodySolids.ts', 'waterBodyBuoyancy.ts', 'waterBodyFloating.ts', 'waterBodyPipes.ts', 'waterBodyView.ts', 'waterBodyWire.ts', 'waterPlayback.ts');
SANDBOX_NAMES.push('waterSystem.ts', 'waterSystemDestruction.ts', 'waterSystemBake.ts', 'waterSystemView.ts', 'waterSystemWire.ts', 'terrainChannels.ts', 'waterBodyPuddles.ts', 'waterBodyConnections.ts', 'waterBodyFlights.ts');
SANDBOX_NAMES.push('waterCurrentLinesView.ts');
SANDBOX_NAMES.push('waterSystemBridge.ts');
SANDBOX_NAMES.push('waterSystemTransfer.ts');
SANDBOX_NAMES.push('waterWind.ts', 'waterSwell.ts', 'waterBodyContour.ts');
SANDBOX_NAMES.push('waterBodyDepthCurrents.ts');
SANDBOX_NAMES.push('waterBoundary.ts', 'waterBoundaryGeometry.ts', 'waterBoundaryView.ts', 'waterBodyBoundaryMesh.ts', 'waterTerrainEffectsView.ts');
SANDBOX_NAMES.push('waterBodyCells.ts', 'waterBodyGridRegions.ts', 'waterBodyDepthGraph.ts', 'waterBodyTerrainPartitions.ts', 'waterBodyRegionStorage.ts');
// Cosmetic water detail (spray, foam, mist, bubbles) and the displayed-surface sampler.
SANDBOX_NAMES.push('waterDetail.ts', 'waterDetailView.ts', 'waterImpactPlumes.ts', 'waterFlightMesh.ts', 'waterFlightJunction.ts', 'waterSurfaceOptics.ts');

SANDBOX_NAMES.push('destruction.ts', 'buildingDestruction.ts', 'destructionView.ts', 'fracture.ts', 'fractureView.ts', 'structuralFracture.ts', 'proceduralDestruction.ts', 'proceduralDestructionView.ts', 'physicsGeometry.ts', 'physicsMassProperties.ts');
SANDBOX_NAMES.push('surfaceMaterials.ts', 'surfaceMaterialView.ts', 'terrainMaterialView.ts');
SANDBOX_NAMES.push('spatial.ts', 'assetGroups.ts', 'terrainAssets.ts', 'terrainAreas.ts', 'terrainDependencies.ts');
SANDBOX_NAMES.push('objectPool.ts', 'renderPerformance.ts', 'renderPerformanceRuntime.ts', 'renderBatching.ts', 'renderVisibility.ts');
SANDBOX_NAMES.push('renderMaterialIdentity.ts', 'renderGeometryIdentity.ts');
SANDBOX_NAMES.push('renderCompletion.ts', 'rendererWebGPU.ts', 'rendererPipelineCache.ts', 'rendererShaderNames.ts', 'webgpuViewRuntime.ts');
SANDBOX_NAMES.push('rendererUniformUploads.ts', 'renderProxyIdentity.ts', 'rendererBundles.ts');
SANDBOX_NAMES.push('firearms.ts', 'firearmView.ts', 'firearmPose.ts','firearmModels.ts');
SANDBOX_NAMES.push('gameUi.ts');
SANDBOX_NAMES.push('gameScenes.ts');
SANDBOX_NAMES.push('scenePresets.ts');
const SANDBOX_FILES = new Set(SANDBOX_NAMES.map((name) => real(sandboxFile(name))));
const GAME_API = real(fileURLToPath(new URL('../../shared/gameApi.ts', import.meta.url)));
const FEATURE_API = real(fileURLToPath(new URL('../../shared/gameFeatures.ts', import.meta.url)));
const SHAPES = real(fileURLToPath(new URL('../../shared/shapes.ts', import.meta.url)));

/**
 * A sandbox runtime file for a bundle built from `root`: the root's own copy
 * when it has one (game tests import the test kit from there, and the
 * lockdown must run exactly once), else this core's.
 */
function entryFile(root: string, name: string): string {
  const own = resolve(root, 'src/sandbox', name);
  return existsSync(own) ? own : sandboxFile(name);
}

/**
 * The locked files a bundle built from `root` may contain: this core's own,
 * and the build root's copies, which game tests reach by relative import
 * (in an agent worktree those are the worktree's, identical because the
 * pipeline refuses any change to them).
 */
function lockedInputs(root: string): Set<string> {
  return new Set([
    // Optional host-owned data adapters. Authored games cannot write these paths.
    // Hosts can retain separately licensed asset banks without forking the engine.
    real(resolve(root, 'src/sandbox/hostAssets.ts')),
    ...SANDBOX_FILES,
    ...['gameScenes.ts','gameUi.ts','gameUiEvents.ts','mediaAssets.ts','mediaAssetData.ts','mediaRecipes.ts','materialRecipeData.ts','materialRecipeRenderer.ts','soundRecipes.ts','soundRecipeRenderer.ts','soundPitch.ts','soundBehavior.ts','soundAudition.ts','soundBehaviorPreview.ts','mediaRecipeExamples.ts','pointerLook.ts','roundSeries.ts','statePaths.ts','voicePolicy.ts','fastLane.ts'].flatMap(name => [real(resolve(root, 'src/shared', name)), real(fileURLToPath(new URL('../../shared/'+name, import.meta.url)))]),
    GAME_API,
    FEATURE_API,
    SHAPES,
    real(fileURLToPath(new URL('../../shared/gameModes.ts', import.meta.url))),
    real(fileURLToPath(new URL('../../shared/gameTags.ts', import.meta.url))),
    ...SANDBOX_NAMES.map((name) => real(resolve(root, 'src/sandbox', name))),
    real(resolve(root, 'src/shared/gameApi.ts')),
    real(resolve(root, 'src/shared/gameFeatures.ts')),
    real(resolve(root, 'src/shared/shapes.ts')),
    real(resolve(root, 'src/shared/gameModes.ts')),
    real(resolve(root, 'src/shared/gameTags.ts')),
  ]);
}
// Resolve approved package roots from actual installed entries, including nested
// development checkouts without their own node_modules. Never trust a prefix
// match on a package name or allow arbitrary transitive dependencies.
function packageDirectory(name: string, from: string): string {
  try {
    let dir = dirname(createRequire(from).resolve(name));
    while (dirname(dir) !== dir) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return real(dir);
      dir = dirname(dir);
    }
  } catch { /* Bundled production servers do not build game sources. */ }
  return real(join(NODE_MODULES, name));
}
const LIBRARY_DIRS = GAME_LIBRARIES.map(library => ({ ...library, dir: packageDirectory(library.name, import.meta.url) }));
const LIBRARY_MODULES = [...new Set(LIBRARY_DIRS.map(library => resolve(library.dir, ...library.name.split('/').map(() => '..'))))];
const MAX_LOGIC_BYTES = GAME_LOGIC_CODE_MAX_BYTES;
const MAX_VIEW_BYTES = VIEW_RENDERER_MAX_PAYLOAD_BYTES;

export interface Violation {
  file: string;
  message: string;
}

/** The bundle would reach outside the game module (or doesn't build). */
export class BoundaryError extends Error {
  readonly violations: Violation[];
  constructor(violations: Violation[]) {
    super(`The game module must stay inside its boundary:\n${violations.map((v) => `  ${v.file}: ${v.message}`).join('\n')}`);
    this.name = 'BoundaryError';
    this.violations = violations;
  }
}

interface BuildTarget {
  root: string;
  /** Generated entry: imports in evaluation order. */
  entry: string;
  /** Directories (relative to root) whose .ts/.json files may be bundled. */
  allowedDirs: string[];
  view: boolean;
  minify: boolean;
  maxBytes: number;
  inputs?: (files: string[]) => void;
  /** Lightweight readiness only: inspect the source dependency graph, leaving
   * approved packages external and discarding the compiler's temporary output. */
  boundaryOnly?:boolean;
  rendererBackend?: 'webgpu';
}

const toPosix = (path: string) => path.split('\\').join('/');
const importPath = (root: string, file: string) => JSON.stringify(toPosix(resolve(root, file)));
function isInside(file: string, dir: string): boolean {
  const path = relative(dir, file);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function bundle(target: BuildTarget): string {
  // First pass with every package left external, so an import of one names
  // the game file that made it (rather than failing deep inside the package).
  const outline = esbuild(target, true);
  const violations = checkInputs(outline.metafile, target);
  if (violations.length) throw new BoundaryError(violations);
  if(target.boundaryOnly)return '';
  const usesPackages = Object.values(outline.metafile.inputs).some((input) => input.imports.some((imported) => imported.external));
  if (target.view && Object.values(outline.metafile.inputs).some(input => input.imports.some(i => i.path === RAPIER_PACKAGE))) {
    target = { ...target, entry: target.entry.replace('start(createView);',
      `import { init as initializeRapier } from '${RAPIER_PACKAGE}';\nstart(createView, initializeRapier);`) };
  }
  const result = usesPackages ? esbuild(target, false) : outline;

  violations.push(...checkInputs(result.metafile, target));
  const code = result.outputFiles[0].text;
  if (Buffer.byteLength(code) > target.maxBytes) {
    violations.push({ file: '(bundle)', message: `is ${Buffer.byteLength(code)} bytes; the limit is ${target.maxBytes}` });
  }
  if (violations.length) throw new BoundaryError(violations);
  target.inputs?.(Object.keys(result.metafile.inputs).map(file => toPosix(relative(target.root, resolve(target.root, file)))));
  return code;
}

function esbuild(target: BuildTarget, packagesExternal: boolean) {
  try {
    return buildSync({
      stdin: { contents: target.entry, resolveDir: target.root, sourcefile: '<entry>', loader: 'ts' },
      absWorkingDir: target.root,
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      target: 'es2022',
      minify: target.minify,
      legalComments: 'none',
      logLevel: 'silent',
      charset: 'utf8',
      // Exact paths mapping leaves `three/webgpu` and addons untouched. esbuild's
      // alias option also rewrites subpaths, which would recurse into this facade.
      ...(target.rendererBackend === 'webgpu' ? { tsconfigRaw: { compilerOptions: {
        baseUrl: target.root, verbatimModuleSyntax: true,
        paths: { three: [entryFile(target.root, 'rendererWebGPU.ts')] },
      } } } : {}),
      // three.js resolves from this checkout even when the game module is elsewhere.
      nodePaths: [NODE_MODULES, ...LIBRARY_MODULES],
      ...(packagesExternal ? { packages: 'external' as const } : {}),
    });
  } catch (error) {
    const errors = (error as { errors?: { text: string; location?: { file: string; line: number } | null }[] }).errors ?? [];
    throw new BoundaryError(errors.length
      ? errors.map((e) => ({ file: e.location ? `${toPosix(e.location.file)}:${e.location.line}` : '(bundle)', message: e.text }))
      : [{ file: '(bundle)', message: String(error) }]);
  }
}

function checkInputs(metafile: Metafile, target: BuildTarget): Violation[] {
  const violations: Violation[] = [];
  const locked = lockedInputs(target.root);
  const packageDirs = LIBRARY_DIRS.filter(library => target.view || library.logic).flatMap(library => [
    library.dir, packageDirectory(library.name, resolve(target.root, 'package.json')),
  ]);
  const allowed = (file: string) => {
    if (file === '<entry>') return true;
    const path = real(resolve(target.root, file));
    if (locked.has(path)) return true;
    if (/\.(?:mjs|cjs|js)$/.test(path) && packageDirs.some(dir => isInside(path, dir))) return true;
    return target.allowedDirs.some((dir) => isInside(path, real(resolve(target.root, dir))))
      && (path.endsWith('.ts') || path.endsWith('.json')) && !path.endsWith('.d.ts');
  };
  const allowedPackage = (name: string) => allowedGameImport(name, target.view);
  for (const [file, input] of Object.entries(metafile.inputs)) {
    for (const imported of input.imports) {
      if (imported.external ? !allowedPackage(imported.path) : !allowed(imported.path)) {
        violations.push({ file: toPosix(file), message: `imports ${imported.original ?? imported.path}, which is outside the game module` });
      }
    }
  }
  for (const file of Object.keys(metafile.inputs)) {
    if (!allowed(file) && !violations.some((v) => v.message.includes(file))) {
      violations.push({ file: toPosix(file), message: 'is outside the game module' });
    }
  }
  return violations;
}

/** Read manifests as data. User feature modules only execute in their sandboxes. */
function sourceFeatures(root: string, gameDir: string): SourceFeature[] {
  const sources: Record<string,string> = Object.create(null);
  for (const file of listFiles(resolve(root, gameDir, 'features'), /\.(ts|json)$/)) {
    const canonical=FEATURE_DIRECTORY + toPosix(relative(resolve(root, gameDir, 'features'), file));
    let source=readFileSync(file,'utf8');
    // Validation uses canonical feature paths even when a trusted starter lives
    // under another directory. Preserve the same resolved engine import target.
    if(gameDir!==GAME_DIR)source=source.replace(/(['"])((?:\.\.\/)+(?:sandbox|shared)\/[^'"\n]+)\1/g,(_all,quote,specifier)=>{
      const target=resolve(dirname(file),specifier),relativeTarget=toPosix(relative(resolve(root),target));
      if(!relativeTarget.startsWith('src/sandbox/')&&!relativeTarget.startsWith('src/shared/'))return quote+specifier+quote;
      return quote+toPosix(relative(dirname(resolve(root,canonical)),target))+quote;
    });
    sources[canonical]=source;
  }
  const order = resolve(root, gameDir, 'feature-order.json');
  if (existsSync(order)) sources[FEATURE_ORDER_PATH] = readFileSync(order, 'utf8');
  try { const features = scanFeatures(sources); validateFeatureImports(features); return features; }
  catch (error) { throw new BoundaryError([{file: gameDir + '/features', message: (error as Error).message}]); }
}

/** Identical feature registration drives authority, controls, views and request tests. */
function featureEntry(root: string, gameDir: string, features: SourceFeature[], view = false) {
  const imports: string[] = [], registrations: string[] = [];
  features.forEach(({manifest,directory,files}, priority) => {
    const path = (file: string) => importPath(root, gameDir + '/' + directory.slice('src/game/'.length) + file);
    imports.push(`import feature${priority} from ${path('logic.ts')};`);
    const hasView = view && Object.hasOwn(files, directory + 'view.ts');
    if (hasView) imports.push(`import featureView${priority} from ${path('view.ts')};`);
    registrations.push(`{id:${JSON.stringify(manifest.id)},name:${JSON.stringify(manifest.name)},priority:${priority},requires:${JSON.stringify(manifest.requires ?? [])},config:${JSON.stringify(manifest.config ?? {})},${view ? `definition:feature${priority}${hasView ? `,feature:featureView${priority}` : ''}` : `feature:feature${priority}`}}`);
  });
  return {imports, list: '[' + registrations.join(',') + ']'};
}

// Present only in bundles that include the world-plan compiler.
const WORLD_PLAN_CAPTURE = '__patchduelWorldPlanCapture';
/** Evaluate an executable bundle once, with a bounded build-time budget, and embed
 * every defineWorldPlan result it produces while loading. Live sandboxes then
 * read that data instead of generating and compiling the plan in the
 * interpreter, which on a 2 GHz release host used most of the 1 s load budget.
 * The plans travel inside the bundle, so every runtime (match workers,
 * inspection, replay, authored tests) gets them. Each exact bundle captures its
 * own data: matching plan IDs in different sources never share a cache. A bundle
 * without the compiler is returned unchanged; compiler bundles require the host
 * to initialize QuickJS before building, rather than silently defer expensive
 * preparation to a runtime load. Only module initialization runs here, not test
 * callbacks or gameplay steps. Direct compiler calls remain direct calls. */
export function precompileWorldPlans(source: string): string {
  if (!source.includes(WORLD_PLAN_CAPTURE)) return source;
  if (!quickJSReady()) throw new BoundaryError([{ file: 'world plans', message: 'Initialize QuickJS with await initSandbox() before building executable world-plan or map-assembly bundles.' }]);
  const plans: Record<string, string> = Object.create(null);
  let bytes = 0, oversized = false, duplicate = '';
  new Sandbox(source, [], { loadMs: 30_000, memoryBytes: 64 * 1024 * 1024 }, undefined, [], { worldPlanCapture: (key, json) => {
    if (key in plans) { duplicate ||= key; return; }
    if (oversized) return;
    bytes += key.length + json.length;
    if (bytes > GAME_WORLD_PLAN_MAX_BYTES) { oversized = true; return; }
    plans[key] = json;
  } }).dispose();
  if (duplicate) throw new BoundaryError([{ file: 'world plans', message: `World plan "${duplicate}" is defined more than once; give each plan its own ID.` }]);
  if (oversized) throw new BoundaryError([{ file: 'world plans', message: `Compiled world plans exceed ${GAME_WORLD_PLAN_MAX_BYTES / 1024 / 1024} MiB; split or simplify them.` }]);
  if (!Object.keys(plans).length) return source;
  // Defined first and non-writable, so game code cannot replace the store.
  return `Object.defineProperty(globalThis,'__patchduelWorldPlans',{value:Object.freeze(${JSON.stringify(plans)})});
${source}`;
}

/** Game logic for QuickJS: lockdown, then the game, then the runtime that publishes entry points. */
export function buildLogic(root: string, gameDir = GAME_DIR, inputs?: (files: string[]) => void,boundaryOnly=false): string {
  const source = bundleLogic(root, gameDir, inputs, boundaryOnly);
  return boundaryOnly ? source : precompileWorldPlans(source);
}

/** Full dependency/size validation without executing module initializers. */
function bundleLogic(root: string, gameDir: string, inputs?: (files: string[]) => void,boundaryOnly=false): string {
  const features = sourceFeatures(root, gameDir), entry = featureEntry(root, gameDir, features);
  const source = bundle({
    root,boundaryOnly,
    entry: [
      `import ${importPath(root, entryFile(root, 'lockdown.ts'))};`,
      `import game from ${importPath(root, `${gameDir}/logic.ts`)};`,
      `import { install } from ${importPath(root, entryFile(root, 'runtime.ts'))};`,
      ...entry.imports,
      ...(features.length ? [`import { composeGame } from ${importPath(root, entryFile(root, 'features.ts'))};`, `install(composeGame(game,${entry.list}));`] : ['install(game);']),
    ].join('\n'),
    allowedDirs: [gameDir],
    view: false,
    minify: false,
    maxBytes: MAX_LOGIC_BYTES, inputs,
  });
  return source;
}

/** The game view for its sandboxed Web Worker, with three.js. */
export function buildView(root: string, gameDir = GAME_DIR, inputs?: (files: string[]) => void,boundaryOnly=false): string {
  const features = sourceFeatures(root, gameDir), entry = featureEntry(root, gameDir, features, true);
  let baselineInputs: string[] = [];
  const target: BuildTarget = {
    root,boundaryOnly,
    entry: [
      `import ${importPath(root, entryFile(root, 'renderPerformanceRuntime.ts'))};`,
      `import baseView from ${importPath(root, `${gameDir}/view.ts`)};`,
      `import { start } from ${importPath(root, entryFile(root, 'viewRuntime.ts'))};`,
      ...entry.imports,
      ...(features.length ? [
        `import { composeFeatureViews } from ${importPath(root, entryFile(root, 'features.ts'))};`,
        `import { withFeatureViewHost } from ${importPath(root, entryFile(root, 'featureViewHost.ts'))};`,
        `const createView=composeFeatureViews(withFeatureViewHost(baseView),${entry.list});`,
      ] : ['const createView=baseView;']),
      'start(createView);',
    ].join('\n'),
    allowedDirs: [gameDir],
    view: true,
    minify: true,
    maxBytes: MAX_VIEW_BYTES, inputs: files => { baselineInputs = files; },
  };
  const code = bundle(target);
  if (boundaryOnly) return code;
  const compatibility = webGPUCompatibility(root, gameDir, baselineInputs);
  let alternative: ViewRendererAlternative = compatibility;
  if (compatibility.compatibility === 'passed') {
    try {
      const alternate = bundle({ ...target, rendererBackend: 'webgpu',
        entry: target.entry.replace(importPath(root, entryFile(root, 'viewRuntime.ts')),
          importPath(root, entryFile(root, 'webgpuViewRuntime.ts'))),
        inputs: files => { baselineInputs = [...new Set([...baselineInputs, ...files])]; } });
      alternative = { ...compatibility, code: alternate, payloadHash: createHash('sha256').update(alternate).digest('hex') };
    } catch (error) {
      // A newly authored unsupported Three API must never break an otherwise
      // valid baseline game. All source boundary checks already passed above;
      // the alternate undergoes those same checks and cannot bypass them.
      if (!(error instanceof BoundaryError)) throw error;
      const first = error.violations[0];
      alternative = { compatibility: 'unsupported', reason: `The WebGPU alternate did not build: ${first ? `${first.file}: ${first.message}` : error.message}`.slice(0, 400) };
    }
  }
  inputs?.(baselineInputs);
  const hash = createHash('sha256').update(code).digest('hex');
  let packaged = packageViewRendererBundle(code, hash, alternative);
  // Each executable retains the original 8 MiB limit. Base64 is an inert
  // transport sidecar; exceeding the combined limit simply omits the alternate.
  if (Buffer.byteLength(packaged) > VIEW_RENDERER_MAX_PACKAGE_BYTES)
    packaged = packageViewRendererBundle(code, hash, { compatibility: 'unsupported', reason: 'The combined renderer package exceeds its size limit.' });
  return packaged;
}

/** Conservative source compatibility checks are automatic and fail closed.
 * Runtime replay checks remain necessary: static names cannot prove that every
 * future scene or dynamic material preserves appearance on another backend. */
function webGPUCompatibility(root: string, gameDir: string, files: readonly string[]): ViewRendererAlternative {
  const unsupported = /\b(?:ShaderMaterial|RawShaderMaterial|onBeforeCompile|customDepthMaterial|customDistanceMaterial|onBeforeShadow|onAfterShadow|PCFSoftShadowMap|PointsMaterial|dithering|WebGLRenderTarget|WebGLCubeRenderTarget|WebGLMultipleRenderTargets|WebGL3DRenderTarget|WebGLArrayRenderTarget|GLSL1|GLSL3)\b/;
  const rawContext = /\bgetContext\s*\(([^)]*)/g;
  const glAddon = /['"]three\/(?:addons|examples\/jsm)\/(?:postprocessing|shaders|renderers)\//;
  const authoredRoot = real(resolve(root, gameDir));
  for (const file of files) {
    const path = real(resolve(root, file));
    if (!isInside(path, authoredRoot) || !path.endsWith('.ts')) continue;
    const source = readFileSync(path, 'utf8');
    const match = source.match(unsupported)
      ?? [...source.matchAll(rawContext)].find(context => !/^\s*['"]2d['"]\s*(?:,|$)/.test(context[1]))
      ?? source.match(glAddon);
    if (match) return { compatibility: 'unsupported', reason: `WebGL-specific rendering feature ${match[0].slice(0, 80)} in ${toPosix(relative(root, path))}.` };
  }
  return { compatibility: 'passed', reason: 'The engine built both backends from the same game and found no known WebGL-only source features; device replay checks are still required.' };
}

/** One game test file for QuickJS, with the test kit and the game module. */
export function buildTest(root: string, testFile: string, gameDir = GAME_DIR, testsDir = GAME_TESTS_DIR,boundaryOnly=false): string {
  const source = bundleTest(root, testFile, gameDir, testsDir, boundaryOnly);
  return boundaryOnly ? source : precompileWorldPlans(source);
}

function bundleTest(root: string, testFile: string, gameDir: string, testsDir: string,boundaryOnly=false): string {
  // Object/geometry assertions use view libraries, still inside bounded QuickJS:
  // no WebGL, browser, filesystem or network capabilities are granted.
  const viewTest = testFile.endsWith('.view.test.ts');
  const features = sourceFeatures(root, gameDir), entry = featureEntry(root, gameDir, features);
  const ruleFile=join(root,'game-rules.json');
  const savedRules=existsSync(ruleFile)?JSON.parse(readFileSync(ruleFile,'utf8')):{};
  const rosterFile=join(root,gameDir,'roster.json');
  const roster=readRosterFile(existsSync(rosterFile)?readFileSync(rosterFile,'utf8'):undefined);
  const testRules={...(savedRules.tags?{tags:normalizeTags(savedRules.tags)}:{}),...(roster?{roster}:{})};
  return bundle({
    root,boundaryOnly,
    entry: [
      `import ${importPath(root, entryFile(root, 'lockdown.ts'))};`,
      `import { install } from ${importPath(root, entryFile(root, 'testRuntime.ts'))};`,
      `import { installTestRules } from ${importPath(root, entryFile(root, 'testkit.ts'))};`,
      `installTestRules(${JSON.stringify(testRules)});`,
      ...entry.imports,
      ...(features.length ? [`import { installTestFeatures } from ${importPath(root, entryFile(root, 'testkit.ts'))};`, `installTestFeatures(${entry.list});`] : []),
      // A static require is bundled as a deferred module initializer. This runs
      // top-level fixtures AFTER registration, still entirely inside QuickJS.
      `require(${importPath(root, testFile)});`,
      'install();',
    ].join('\n'),
    allowedDirs: [gameDir, testsDir],
    view: viewTest,
    minify: viewTest,
    maxBytes: viewTest ? MAX_VIEW_BYTES : MAX_LOGIC_BYTES,
  });
}

/** Declarative models execute only in bounded QuickJS, never in the build host. */
export function buildModel(root: string, file: string, gameDir = GAME_DIR,boundaryOnly=false): string {
  return bundle({ root,boundaryOnly, entry:[
    `import ${importPath(root, entryFile(root, 'lockdown.ts'))};`,
    `import model from ${importPath(root, file)};`,
    `import { install } from ${importPath(root, entryFile(root, 'modelRuntime.ts'))};`,
    'install(model);',
  ].join('\n'),allowedDirs:[gameDir],view:false,minify:false,maxBytes:MAX_LOGIC_BYTES });
}

export function modelFiles(root: string, gameDir = GAME_DIR): string[] {
  return listFiles(join(root,gameDir), /\.model\.ts$/).map(file => toPosix(relative(root,file)));
}

export function listFiles(dir: string, pattern: RegExp): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listFiles(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

export function gameTestFiles(root: string, testsDir = GAME_TESTS_DIR): string[] {
  return listFiles(join(root, testsDir), /\.test\.ts$/).map((file) => toPosix(relative(root, file)));
}

/**
 * Builds everything the game module ships (logic, view, tests) and returns
 * every boundary violation, without running any of it.
 */
export function checkGameBoundary(root: string, gameDir = GAME_DIR, testsDir = GAME_TESTS_DIR,options?:{dependencyOnly:boolean}): Violation[] {
  const violations: Violation[] = [];
  const attempt = (build: () => unknown) => {
    try {
      build();
    } catch (error) {
      if (!(error instanceof BoundaryError)) throw error;
      for (const violation of error.violations) {
        if (!violations.some((v) => v.file === violation.file && v.message === violation.message)) violations.push(violation);
      }
    }
  };
  attempt(() => bundleLogic(root, gameDir,undefined,options?.dependencyOnly));
  attempt(() => buildView(root, gameDir,undefined,options?.dependencyOnly));
  for (const file of gameTestFiles(root, testsDir)) attempt(() => bundleTest(root, file, gameDir, testsDir,options?.dependencyOnly));
  for (const file of modelFiles(root, gameDir)) attempt(() => buildModel(root, file, gameDir,options?.dependencyOnly));
  // Only code and tuning belong in the game module (no scripts, binaries or assets to load at runtime).
  for (const file of listFiles(join(root, gameDir), /./)) {
    const path = toPosix(relative(root, file));
    if (!/\.(ts|json)$/.test(path)) violations.push({ file: path, message: 'only .ts and .json files belong in the game module' });
  }
  return violations;
}
