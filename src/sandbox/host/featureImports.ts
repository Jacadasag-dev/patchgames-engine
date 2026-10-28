import {parse} from '@babel/parser';
import {posix} from 'node:path';
import type {SourceTree} from '../../shared/customGames.ts';
import {featureIdForPath, type SourceFeature} from '../../shared/featureManifest.ts';
import {allowedGameImport} from '../libraries.ts';
const trustedHelpers = new Set(['firearms', 'firearmView', 'firearmPose', 'firearmModels', 'materialRecipes', 'audio', 'features', 'battleRoyale', 'characters', 'physics', 'rig', 'rigView', 'inspectionFocus', 'inspectionGeometry', 'inspectionTelemetry', 'actorAnimation', 'actorLocomotion', 'animation', 'animationView', 'equipmentView', 'equipmentOrientation', 'equipmentMotion', 'humanoidRig', 'animationLibrary', 'creatureRigs', 'creatureAnimationLibrary', 'creatureAnimationView', 'creatureModelView', 'creatureMotion', 'creatureFootPlacement', 'flight', 'locomotion', 'motionMatching', 'animationImport', 'model', 'modelView', 'modelStarters', 'spawnView', 'lighting', 'terrain', 'terrainView', 'terrainPresets', 'terrainQueries', 'testkit']);

trustedHelpers.add('objectPool');
trustedHelpers.add('gameUi');
trustedHelpers.add('gameScenes');
trustedHelpers.add('scenePresets');
for (const helper of ['terrainVolumes', 'terrainVolumesView']) trustedHelpers.add(helper);
for (const helper of ['waterWorld', 'buildingWaterGeometry']) trustedHelpers.add(helper);
for (const helper of ['voxels', 'voxelWorld', 'voxelView']) trustedHelpers.add(helper);
for (const helper of ['building', 'buildingView', 'city']) trustedHelpers.add(helper);
for (const helper of ['assetFamilies', 'assetFamilyPresets', 'assetFamilyView', 'furnishing', 'town']) trustedHelpers.add(helper);
trustedHelpers.add('assetDressing');
trustedHelpers.add('variation');
for (const helper of ['deformation', 'deformationView', 'water', 'waterView', 'waterDomain', 'liquidCoupling', 'proceduralWater']) trustedHelpers.add(helper);
for (const helper of ['waterBody', 'waterBodyBuoyancy', 'waterBodyFloating', 'waterBodyPipes', 'waterBodyConnections', 'waterBodyFlights', 'waterBodyView', 'waterBodyWire', 'waterPlayback']) trustedHelpers.add(helper);
for (const helper of ['waterSystem', 'waterSystemDestruction', 'waterSystemBake', 'waterSystemView', 'waterSystemWire', 'terrainChannels', 'waterBodyPuddles']) trustedHelpers.add(helper);
trustedHelpers.add('waterCurrentLinesView');
trustedHelpers.add('waterBodyDepthCurrents');
for (const helper of ['waterDetail', 'waterDetailView', 'waterTerrainEffectsView', 'waterImpactPlumes', 'waterFlightMesh', 'waterFlightJunction', 'waterSurfaceOptics']) trustedHelpers.add(helper);
for (const helper of ['destruction', 'buildingDestruction', 'destructionView', 'fracture', 'fractureView', 'structuralFracture', 'proceduralDestruction', 'proceduralDestructionView', 'physicsGeometry', 'physicsMassProperties']) trustedHelpers.add(helper);
for (const helper of ['worldPlan', 'worldRoads', 'worldPlanView']) trustedHelpers.add(helper);
for (const helper of ['buildingLayout', 'buildingFootprints', 'buildingSlabs', 'buildingAttachments', 'buildingFixtures', 'buildingDoors']) trustedHelpers.add(helper);
for (const helper of ['mapAssembly', 'mapAssemblyView']) trustedHelpers.add(helper);
for (const helper of ['surfaceMaterials', 'surfaceMaterialView', 'terrainMaterialView']) trustedHelpers.add(helper);
for (const helper of ['spatial', 'assetGroups', 'terrainAssets', 'terrainAreas']) trustedHelpers.add(helper);

/** Native features must be portable without borrowing undeclared season internals. */
export function validateFeatureImports(features: readonly SourceFeature[], files: SourceTree = Object.assign(Object.create(null), ...features.map(feature => feature.files))): void {
    for (const feature of features) for (const [path, source] of Object.entries(feature.files)) {
      if (!path.endsWith('.ts')) continue;
      const check = (specifier: unknown) => {
        if (typeof specifier !== 'string') throw new Error(`Feature ${feature.manifest.id} uses a computed import in ${path}; use a static import so dependencies can be packaged.`);
        if (!specifier.startsWith('.')) {
          if (!allowedGameImport(specifier, true)) throw new Error(`Feature ${feature.manifest.id} imports unsupported package ${specifier}.`);
          return;
        }
        const raw = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (raw.startsWith('src/shared/') || raw.startsWith('src/sandbox/') && trustedHelpers.has(raw.slice('src/sandbox/'.length).replace(/\.(?:js|ts)$/, ''))) return;
        const target = [raw, raw.replace(/\.js$/, '.ts'), raw + '.ts', raw + '/index.ts'].find(candidate => Object.hasOwn(files, candidate));
        const targetId = featureIdForPath(target ?? raw);
        if (!targetId || targetId !== feature.manifest.id && !feature.manifest.requires?.includes(targetId)) throw new Error(`Feature ${feature.manifest.id} imports ${specifier} outside its package. Put reusable code in a feature and declare it in requires.`);
        if (!target) throw new Error(`Feature ${feature.manifest.id} is missing imported file ${specifier} in ${path}.`);
      };
      const syntax = parse(source, {sourceType: 'module', plugins: ['typescript']});
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {for (const item of value) visit(item); return;}
        const node = value as {type?: string; source?: {value?: unknown}; callee?: {type?: string; name?: string}; arguments?: {value?: unknown}[]; argument?: {value?: unknown}; moduleReference?: {type?: string; expression?: {value?: unknown}}};
        if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type ?? '') && node.source) check(node.source.value);
        if (node.type === 'ImportExpression') check(node.source?.value);
        if (node.type === 'TSImportType') check(node.argument?.value);
        if (node.type === 'TSImportEqualsDeclaration' && node.moduleReference?.type === 'TSExternalModuleReference') check(node.moduleReference.expression?.value);
        if (node.type === 'CallExpression' && (node.callee?.type === 'Import' || node.callee?.type === 'Identifier' && node.callee.name === 'require')) check(node.arguments?.[0]?.value);
        for (const [key, child] of Object.entries(value)) if (!['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) visit(child);
      };
      visit(syntax.program);
    }
}
