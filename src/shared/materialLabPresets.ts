import {materialGeneratorSchema,type ResolvedMaterialGenerator} from './materialGenerator.ts';
/** Fifty editable demonstrations; every surface is generated from parameters, not an imported image. */
export const MATERIAL_LAB_PRESETS:ReadonlyArray<{id:string;recipe:ResolvedMaterialGenerator}>=
[
  {
    "id": "desert-sandstone",
    "recipe": {
      "name": "Desert sandstone",
      "seed": 1322,
      "color": "#d4b780",
      "secondaryColor": "#74664e",
      "pattern": {
        "family": "masonry",
        "blockMeters": [
          0.5,
          0.25
        ],
        "chipping": 0.4
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "old-red-brick",
    "recipe": {
      "name": "Old red brick",
      "seed": 1635,
      "color": "#b66546",
      "secondaryColor": "#54453a",
      "pattern": {
        "family": "masonry",
        "blockMeters": [
          0.25,
          0.085
        ],
        "mortarMeters": 0.01
      },
      "roughness": 0.82,
      "weathering": 0.6
    }
  },
  {
    "id": "whitewashed-brick",
    "recipe": {
      "name": "Whitewashed brick",
      "seed": 1948,
      "color": "#e8dec6",
      "secondaryColor": "#9a9588",
      "pattern": {
        "family": "masonry",
        "blockMeters": [
          0.28,
          0.1
        ],
        "chipping": 0.1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "slate-courtyard",
    "recipe": {
      "name": "Slate courtyard",
      "seed": 2261,
      "color": "#67787c",
      "secondaryColor": "#353e42",
      "pattern": {
        "family": "masonry",
        "shape": "square",
        "blockMeters": [
          0.4,
          0.4
        ],
        "bond": "stack"
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "temple-limestone",
    "recipe": {
      "name": "Temple limestone",
      "seed": 2574,
      "color": "#cec6ab",
      "secondaryColor": "#837e67",
      "pattern": {
        "family": "masonry",
        "blockMeters": [
          0.7,
          0.4
        ],
        "chipping": 0.05
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "charcoal-blocks",
    "recipe": {
      "name": "Charcoal blocks",
      "seed": 2887,
      "color": "#525256",
      "secondaryColor": "#252629",
      "pattern": {
        "family": "masonry",
        "blockMeters": [
          0.4,
          0.2
        ]
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "terracotta-triangles",
    "recipe": {
      "name": "Terracotta triangles",
      "seed": 3200,
      "color": "#cc8158",
      "secondaryColor": "#6c4838",
      "pattern": {
        "family": "masonry",
        "shape": "triangle",
        "blockMeters": [
          0.35,
          0.35
        ],
        "bond": "stack"
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "moss-tinted-ruins",
    "recipe": {
      "name": "Moss-tinted ruins",
      "seed": 3513,
      "color": "#80916b",
      "secondaryColor": "#454c3b",
      "pattern": {
        "family": "masonry",
        "blockMeters": [
          0.5,
          0.3
        ],
        "chipping": 0.8,
        "irregularity": 0.8
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "rose-granite-tiles",
    "recipe": {
      "name": "Rose granite tiles",
      "seed": 3826,
      "color": "#bf9890",
      "secondaryColor": "#645452",
      "pattern": {
        "family": "masonry",
        "shape": "square",
        "blockMeters": [
          0.3,
          0.3
        ],
        "bond": "stack"
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "honey-stone-wall",
    "recipe": {
      "name": "Honey stone wall",
      "seed": 4139,
      "color": "#ca9d55",
      "secondaryColor": "#69583c",
      "pattern": {
        "family": "masonry",
        "blockMeters": [
          0.6,
          0.25
        ],
        "irregularity": 0.6
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "warm-oak",
    "recipe": {
      "name": "Warm oak",
      "seed": 4452,
      "color": "#c49157",
      "secondaryColor": "#674326",
      "pattern": {
        "family": "wood",
        "grain": 0.65,
        "knots": 0.3
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "walnut-boards",
    "recipe": {
      "name": "Walnut boards",
      "seed": 4765,
      "color": "#78503a",
      "secondaryColor": "#30221d",
      "pattern": {
        "family": "wood",
        "plankMeters": 0.26,
        "grain": 0.7
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "pale-birch",
    "recipe": {
      "name": "Pale birch",
      "seed": 5078,
      "color": "#dfc69a",
      "secondaryColor": "#9a7953",
      "pattern": {
        "family": "wood",
        "knots": 0.1,
        "grain": 0.35
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "weathered-dock",
    "recipe": {
      "name": "Weathered dock",
      "seed": 5391,
      "color": "#989586",
      "secondaryColor": "#55584d",
      "pattern": {
        "family": "wood",
        "plankMeters": 0.3,
        "grain": 0.9,
        "knots": 0.8
      },
      "roughness": 0.82,
      "weathering": 0.6
    }
  },
  {
    "id": "red-cedar",
    "recipe": {
      "name": "Red cedar",
      "seed": 5704,
      "color": "#bc7145",
      "secondaryColor": "#633b27",
      "pattern": {
        "family": "wood",
        "plankMeters": 0.18,
        "grain": 0.5
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "ebony-floor",
    "recipe": {
      "name": "Ebony floor",
      "seed": 6017,
      "color": "#49443e",
      "secondaryColor": "#171b1c",
      "pattern": {
        "family": "wood",
        "plankMeters": 0.22,
        "knots": 0.05
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "painted-teal-boards",
    "recipe": {
      "name": "Painted teal boards",
      "seed": 6330,
      "color": "#73968a",
      "secondaryColor": "#304e49",
      "pattern": {
        "family": "wood",
        "direction": "horizontal",
        "plankMeters": 0.17,
        "grain": 0.4
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "rustic-pine",
    "recipe": {
      "name": "Rustic pine",
      "seed": 6643,
      "color": "#d1a866",
      "secondaryColor": "#806039",
      "pattern": {
        "family": "wood",
        "plankMeters": 0.32,
        "knots": 1,
        "grain": 0.8
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "basalt",
    "recipe": {
      "name": "Basalt",
      "seed": 6956,
      "color": "#646971",
      "secondaryColor": "#262b31",
      "pattern": {
        "family": "rock",
        "grainMeters": 0.04,
        "fractures": 0.65
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "snow-granite",
    "recipe": {
      "name": "Snow granite",
      "seed": 7269,
      "color": "#e2e0d6",
      "secondaryColor": "#7e8585",
      "pattern": {
        "family": "rock",
        "grainMeters": 0.025,
        "fractures": 0.1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "canyon-strata",
    "recipe": {
      "name": "Canyon strata",
      "seed": 7582,
      "color": "#c58c65",
      "secondaryColor": "#714a37",
      "pattern": {
        "family": "rock",
        "layering": 0.95,
        "grainMeters": 0.12
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "emerald-mineral",
    "recipe": {
      "name": "Emerald mineral",
      "seed": 7895,
      "color": "#78947a",
      "secondaryColor": "#253e37",
      "pattern": {
        "family": "rock",
        "fractures": 0.85,
        "grainMeters": 0.1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "moon-rock",
    "recipe": {
      "name": "Moon rock",
      "seed": 8208,
      "color": "#a9aaae",
      "secondaryColor": "#626570",
      "pattern": {
        "family": "rock",
        "grainMeters": 0.06
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "volcanic-red",
    "recipe": {
      "name": "Volcanic red",
      "seed": 8521,
      "color": "#9e5647",
      "secondaryColor": "#3c2927",
      "pattern": {
        "family": "rock",
        "fractures": 0.95,
        "grainMeters": 0.14
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "blue-shale",
    "recipe": {
      "name": "Blue shale",
      "seed": 8834,
      "color": "#7b909f",
      "secondaryColor": "#384552",
      "pattern": {
        "family": "rock",
        "layering": 0.8,
        "grainMeters": 0.055
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "forest-loam",
    "recipe": {
      "name": "Forest loam",
      "seed": 9147,
      "color": "#887052",
      "secondaryColor": "#342c20",
      "pattern": {
        "family": "dirt",
        "moisture": 0.35,
        "clumping": 0.8
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "dry-desert-soil",
    "recipe": {
      "name": "Dry desert soil",
      "seed": 9460,
      "color": "#c9a875",
      "secondaryColor": "#776144",
      "pattern": {
        "family": "dirt",
        "moisture": 0,
        "stones": 0.1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "wet-garden-earth",
    "recipe": {
      "name": "Wet garden earth",
      "seed": 9773,
      "color": "#6c4d37",
      "secondaryColor": "#201b15",
      "pattern": {
        "family": "dirt",
        "moisture": 0.9,
        "clumping": 0.9
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "red-clay",
    "recipe": {
      "name": "Red clay",
      "seed": 10086,
      "color": "#b77151",
      "secondaryColor": "#633b2d",
      "pattern": {
        "family": "dirt",
        "grainMeters": 0.025,
        "stones": 0
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "pebbled-trail",
    "recipe": {
      "name": "Pebbled trail",
      "seed": 10399,
      "color": "#ab9470",
      "secondaryColor": "#605341",
      "pattern": {
        "family": "dirt",
        "stones": 0.95,
        "grainMeters": 0.12
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "river-pebbles",
    "recipe": {
      "name": "River pebbles",
      "seed": 10712,
      "color": "#aca798",
      "secondaryColor": "#4b5553",
      "pattern": {
        "family": "gravel",
        "roundness": 1,
        "stoneMeters": 0.1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "crushed-granite",
    "recipe": {
      "name": "Crushed granite",
      "seed": 11025,
      "color": "#a0a6af",
      "secondaryColor": "#414750",
      "pattern": {
        "family": "gravel",
        "roundness": 0,
        "stoneMeters": 0.045
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "golden-gravel",
    "recipe": {
      "name": "Golden gravel",
      "seed": 11338,
      "color": "#d4b676",
      "secondaryColor": "#776140",
      "pattern": {
        "family": "gravel",
        "roundness": 0.5,
        "stoneMeters": 0.06
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "coarse-ballast",
    "recipe": {
      "name": "Coarse ballast",
      "seed": 11651,
      "color": "#7e858b",
      "secondaryColor": "#303b41",
      "pattern": {
        "family": "gravel",
        "roundness": 0.2,
        "stoneMeters": 0.15
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "rose-quartz-chips",
    "recipe": {
      "name": "Rose quartz chips",
      "seed": 11964,
      "color": "#d3b2ae",
      "secondaryColor": "#7f656e",
      "pattern": {
        "family": "gravel",
        "roundness": 0.7,
        "stoneMeters": 0.05
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "meadow-grass",
    "recipe": {
      "name": "Meadow grass",
      "seed": 12277,
      "color": "#7f9f47",
      "secondaryColor": "#344727",
      "pattern": {
        "family": "grass",
        "density": 0.95,
        "dryness": 0.1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "parched-savanna",
    "recipe": {
      "name": "Parched savanna",
      "seed": 12590,
      "color": "#c3b373",
      "secondaryColor": "#6c6940",
      "pattern": {
        "family": "grass",
        "dryness": 0.95,
        "barePatches": 0.3
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "dark-forest-moss",
    "recipe": {
      "name": "Dark forest moss",
      "seed": 12903,
      "color": "#66835b",
      "secondaryColor": "#253c2b",
      "pattern": {
        "family": "grass",
        "bladeMeters": 0.015,
        "density": 1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "short-turf",
    "recipe": {
      "name": "Short turf",
      "seed": 13216,
      "color": "#6e9e55",
      "secondaryColor": "#2b4f31",
      "pattern": {
        "family": "grass",
        "bladeMeters": 0.02,
        "barePatches": 0,
        "density": 1
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "wild-marsh",
    "recipe": {
      "name": "Wild marsh",
      "seed": 13529,
      "color": "#96a66a",
      "secondaryColor": "#3d5140",
      "pattern": {
        "family": "grass",
        "bladeMeters": 0.06,
        "density": 0.8
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "brushed-steel",
    "recipe": {
      "name": "Brushed steel",
      "seed": 13842,
      "color": "#c7d0d9",
      "secondaryColor": "#65717d",
      "pattern": {
        "family": "metal",
        "brushing": 0.95,
        "oxidation": 0
      },
      "roughness": 0.38,
      "weathering": 0.15
    }
  },
  {
    "id": "aged-copper",
    "recipe": {
      "name": "Aged copper",
      "seed": 14155,
      "color": "#b69865",
      "secondaryColor": "#4b6b5e",
      "pattern": {
        "family": "metal",
        "oxidation": 0.8,
        "brushing": 0.1
      },
      "roughness": 0.38,
      "weathering": 0.15
    }
  },
  {
    "id": "dark-iron",
    "recipe": {
      "name": "Dark iron",
      "seed": 14468,
      "color": "#73767a",
      "secondaryColor": "#272d34",
      "pattern": {
        "family": "metal",
        "oxidation": 0.35
      },
      "roughness": 0.38,
      "weathering": 0.15
    }
  },
  {
    "id": "satin-brass",
    "recipe": {
      "name": "Satin brass",
      "seed": 14781,
      "color": "#d7b875",
      "secondaryColor": "#77643c",
      "pattern": {
        "family": "metal",
        "metalness": 1,
        "brushing": 0.7
      },
      "roughness": 0.38,
      "weathering": 0.15
    }
  },
  {
    "id": "oxidized-plate",
    "recipe": {
      "name": "Oxidized plate",
      "seed": 15094,
      "color": "#b17c52",
      "secondaryColor": "#45463b",
      "pattern": {
        "family": "metal",
        "oxidation": 1,
        "brushing": 0
      },
      "roughness": 0.38,
      "weathering": 0.15
    }
  },
  {
    "id": "polished-aluminium",
    "recipe": {
      "name": "Polished aluminium",
      "seed": 15407,
      "color": "#e6edf4",
      "secondaryColor": "#a2afbb",
      "pattern": {
        "family": "metal",
        "metalness": 1,
        "oxidation": 0,
        "brushing": 0.2
      },
      "roughness": 0.16,
      "weathering": 0.15
    }
  },
  {
    "id": "ivory-plaster",
    "recipe": {
      "name": "Ivory plaster",
      "seed": 15720,
      "color": "#eee3ca",
      "secondaryColor": "#b8aa91",
      "pattern": {
        "family": "plaster",
        "cracks": 0.05
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "faded-terracotta",
    "recipe": {
      "name": "Faded terracotta",
      "seed": 16033,
      "color": "#c6987d",
      "secondaryColor": "#8a6356",
      "pattern": {
        "family": "plaster",
        "cracks": 0.35
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "cool-concrete",
    "recipe": {
      "name": "Cool concrete",
      "seed": 16346,
      "color": "#b1b5b3",
      "secondaryColor": "#747e7d",
      "pattern": {
        "family": "plaster",
        "grainMeters": 0.04,
        "cracks": 0.4
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  },
  {
    "id": "cracked-chalk-wall",
    "recipe": {
      "name": "Cracked chalk wall",
      "seed": 16659,
      "color": "#e3dfcf",
      "secondaryColor": "#8c9287",
      "pattern": {
        "family": "plaster",
        "cracks": 0.95,
        "grainMeters": 0.03
      },
      "roughness": 0.82,
      "weathering": 0.15
    }
  }
].map(entry=>({id:entry.id,recipe:materialGeneratorSchema.parse(entry.recipe)}));
