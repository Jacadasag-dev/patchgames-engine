import type {ResolvedMaterialGenerator} from './materialGenerator.ts';
/** Named procedural recipes; no stored texture pixels or imported image metadata. */
export const MATERIAL_RECIPE_LIBRARY:Record<string,ResolvedMaterialGenerator>={
  "texture.wood-floor": {
    "version": 1,
    "seed": 4452,
    "name": "Wood planks",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c49157",
    "secondaryColor": "#674326",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "wood",
      "plankMeters": 0.2,
      "grain": 0.65,
      "knots": 0.3,
      "gapMeters": 0.004,
      "direction": "vertical"
    }
  },
  "texture.forest-ground": {
    "version": 1,
    "seed": 12903,
    "name": "Mossy forest ground",
    "tileMeters": [
      2,
      2
    ],
    "color": "#66835b",
    "secondaryColor": "#253c2b",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "grass",
      "bladeMeters": 0.015,
      "density": 1,
      "dryness": 0.2,
      "barePatches": 0.15
    }
  },
  "texture.stone": {
    "version": 1,
    "seed": 6956,
    "name": "Rough grey stone",
    "tileMeters": [
      2,
      2
    ],
    "color": "#646971",
    "secondaryColor": "#262b31",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.04,
      "fractures": 0.65,
      "layering": 0.2
    }
  },
  "texture.metal": {
    "version": 1,
    "seed": 13842,
    "name": "Smooth grey metal",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c7d0d9",
    "secondaryColor": "#65717d",
    "variation": 0.3,
    "roughness": 0.38,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "metal",
      "brushing": 0.95,
      "oxidation": 0,
      "metalness": 0.95
    }
  },
  "texture.light-wood": {
    "version": 1,
    "seed": 5078,
    "name": "Light knotty wood",
    "tileMeters": [
      2,
      2
    ],
    "color": "#dfc69a",
    "secondaryColor": "#9a7953",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "wood",
      "plankMeters": 0.2,
      "grain": 0.35,
      "knots": 0.1,
      "gapMeters": 0.004,
      "direction": "vertical"
    }
  },
  "texture.dark-wood": {
    "version": 1,
    "seed": 4765,
    "name": "Dark smooth wood",
    "tileMeters": [
      2,
      2
    ],
    "color": "#78503a",
    "secondaryColor": "#30221d",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "wood",
      "plankMeters": 0.26,
      "grain": 0.7,
      "knots": 0.3,
      "gapMeters": 0.004,
      "direction": "vertical"
    }
  },
  "texture.fir-bark": {
    "version": 1,
    "seed": 6643,
    "name": "Fir tree bark",
    "tileMeters": [
      2,
      2
    ],
    "color": "#d1a866",
    "secondaryColor": "#806039",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "wood",
      "plankMeters": 0.32,
      "grain": 0.8,
      "knots": 1,
      "gapMeters": 0.004,
      "direction": "vertical"
    }
  },
  "texture.oak-bark": {
    "version": 1,
    "seed": 5391,
    "name": "Oak tree bark",
    "tileMeters": [
      2,
      2
    ],
    "color": "#989586",
    "secondaryColor": "#55584d",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.6,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "wood",
      "plankMeters": 0.3,
      "grain": 0.9,
      "knots": 0.8,
      "gapMeters": 0.004,
      "direction": "vertical"
    }
  },
  "texture.dense-grass": {
    "version": 1,
    "seed": 12277,
    "name": "Dense green grass",
    "tileMeters": [
      2,
      2
    ],
    "color": "#7f9f47",
    "secondaryColor": "#344727",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "grass",
      "bladeMeters": 0.03,
      "density": 0.95,
      "dryness": 0.1,
      "barePatches": 0.15
    }
  },
  "texture.short-grass": {
    "version": 1,
    "seed": 13216,
    "name": "Short lawn grass",
    "tileMeters": [
      2,
      2
    ],
    "color": "#6e9e55",
    "secondaryColor": "#2b4f31",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "grass",
      "bladeMeters": 0.02,
      "density": 1,
      "dryness": 0.2,
      "barePatches": 0
    }
  },
  "texture.muddy-earth": {
    "version": 1,
    "seed": 9773,
    "name": "Muddy riverbed earth",
    "tileMeters": [
      2,
      2
    ],
    "color": "#6c4d37",
    "secondaryColor": "#201b15",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "dirt",
      "grainMeters": 0.05,
      "clumping": 0.9,
      "moisture": 0.9,
      "stones": 0.2
    }
  },
  "texture.dry-earth": {
    "version": 1,
    "seed": 9460,
    "name": "Dry earth and pebbles",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c9a875",
    "secondaryColor": "#776144",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "dirt",
      "grainMeters": 0.05,
      "clumping": 0.6,
      "moisture": 0,
      "stones": 0.1
    }
  },
  "texture.river-gravel": {
    "version": 1,
    "seed": 10712,
    "name": "River gravel",
    "tileMeters": [
      2,
      2
    ],
    "color": "#aca798",
    "secondaryColor": "#4b5553",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "gravel",
      "stoneMeters": 0.1,
      "roundness": 1,
      "sizeVariation": 0.4
    }
  },
  "texture.rubble": {
    "version": 1,
    "seed": 11651,
    "name": "Construction rubble",
    "tileMeters": [
      2,
      2
    ],
    "color": "#7e858b",
    "secondaryColor": "#303b41",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "gravel",
      "stoneMeters": 0.15,
      "roundness": 0.2,
      "sizeVariation": 0.4
    }
  },
  "texture.beach-sand": {
    "version": 1,
    "seed": 9460,
    "name": "Beach sand",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c9a875",
    "secondaryColor": "#776144",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "dirt",
      "grainMeters": 0.05,
      "clumping": 0.6,
      "moisture": 0,
      "stones": 0.1
    }
  },
  "texture.dune-sand": {
    "version": 1,
    "seed": 11338,
    "name": "Windblown dune sand",
    "tileMeters": [
      2,
      2
    ],
    "color": "#d4b676",
    "secondaryColor": "#776140",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "gravel",
      "stoneMeters": 0.06,
      "roundness": 0.5,
      "sizeVariation": 0.4
    }
  },
  "texture.fresh-snow": {
    "version": 1,
    "seed": 15720,
    "name": "Smooth fresh snow",
    "tileMeters": [
      2,
      2
    ],
    "color": "#eee3ca",
    "secondaryColor": "#b8aa91",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "plaster",
      "grainMeters": 0.02,
      "cracks": 0.05
    }
  },
  "texture.melting-snow": {
    "version": 1,
    "seed": 7269,
    "name": "Melting snow and grass",
    "tileMeters": [
      2,
      2
    ],
    "color": "#e2e0d6",
    "secondaryColor": "#7e8585",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.025,
      "fractures": 0.1,
      "layering": 0.2
    }
  },
  "texture.mossy-rock": {
    "version": 1,
    "seed": 7895,
    "name": "Mossy rough rock",
    "tileMeters": [
      2,
      2
    ],
    "color": "#78947a",
    "secondaryColor": "#253e37",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.1,
      "fractures": 0.85,
      "layering": 0.2
    }
  },
  "texture.layered-cliff": {
    "version": 1,
    "seed": 7582,
    "name": "Layered weathered cliff",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c58c65",
    "secondaryColor": "#714a37",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.12,
      "fractures": 0.3,
      "layering": 0.95
    }
  },
  "texture.red-brick": {
    "version": 1,
    "seed": 1635,
    "name": "Clean red brick wall",
    "tileMeters": [
      2,
      2
    ],
    "color": "#b66546",
    "secondaryColor": "#54453a",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.6,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "masonry",
      "shape": "rectangle",
      "blockMeters": [
        0.25,
        0.085
      ],
      "bond": "staggered",
      "mortarMeters": 0.01,
      "irregularity": 0.2,
      "chipping": 0.15
    }
  },
  "texture.aged-brick": {
    "version": 1,
    "seed": 3513,
    "name": "Aged damaged brick",
    "tileMeters": [
      2,
      2
    ],
    "color": "#80916b",
    "secondaryColor": "#454c3b",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "masonry",
      "shape": "rectangle",
      "blockMeters": [
        0.5,
        0.3
      ],
      "bond": "staggered",
      "mortarMeters": 0.012,
      "irregularity": 0.8,
      "chipping": 0.8
    }
  },
  "texture.beige-brick": {
    "version": 1,
    "seed": 1948,
    "name": "Beige brick wall",
    "tileMeters": [
      2,
      2
    ],
    "color": "#e8dec6",
    "secondaryColor": "#9a9588",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "masonry",
      "shape": "rectangle",
      "blockMeters": [
        0.28,
        0.1
      ],
      "bond": "staggered",
      "mortarMeters": 0.012,
      "irregularity": 0.2,
      "chipping": 0.1
    }
  },
  "texture.mossy-paving": {
    "version": 1,
    "seed": 2261,
    "name": "Mossy paving stones",
    "tileMeters": [
      2,
      2
    ],
    "color": "#67787c",
    "secondaryColor": "#353e42",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "masonry",
      "shape": "square",
      "blockMeters": [
        0.4,
        0.4
      ],
      "bond": "stack",
      "mortarMeters": 0.012,
      "irregularity": 0.2,
      "chipping": 0.15
    }
  },
  "texture.limestone-floor": {
    "version": 1,
    "seed": 2574,
    "name": "Cream limestone floor tiles",
    "tileMeters": [
      2,
      2
    ],
    "color": "#cec6ab",
    "secondaryColor": "#837e67",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "masonry",
      "shape": "rectangle",
      "blockMeters": [
        0.7,
        0.4
      ],
      "bond": "staggered",
      "mortarMeters": 0.012,
      "irregularity": 0.2,
      "chipping": 0.05
    }
  },
  "texture.worn-tiles": {
    "version": 1,
    "seed": 3826,
    "name": "Worn pale stone tiles",
    "tileMeters": [
      2,
      2
    ],
    "color": "#bf9890",
    "secondaryColor": "#645452",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "masonry",
      "shape": "square",
      "blockMeters": [
        0.3,
        0.3
      ],
      "bond": "stack",
      "mortarMeters": 0.012,
      "irregularity": 0.2,
      "chipping": 0.15
    }
  },
  "texture.clay-roof": {
    "version": 1,
    "seed": 3200,
    "name": "Clay roof tiles",
    "tileMeters": [
      2,
      2
    ],
    "color": "#cc8158",
    "secondaryColor": "#6c4838",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "masonry",
      "shape": "triangle",
      "blockMeters": [
        0.35,
        0.35
      ],
      "bond": "stack",
      "mortarMeters": 0.012,
      "irregularity": 0.2,
      "chipping": 0.15
    }
  },
  "texture.smooth-concrete": {
    "version": 1,
    "seed": 16346,
    "name": "Smooth light concrete",
    "tileMeters": [
      2,
      2
    ],
    "color": "#b1b5b3",
    "secondaryColor": "#747e7d",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "plaster",
      "grainMeters": 0.04,
      "cracks": 0.4
    }
  },
  "texture.rough-concrete": {
    "version": 1,
    "seed": 16659,
    "name": "Rough concrete pavement",
    "tileMeters": [
      2,
      2
    ],
    "color": "#e3dfcf",
    "secondaryColor": "#8c9287",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "plaster",
      "grainMeters": 0.03,
      "cracks": 0.95
    }
  },
  "texture.asphalt": {
    "version": 1,
    "seed": 14468,
    "name": "Dark asphalt",
    "tileMeters": [
      2,
      2
    ],
    "color": "#73767a",
    "secondaryColor": "#272d34",
    "variation": 0.3,
    "roughness": 0.38,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "metal",
      "brushing": 0.4,
      "oxidation": 0.35,
      "metalness": 0.95
    }
  },
  "texture.white-plaster": {
    "version": 1,
    "seed": 15720,
    "name": "White stucco plaster",
    "tileMeters": [
      2,
      2
    ],
    "color": "#eee3ca",
    "secondaryColor": "#b8aa91",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "plaster",
      "grainMeters": 0.02,
      "cracks": 0.05
    }
  },
  "texture.damaged-plaster": {
    "version": 1,
    "seed": 16659,
    "name": "Damaged old plaster",
    "tileMeters": [
      2,
      2
    ],
    "color": "#e3dfcf",
    "secondaryColor": "#8c9287",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "plaster",
      "grainMeters": 0.03,
      "cracks": 0.95
    }
  },
  "texture.red-wool": {
    "version": 1,
    "seed": 16033,
    "name": "Red-orange wool fabric",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c6987d",
    "secondaryColor": "#8a6356",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "plaster",
      "grainMeters": 0.02,
      "cracks": 0.35
    }
  },
  "texture.blue-microfiber": {
    "version": 1,
    "seed": 8834,
    "name": "Soft blue microfiber",
    "tileMeters": [
      2,
      2
    ],
    "color": "#7b909f",
    "secondaryColor": "#384552",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.055,
      "fractures": 0.3,
      "layering": 0.8
    }
  },
  "texture.dark-leather": {
    "version": 1,
    "seed": 4765,
    "name": "Dark brown leather",
    "tileMeters": [
      2,
      2
    ],
    "color": "#78503a",
    "secondaryColor": "#30221d",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "wood",
      "plankMeters": 0.26,
      "grain": 0.7,
      "knots": 0.3,
      "gapMeters": 0.004,
      "direction": "vertical"
    }
  },
  "texture.tan-leather": {
    "version": 1,
    "seed": 4452,
    "name": "Smooth tan leather",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c49157",
    "secondaryColor": "#674326",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "wood",
      "plankMeters": 0.2,
      "grain": 0.65,
      "knots": 0.3,
      "gapMeters": 0.004,
      "direction": "vertical"
    }
  },
  "texture.cream-carpet": {
    "version": 1,
    "seed": 15720,
    "name": "Cream wool carpet",
    "tileMeters": [
      2,
      2
    ],
    "color": "#eee3ca",
    "secondaryColor": "#b8aa91",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "plaster",
      "grainMeters": 0.02,
      "cracks": 0.05
    }
  },
  "texture.blue-carpet": {
    "version": 1,
    "seed": 8834,
    "name": "Dark blue carpet",
    "tileMeters": [
      2,
      2
    ],
    "color": "#7b909f",
    "secondaryColor": "#384552",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.055,
      "fractures": 0.3,
      "layering": 0.8
    }
  },
  "texture.oxidized-metal": {
    "version": 1,
    "seed": 15094,
    "name": "Dark oxidized metal",
    "tileMeters": [
      2,
      2
    ],
    "color": "#b17c52",
    "secondaryColor": "#45463b",
    "variation": 0.3,
    "roughness": 0.38,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "metal",
      "brushing": 0,
      "oxidation": 1,
      "metalness": 0.95
    }
  },
  "texture.silver-metal": {
    "version": 1,
    "seed": 15407,
    "name": "Clean silver metal",
    "tileMeters": [
      2,
      2
    ],
    "color": "#e6edf4",
    "secondaryColor": "#a2afbb",
    "variation": 0.3,
    "roughness": 0.16,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "metal",
      "brushing": 0.2,
      "oxidation": 0,
      "metalness": 1
    }
  },
  "texture.blue-corrugated-steel": {
    "version": 1,
    "seed": 13842,
    "name": "Blue corrugated steel",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c7d0d9",
    "secondaryColor": "#65717d",
    "variation": 0.3,
    "roughness": 0.38,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "metal",
      "brushing": 0.95,
      "oxidation": 0,
      "metalness": 0.95
    }
  },
  "texture.rusted-walkway": {
    "version": 1,
    "seed": 15094,
    "name": "Rusted metal walkway",
    "tileMeters": [
      2,
      2
    ],
    "color": "#b17c52",
    "secondaryColor": "#45463b",
    "variation": 0.3,
    "roughness": 0.38,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "metal",
      "brushing": 0,
      "oxidation": 1,
      "metalness": 0.95
    }
  },
  "texture.chainmail": {
    "version": 1,
    "seed": 13842,
    "name": "Metal chainmail",
    "tileMeters": [
      2,
      2
    ],
    "color": "#c7d0d9",
    "secondaryColor": "#65717d",
    "variation": 0.3,
    "roughness": 0.38,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "metal",
      "brushing": 0.95,
      "oxidation": 0,
      "metalness": 0.95
    }
  },
  "texture.white-marble": {
    "version": 1,
    "seed": 7269,
    "name": "White veined marble",
    "tileMeters": [
      2,
      2
    ],
    "color": "#e2e0d6",
    "secondaryColor": "#7e8585",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.025,
      "fractures": 0.1,
      "layering": 0.2
    }
  },
  "texture.granite": {
    "version": 1,
    "seed": 7269,
    "name": "Granite countertop stone",
    "tileMeters": [
      2,
      2
    ],
    "color": "#e2e0d6",
    "secondaryColor": "#7e8585",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "rock",
      "grainMeters": 0.025,
      "fractures": 0.1,
      "layering": 0.2
    }
  },
  "texture.terrazzo": {
    "version": 1,
    "seed": 11964,
    "name": "Colorful white terrazzo",
    "tileMeters": [
      2,
      2
    ],
    "color": "#d3b2ae",
    "secondaryColor": "#7f656e",
    "variation": 0.3,
    "roughness": 0.82,
    "weathering": 0.15,
    "reliefMeters": 0.008,
    "output": {
      "resolution": 128,
      "style": "realistic",
      "paletteSteps": 8
    },
    "pattern": {
      "family": "gravel",
      "stoneMeters": 0.05,
      "roundness": 0.7,
      "sizeVariation": 0.4
    }
  }
};
