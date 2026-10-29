import type {SurfaceMaterialInput} from '../sandbox/surfaceMaterials.ts';

/** Original Juniper material direction. Shared catalog sources retain their
 * provenance; authored tints and metre-scale tiling keep the map readable. */
const surface=(name:string,asset:string,tile:number,tint='#ffffff',roughness=.88,metalness=0):SurfaceMaterialInput=>({
 tileSize:[tile,tile],tint,texture:{kind:'texture',version:1,name,resolution:128,seed:83,reliefScale:.008,normalStrength:.7,
 layers:[{source:{kind:'asset',id:asset},roughness,metalness,heightStrength:.65}]},
});
export const MAP_PALETTE={
 plaster:surface('Juniper pale lime plaster','texture.white-plaster',2.4,'#e7dcc0'),
 ochre:surface('Juniper western ochre plaster','texture.white-plaster',2.4,'#c7a075'),
 redwood:surface('Juniper warm clay plaster','texture.white-plaster',2.4,'#c4997f'),
 stone:surface('Juniper dressed limestone','texture.limestone-floor',2,'#a6b0a7'),
 paving:surface('Juniper courtyard stone','texture.worn-tiles',3,'#ded9c6'),
 earth:surface('Juniper gravel gardens','texture.river-gravel',2.5,'#c1b58f'),
 timber:surface('Juniper gallery boards','texture.wood-floor',2,'#bbab8e'),
 wood:surface('Juniper structural cedar','texture.dark-wood',2,'#b49a7b'),
 // An explicit paint coat replaces the dark bare-metal albedo. Multiplying
 // oxidized metal by a teal tint only darkens it; it does not create paint.
 crate:{tileSize:[1.4,1.4],texture:{kind:'texture',version:1,name:'Juniper teal painted reliquaries',resolution:128,seed:83,
  reliefScale:.004,normalStrength:.45,layers:[
   {source:{kind:'asset',id:'texture.oxidized-metal'},roughness:.8,metalness:.08,heightStrength:.45},
   {source:{kind:'solid',color:'#76a99b'},opacity:.78,roughness:.8,metalness:.08,heightStrength:0},
   {source:{kind:'noise',colors:['#91b7a7','#6a998c'],scale:24,seed:12},opacity:.12,roughness:.82,metalness:.08,heightStrength:.1},
  ]}},
 brass:surface('Juniper aged brass','texture.metal',1,'#d3b878',.45,.35),
 roof:{tileSize:[2.4,2.4],texture:{kind:'texture',version:1,name:'Juniper jade roof tiles',resolution:128,seed:83,
   reliefScale:.014,normalStrength:1,layers:[{source:{kind:'asset',id:'texture.clay-roof'},roughness:.82,metalness:0,heightStrength:1},
    {source:{kind:'solid',color:'#476c64'},opacity:.82,roughness:.8,metalness:0,heightStrength:0}]}},
} satisfies Record<string,SurfaceMaterialInput>;

