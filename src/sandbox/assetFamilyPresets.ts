/** Editable starter families. Applications can combine these with any original
 * defineAssetFamily generator; the catalog is deliberately open, not an enum. */
import { createAssetCatalog, defineAssetFamily, type AssetFamily, type AssetGeometry, type AssetPart,
  type AssetNumberParameter, type AssetChoiceParameter, type AssetSurface } from './assetFamilies.ts';

const number = (min: number, max: number, step: number, value: number): AssetNumberParameter => ({ kind: 'number', min, max, step, default: value });
const choice = (...values: string[]): AssetChoiceParameter => ({ kind: 'choice', values: values.map(value => ({ value })) });
const material = choice('oak', 'walnut', 'painted', 'metal');
const colors: Record<string, string> = { oak: '#ac8051', walnut: '#624331', painted: '#789aab', metal: '#697780' };
const palette = (name: string) => ({ main: colors[name] ?? colors.oak, dark: '#343d43', light: '#ddd3bd', fabric: '#7b8e99', green: '#527c4a' });
type Parts = AssetPart[];
function piece(parts: Parts, id: string, size: [number, number, number], at: [number, number, number], color: string,
  shape: AssetPart['shape'] = 'box', collision = true, yaw = 0): void {
  parts.push({ id, shape, position: { x: at[0], y: at[1], z: at[2] }, size: { x: size[0], y: size[1], z: size[2] }, color, collision, yaw });
}
function legs(parts: Parts, width: number, depth: number, height: number, color: string, thickness = .075): void {
  for (const x of [-1, 1]) for (const z of [-1, 1])
    piece(parts, `leg-${x < 0 ? 'l' : 'r'}${z < 0 ? 'n' : 's'}`, [thickness, height, thickness], [x * (width / 2 - thickness), height / 2, z * (depth / 2 - thickness)], color);
}
const dimensions = (w: number, d: number, h: number) => ({
  width: number(Math.max(.4, w - .4), w + .6, .1, w), depth: number(Math.max(.3, d - .2), d + .4, .1, d),
  height: number(Math.max(.4, h - .2), h + .4, .05, h), material,
});

/** Table sockets are chair centres on the floor. Chair forward is +Z; socket yaw
 * points toward the table. Round diameter is min(width,depth); inspect size for
 * its final footprint. Oval uses independent X/Z diameters. */
function table(): AssetFamily {
  return defineAssetFamily({ id: 'table', version: '1', parameters: {
    width: number(.8, 2.8, .1, 1.4), depth: number(.6, 2.8, .1, .8), height: number(.6, 1.1, .05, .75),
    shape: choice('rectangle', 'round', 'oval'), base: choice('four-leg', 'pedestal', 'trestle'), material,
  }, generate(p) {
    const parts: Parts = [], c = palette(p.material), diameter = Math.min(p.width, p.depth);
    const w = p.shape === 'round' ? diameter : p.width, d = p.shape === 'round' ? diameter : p.depth, h = p.height, top = .08;
    piece(parts, 'top', [w, top, d], [0, h - top / 2, 0], c.main, p.shape === 'rectangle' ? 'box' : 'cylinder');
    if (p.base === 'four-leg') legs(parts, w * .85, d * .85, h - top, c.dark);
    else if (p.base === 'pedestal') {
      piece(parts, 'foot', [w * .55, .06, d * .55], [0, .03, 0], c.dark, 'cylinder');
      piece(parts, 'post', [.14, h - top - .06, .14], [0, (h - top + .06) / 2, 0], c.dark, 'cylinder');
    } else {
      for (const side of [-1, 1]) {
        piece(parts, `trestle-${side}`, [.1, h - top, d * .65], [side * w * .31, (h - top) / 2, 0], c.dark);
        piece(parts, `foot-${side}`, [.24, .06, d * .8], [side * w * .31, .03, 0], c.dark);
      }
      piece(parts, 'brace', [w * .64, .1, .1], [0, h * .33, 0], c.dark);
    }
    return { parts, surfaces: [{ id: 'top', partId: 'top', tags: ['tabletop', 'display'], position: { x: 0, y: h, z: 0 },
      width: p.shape === 'rectangle' ? w - .02 : w * .7, depth: p.shape === 'rectangle' ? d - .02 : d * .7 }], sockets: [
      { id: 'north', tags: ['seat'], position: { x: 0, y: 0, z: -d / 2 - .34 }, yaw: 0 },
      { id: 'south', tags: ['seat'], position: { x: 0, y: 0, z: d / 2 + .34 }, yaw: Math.PI },
      { id: 'west', tags: ['seat'], position: { x: -w / 2 - .34, y: 0, z: 0 }, yaw: Math.PI / 2 },
      { id: 'east', tags: ['seat'], position: { x: w / 2 + .34, y: 0, z: 0 }, yaw: -Math.PI / 2 },
      { id: 'surface', tags: ['decoration', 'surface'], position: { x: 0, y: h, z: 0 }, yaw: 0 },
    ] };
  } });
}

function furniture(id: string, w: number, d: number, h: number, build: (parts: Parts, w: number, d: number, h: number, c: ReturnType<typeof palette>) => void,
  supports?: (w: number, d: number, h: number) => AssetSurface[]): AssetFamily {
  return defineAssetFamily({ id, version: '1', parameters: dimensions(w, d, h), generate(p) {
    const parts: Parts = []; build(parts, p.width, p.depth, p.height, palette(p.material)); return { parts,
      ...(supports ? { surfaces: supports(p.width, p.depth, p.height) } : {}) };
  } });
}
function bed(): AssetFamily {
  return defineAssetFamily({ id: 'bed', version: '1', parameters: { ...dimensions(1.6, 2.1, 1),
    pillows: { kind: 'choice', values: [{ value: 'built-in' }, { value: 'none' }], default: 'built-in' } }, generate(p) {
    const parts: Parts = [], w = p.width, d = p.depth, h = p.height, c = palette(p.material);
    piece(parts, 'frame', [w, h * .28, d], [0, h * .14, 0], c.dark);
    piece(parts, 'mattress', [w * .95, h * .22, d * .93], [0, h * .39, 0], c.light);
    piece(parts, 'headboard', [w, h, .08], [0, h / 2, -d / 2 + .04], c.main);
    if (p.pillows === 'built-in') piece(parts, 'pillow', [w * .7, h * .1, d * .17], [0, h * .55, -d * .31], '#eeeadb', 'box', false);
    return { parts, surfaces: [{ id: 'mattress', partId: 'mattress', tags: ['mattress', 'bedding'], position: { x: 0, y: h * .5, z: 0 }, width: w * .95 - .02, depth: d * .93 - .02 }] };
  } });
}
function shelf(): AssetFamily {
  return defineAssetFamily({ id: 'shelf', version: '1', parameters: { ...dimensions(1.2, .5, 1.8),
    contents: { kind: 'choice', values: [{ value: 'built-in' }, { value: 'none' }], default: 'built-in' } }, generate(p) {
    const parts: Parts = [], w = p.width, d = p.depth, h = p.height, c = palette(p.material);
    for (const side of [-1, 1]) piece(parts, `side-${side}`, [.06, h, d], [side * (w / 2 - .03), h / 2, 0], c.main);
    piece(parts, 'back', [w, h, .04], [0, h / 2, -d / 2 + .02], c.dark);
    for (let i = 0; i < 4; i++) piece(parts, `shelf-${i}`, [w, .06, d], [0, .03 + i * (h - .06) / 3, 0], c.main);
    if (p.contents === 'built-in') for (let i = 0; i < 5; i++) piece(parts, `book-${i}`, [w * .1, h * .15, d * .65], [(i - 2) * w * .15, h * .55, 0], i % 2 ? '#b76a4d' : '#598689', 'box', false);
    return { parts, surfaces: Array.from({ length: 4 }, (_, i) => ({ id: `shelf-${i}`, partId: `shelf-${i}`, tags: ['shelf', 'display'],
      position: { x: 0, y: .06 + i * (h - .06) / 3, z: .02 }, width: w - .14, depth: d - .06,
      ...(i < 3 ? { clearHeight: (h - .06) / 3 - .06 } : {}) })) };
  } });
}
function starters(): AssetFamily[] {
  return [table(),
    furniture('chair', .5, .5, .9, (parts, w, d, h, c) => {
      const seat = Math.min(.46, h * .52);
      legs(parts, w, d, seat - .06, c.dark, .05);
      piece(parts, 'seat', [w, .06, d], [0, seat - .03, 0], c.main);
      piece(parts, 'back', [w, h - seat, .06], [0, seat + (h - seat) / 2, -d / 2 + .03], c.main);
    }),
    shelf(),
    furniture('desk', 1.4, .7, .75, (parts, w, d, h, c) => {
      piece(parts, 'top', [w, .07, d], [0, h - .035, 0], c.main);
      piece(parts, 'cabinet', [w * .3, h - .07, d * .9], [-w * .33, (h - .07) / 2, 0], c.dark);
      for (const z of [-1, 1]) piece(parts, `leg-${z}`, [.07, h - .07, .07], [w * .43, (h - .07) / 2, z * (d / 2 - .07)], c.dark);
      for (let i = 1; i <= 3; i++) piece(parts, `drawer-${i}`, [w * .22, .025, .025], [-w * .33, h * i / 4, d * .45 + .0125], c.light, 'box', false);
    }),
    furniture('counter', 1.6, .7, 1, (parts, w, d, h, c) => {
      piece(parts, 'cabinet', [w * .96, h - .08, d * .94], [0, (h - .08) / 2, 0], c.main);
      piece(parts, 'top', [w, .08, d], [0, h - .04, 0], c.light);
      piece(parts, 'toe', [w * .88, .08, d * .8], [0, .04, 0], c.dark);
    }, (w, d, h) => [{ id: 'top', partId: 'top', tags: ['countertop', 'display'], position: { x: 0, y: h, z: 0 }, width: w - .02, depth: d - .02 }]),
    furniture('locker', .6, .5, 1.8, (parts, w, d, h, c) => {
      piece(parts, 'body', [w, h, d], [0, h / 2, 0], c.main);
      piece(parts, 'door', [w * .88, h * .92, .02], [0, h / 2, d / 2 - .01], c.dark, 'box', false);
      for (let i = 0; i < 3; i++) piece(parts, `vent-${i}`, [w * .5, .025, .015], [0, h * .8 + i * .05, d / 2 - .0075], c.light, 'box', false);
    }),
    furniture('appliance', .7, .7, 1.6, (parts, w, d, h, c) => {
      piece(parts, 'body', [w, h, d], [0, h / 2, 0], c.light);
      piece(parts, 'panel', [w * .85, h * .42, .02], [0, h * .69, d / 2 - .01], c.dark, 'box', false);
      piece(parts, 'handle', [.04, h * .2, .025], [w * .3, h * .7, d / 2 - .0125], c.main, 'box', false);
    }),
    bed(),
    furniture('sofa', 2, .9, .9, (parts, w, d, h, c) => {
      piece(parts, 'base', [w, h * .35, d], [0, h * .175, 0], c.dark);
      piece(parts, 'back', [w, h * .65, d * .18], [0, h * .675, -d * .41], c.fabric);
      for (const side of [-1, 1]) piece(parts, `arm-${side}`, [w * .1, h * .7, d], [side * w * .45, h * .35, 0], c.main);
      piece(parts, 'cushion', [w * .8, h * .18, d * .8], [0, h * .44, d * .08], c.fabric);
    }),
    furniture('bench', 1.8, .6, .9, (parts, w, d, h, c) => {
      legs(parts, w * .9, d * .9, h * .48, c.dark);
      piece(parts, 'seat', [w, .08, d], [0, h * .48 + .04, 0], c.main);
      piece(parts, 'back', [w, h * .38, .08], [0, h * .81, -d / 2 + .04], c.main);
    }),
    furniture('planter', .7, .7, .9, (parts, w, d, h, c) => {
      piece(parts, 'pot', [w * .7, h * .5, d * .7], [0, h * .25, 0], c.main, 'cylinder');
      piece(parts, 'leaves', [w, h * .5, d], [0, h * .75, 0], c.green, 'cylinder', false);
    }),
  ];
}
function outdoors(): AssetFamily[] {
  return [
    defineAssetFamily({ id: 'tree', version: '1', parameters: {
      width: number(1.2, 4, .2, 2.4), height: number(2.4, 6, .2, 4), species: choice('broadleaf', 'conifer'),
    }, generate(p): AssetGeometry {
      const parts: Parts = [], crown = Math.min(p.width, p.height * .6), trunk = p.height - crown;
      piece(parts, 'trunk', [.2, trunk + crown * .25, .2], [0, (trunk + crown * .25) / 2, 0], '#765539', 'cylinder');
      piece(parts, 'crown', [p.width, crown, p.width], [0, trunk + crown / 2, 0], p.species === 'conifer' ? '#375e49' : '#62804b', 'cylinder', false);
      return { parts };
    } }),
    defineAssetFamily({ id: 'fountain', version: '1', parameters: {
      width: number(1.6, 4, .2, 2.8), height: number(.8, 2, .1, 1.4), material,
    }, generate(p) {
      const parts: Parts = [], c = palette(p.material);
      piece(parts, 'basin', [p.width, .3, p.width], [0, .15, 0], c.light, 'cylinder');
      piece(parts, 'water', [p.width * .85, .02, p.width * .85], [0, .31, 0], '#5ca8b9', 'cylinder', false);
      piece(parts, 'stem', [.2, p.height - .3, .2], [0, (p.height + .3) / 2, 0], c.main, 'cylinder');
      piece(parts, 'bowl', [p.width * .4, .1, p.width * .4], [0, p.height - .05, 0], c.light, 'cylinder');
      return { parts };
    } }),
    defineAssetFamily({ id: 'playset', version: '1', parameters: {
      width: number(2, 3.6, .2, 2.8), depth: number(1.2, 2.4, .2, 1.6), height: number(1.8, 3, .2, 2.4), material,
    }, generate(p) {
      const parts: Parts = [], c = palette(p.material);
      for (const x of [-1, 1]) for (const z of [-1, 1]) piece(parts, `post-${x}-${z}`, [.1, p.height, .1], [x * (p.width / 2 - .05), p.height / 2, z * (p.depth / 2 - .05)], c.main);
      piece(parts, 'beam', [p.width, .12, p.depth], [0, p.height - .06, 0], c.dark);
      for (const x of [-1, 1]) {
        piece(parts, `seat-${x}`, [.5, .08, .4], [x * p.width * .22, .55, 0], '#c7864e');
        for (const side of [-1, 1]) piece(parts, `rope-${x}-${side}`, [.018, p.height - .65, .018], [x * p.width * .22 + side * .2, (p.height + .55) / 2, 0], c.light, 'cylinder', false);
      }
      return { parts };
    } }),
    defineAssetFamily({ id: 'vehicle', version: '1', parameters: {
      kind: choice('car', 'patrol', 'fire-engine'), width: number(1.6, 2.8, .1, 2), depth: number(3, 7, .2, 4.2), height: number(1.4, 3.2, .1, 1.8),
    }, generate(p) {
      const parts: Parts = [], w = p.width, d = p.depth, h = p.height;
      const color = p.kind === 'fire-engine' ? '#ba3e37' : p.kind === 'patrol' ? '#d4dce0' : '#648ca5';
      // Body includes undercarriage; four decorative wheels do not add overlapping collision.
      piece(parts, 'body', [w, h * .42, d], [0, h * .32, 0], color);
      piece(parts, 'chassis', [w * .8, h * .11, d * .9], [0, h * .055, 0], '#30363a');
      piece(parts, 'cab', [w * .86, h * .47, d * (p.kind === 'fire-engine' ? .3 : .5)], [0, h * .765, 0], color);
      piece(parts, 'windshield', [w * .72, h * .23, .025], [0, h * .78, d * (p.kind === 'fire-engine' ? .15 : .25)], '#3c687c', 'box', false);
      for (const x of [-1, 1]) for (const z of [-1, 1]) piece(parts, `wheel-${x}-${z}`, [.12, h * .24, h * .24], [x * (w / 2 - .06), h * .12, z * d * .32], '#292d30', 'box', false);
      if (p.kind !== 'car') for (const x of [-1, 1]) piece(parts, `beacon-${x}`, [w * .2, .08, .18], [x * w * .2, h - .04, 0], x < 0 ? '#e54236' : '#3d76ca', 'box', false);
      if (p.kind === 'fire-engine') for (const x of [-1, 1]) piece(parts, `equipment-${x}`, [.03, h * .24, d * .42], [x * (w / 2 - .015), h * .34, -d * .2], '#a8acaf', 'box', false);
      return { parts };
    } }),
  ];
}

/** Small authored forms for support-surface dressing. Fabric shapes are static
 * layered geometry, not cloth simulation; these thin decorative parts do not
 * create actor-blocking collision. Authors may replace any family. */
function dressing(): AssetFamily[] {
  const fabricColors: Record<string, string> = { cream: '#e7dfca', blue: '#6f91ad', sage: '#93a58c', rose: '#b87d86', gold: '#c5a467' };
  const fabric = choice('cream', 'blue', 'sage', 'rose', 'gold');
  return [
    defineAssetFamily({ id: 'nightstand', version: '1', parameters: {
      width: number(.35, .9, .05, .5), depth: number(.3, .8, .05, .45), height: number(.4, .9, .05, .6), material, style: choice('open', 'drawer'),
    }, generate(p) {
      const parts: Parts = [], w = p.width, d = p.depth, h = p.height, c = palette(p.material);
      legs(parts, w, d, h - .06, c.dark, .05);
      piece(parts, 'top', [w, .06, d], [0, h - .03, 0], c.main);
      if (p.style === 'drawer') {
        piece(parts, 'drawer', [w * .86, h * .48, d * .86], [0, h * .64, 0], c.main);
        piece(parts, 'pull', [w * .3, .025, .02], [0, h * .64, d * .43 + .01], c.light, 'box', false);
      } else piece(parts, 'shelf', [w * .86, .04, d * .86], [0, .12, 0], c.main);
      return { parts, surfaces: [{ id: 'top', partId: 'top', tags: ['nightstand', 'tabletop', 'display'], position: { x: 0, y: h, z: 0 }, width: w - .02, depth: d - .02 }] };
    } }),
    defineAssetFamily({ id: 'book', version: '1', parameters: {
      width: number(.1, .35, .01, .18), depth: number(.15, .5, .01, .26), height: number(.015, .12, .005, .035),
      color: choice('red', 'blue', 'green', 'cream', 'black'), style: choice('plain', 'banded'),
    }, generate(p) {
      const parts: Parts = [], w = p.width, d = p.depth, h = p.height;
      const c = ({ red: '#a84c43', blue: '#4f7395', green: '#5e7657', cream: '#d8cba8', black: '#393c42' } as Record<string, string>)[p.color] ?? '#393c42';
      piece(parts, 'pages', [w * .96, h - .006, d * .96], [0, h / 2, 0], '#e8e0ce', 'box', false);
      for (const side of [0, 1]) piece(parts, `cover-${side}`, [w, .003, d], [0, side ? h - .0015 - (p.style === 'banded' ? .001 : 0) : .0015, 0], c, 'box', false);
      piece(parts, 'spine', [.006, h, d], [-w / 2 + .003, h / 2, 0], c, 'box', false);
      if (p.style === 'banded') piece(parts, 'band', [w * .18, .001, d * .9], [w * .2, h - .0005, 0], '#c7ac68', 'box', false);
      return { parts };
    } }),
    defineAssetFamily({ id: 'pillow', version: '1', parameters: {
      width: number(.3, .9, .05, .6), depth: number(.25, .65, .05, .4), height: number(.04, .24, .02, .12), color: fabric, style: choice('plain', 'piped', 'tufted'),
    }, generate(p) {
      const parts: Parts = [], w = p.width, d = p.depth, h = p.height, c = fabricColors[p.color];
      piece(parts, 'base', [w, h * .4, d], [0, h * .2, 0], c, 'box', false);
      const tuft = p.style === 'tufted' ? .004 : 0;
      piece(parts, 'cushion', [w * .9, h * .6 - tuft, d * .9], [0, h * .7 - tuft / 2, 0], c, 'box', false);
      if (p.style === 'piped') {
        for (const sign of [-1, 1]) {
          piece(parts, `seam-x-${sign}`, [w, h * .06, .008], [0, h * .4, sign * (d / 2 - .004)], '#e9e2d4', 'box', false);
          piece(parts, `seam-z-${sign}`, [.008, h * .06, d], [sign * (w / 2 - .004), h * .4, 0], '#e9e2d4', 'box', false);
        }
      }
      if (p.style === 'tufted') for (const sign of [-1, 1]) piece(parts, `tuft-${sign}`, [.02, .004, .02], [sign * w * .2, h - .002, 0], '#b8b1a8', 'cylinder', false);
      return { parts };
    } }),
    defineAssetFamily({ id: 'blanket', version: '1', parameters: {
      width: number(.4, 2, .1, 1.2), depth: number(.3, 2, .1, .8), height: number(.02, .18, .01, .06), color: fabric, style: choice('folded', 'rumpled'),
    }, generate(p) {
      const parts: Parts = [], w = p.width, d = p.depth, h = p.height, c = fabricColors[p.color];
      if (p.style === 'folded') {
        for (let i = 0; i < 3; i++) piece(parts, `fold-${i}`, [w * (1 - i * .025), h / 3, d * (1 - i * .025)], [0, h * (i + .5) / 3, 0], c, 'box', false);
      } else {
        piece(parts, 'base', [w, h * .25, d], [0, h * .125, 0], c, 'box', false);
        for (const sign of [-1, 1]) piece(parts, `ridge-${sign}`, [w * .95, h * .75, d * .22], [0, h * .625, sign * d * .27], c, 'box', false);
        piece(parts, 'middle-fold', [w * .78, h * .4, d * .34], [0, h * .45, 0], c, 'box', false);
      }
      return { parts };
    } }),
  ];
}

/** Mounted models use their complete bounds for contact. Light sockets sit just
 * outside the housing so their own opaque geometry cannot shadow the emitter. */
function fixtures(): AssetFamily[] {
  return [
    defineAssetFamily({ id: 'ceiling-fan-light', version: '1', parameters: {
      diameter: number(.8, 2, .1, 1.4), drop: number(.3, .8, .1, .5), material,
    }, generate(p) {
      const parts: Parts = [], c = palette(p.material), d = p.diameter, h = p.drop;
      piece(parts, 'globe', [.24, .12, .24], [0, .06, 0], '#fff0cf', 'cylinder', false);
      parts.at(-1)!.emissive = '#fff0cf'; parts.at(-1)!.emissiveIntensity = 2;
      piece(parts, 'motor', [.26, .12, .26], [0, .18, 0], c.dark, 'cylinder');
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2, r = d * .29;
        piece(parts, `blade-${i}`, [d * .42, .04, .16], [[r, 0, -r, 0][i], .2, [0, -r, 0, r][i]], c.main, 'box', false, a);
      }
      piece(parts, 'downrod', [.06, h - .24, .06], [0, (h + .24) / 2, 0], c.dark, 'cylinder');
      piece(parts, 'canopy', [.3, .06, .3], [0, h - .03, 0], c.main, 'cylinder');
      return { parts, sockets: [{ id: 'light', tags: ['light'], position: { x: 0, y: -.02, z: 0 } }] };
    } }),
    defineAssetFamily({ id: 'ceiling-light', version: '1', parameters: {
      diameter: number(.16, .6, .02, .28), height: number(.08, .2, .02, .1), material,
    }, generate(p) {
      const parts: Parts = [];
      piece(parts, 'housing', [p.diameter, p.height - .02, p.diameter], [0, (p.height + .02) / 2, 0], palette(p.material).main, 'cylinder');
      piece(parts, 'lens', [p.diameter * .78, .02, p.diameter * .78], [0, .01, 0], '#fff6dd', 'cylinder', false);
      parts.at(-1)!.emissive = '#fff6dd'; parts.at(-1)!.emissiveIntensity = 2;
      return { parts, sockets: [{ id: 'light', tags: ['light'], position: { x: 0, y: -.02, z: 0 } }] };
    } }),
    defineAssetFamily({ id: 'wall-light', version: '1', parameters: {
      width: number(.2, .6, .05, .3), height: number(.25, .65, .05, .4), depth: number(.16, .32, .04, .24), material,
    }, generate(p) {
      const parts: Parts = [], c = palette(p.material);
      piece(parts, 'backplate', [p.width, p.height, .04], [0, p.height / 2, -p.depth / 2 + .02], c.dark);
      piece(parts, 'housing', [p.width * .8, p.height * .8, p.depth - .02], [0, p.height / 2, -.01], c.main);
      piece(parts, 'lens', [p.width * .65, p.height * .62, .02], [0, p.height / 2, p.depth / 2 - .01], '#fff0cf', 'box', false);
      parts.at(-1)!.emissive = '#fff0cf'; parts.at(-1)!.emissiveIntensity = 2;
      return { parts, sockets: [{ id: 'light', tags: ['light'], position: { x: 0, y: p.height / 2, z: p.depth / 2 + .02 } }] };
    } }),
  ];
}

export function standardAssetFamilies(): AssetFamily[] { return [...starters(), ...outdoors(), ...fixtures(), ...dressing()]; }
export function createStandardAssetCatalog(options: { maxVariants?: number } = {}) { return createAssetCatalog(standardAssetFamilies(), options); }
