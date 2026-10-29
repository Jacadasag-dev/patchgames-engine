import {MeshPhysicalMaterial,Color} from 'three';
import type {MaterialOptics} from '../shared/materialGenerator.ts';
/** Reset all optical fields on every update, including glass-to-opaque changes. */
export function applyMaterialOptics(material:MeshPhysicalMaterial,optics?:MaterialOptics){
  material.transmission=optics?.transmission??0;material.ior=optics?.ior??1.5;
  material.thickness=optics?.thicknessMeters??0;
  material.attenuationColor.set(optics?.attenuationColor??'#ffffff');
  material.attenuationDistance=optics?.attenuationDistanceMeters??Infinity;
  material.envMapIntensity=optics?.envMapIntensity??1;material.needsUpdate=true;
}
export function copyMaterialOptics(target:MeshPhysicalMaterial,source:MeshPhysicalMaterial){
  target.transmission=source.transmission;target.ior=source.ior;target.thickness=source.thickness;
  target.attenuationColor.copy(source.attenuationColor??new Color('#ffffff'));
  target.attenuationDistance=source.attenuationDistance;target.envMapIntensity=source.envMapIntensity;target.needsUpdate=true;
}
