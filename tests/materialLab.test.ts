import {it,expect} from 'vitest';
import {MATERIAL_LAB_PRESETS} from '../src/shared/materialLabPresets.ts';
import {generateMaterial,materialGeneratorSchema} from '../src/shared/materialGenerator.ts';
it('ships fifty distinct validated editable material demonstrations',async()=>{
  expect(MATERIAL_LAB_PRESETS).toHaveLength(50);expect(new Set(MATERIAL_LAB_PRESETS.map(p=>p.id)).size).toBe(50);
  const signatures=new Set<string>();
  for(const preset of MATERIAL_LAB_PRESETS){expect(materialGeneratorSchema.safeParse(preset.recipe).success,preset.id).toBe(true);const baked=await generateMaterial(preset.recipe,{resolution:32});signatures.add(Buffer.from(baked.color.data).toString('base64'));}
  expect(signatures.size).toBe(50);
});
