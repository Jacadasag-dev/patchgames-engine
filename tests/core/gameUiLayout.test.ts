import { describe, expect, it } from 'vitest';
import { GameUiLayoutError } from '../../src/shared/gameUi.ts';
import type { GameUiDocument, GameUiNode, GameUiPanel, GameUiPlacement, GameUiRole, GameUiViewport } from '../../src/shared/gameUi.ts';
import { inspectGameUiLayout, layoutGameUi, validateGameUi, validateGameUiCss } from '../../src/shared/gameUiLayout.ts';

function panel(id: string, role: GameUiRole = 'custom', extra: Partial<GameUiPanel> = {}): GameUiPanel {
  return { id, role, children: role === 'crosshair' ? [{ kind: 'crosshair', shape: 'plus' }] : [{ kind: 'text', text: id }], ...extra };
}
function doc(...panels: GameUiPanel[]): GameUiDocument { return { version: 1, panels }; }
function issueCodes(run: () => unknown): string[] {
  try { run(); throw new Error('Expected GameUiLayoutError'); }
  catch (error) { expect(error).toBeInstanceOf(GameUiLayoutError); return (error as GameUiLayoutError).issues.map(issue => issue.code); }
}
function clean(placements: GameUiPlacement[], viewport: GameUiViewport): void {
  expect(inspectGameUiLayout(placements, viewport)).toEqual([]);
}

describe('game UI document validation', () => {
  it('returns a detached serializable document and resolves explicit replacement chains', () => {
    const input = doc(panel('base', 'health'), panel('mod', 'health', { replaces: 'base' }), panel('skin', 'health', { replaces: 'mod' }));
    const result = validateGameUi(input);
    expect(result.panels.map(p => p.id)).toEqual(['skin']);
    expect(result.panels[0]!.replaces).toBeUndefined();
    result.panels[0]!.title = 'Changed';
    expect(input.panels[2]!.title).toBeUndefined();
    expect(validateGameUi(result)).toEqual(result);
  });

  it('rejects duplicate ids, exclusive roles, missing replacements and replacement cycles', () => {
    expect(issueCodes(() => validateGameUi(doc(panel('same'), panel('same'))))).toContain('duplicate-id');
    expect(issueCodes(() => validateGameUi(doc(panel('a', 'health'), panel('b', 'health'))))).toContain('exclusive-role');
    expect(issueCodes(() => validateGameUi(doc(panel('a', 'health', { replaces: 'missing' }))))).toContain('missing-replacement');
    expect(issueCodes(() => validateGameUi(doc(panel('a', 'health', { replaces: 'b' }), panel('b', 'health', { replaces: 'a' }))))).toContain('replacement-cycle');
  });

  it('requires declared intents and bounded, finite action values', () => {
    const input = doc(panel('buttons', 'custom', { children: [{ kind: 'button', label: 'Use', action: { name: 'use', index: 0 } }] }));
    expect(issueCodes(() => validateGameUi(input))).toContain('undeclared-action');
    input.actions = [{ name: 'use', label: 'Use item' }];
    expect(validateGameUi(input)).toEqual(input);
    (input.panels[0]!.children[0] as { action: { value?: number } }).action.value = Infinity;
    expect(issueCodes(() => validateGameUi(input))).toContain('invalid-document');
  });

  it('scopes node ids to their owning panel while rejecting duplicates inside one panel', () => {
    const first = panel('a', 'custom', { children: [{ kind: 'text', id: 'value', text: 'A' }] });
    const second = panel('b', 'custom', { children: [{ kind: 'text', id: 'value', text: 'B' }] });
    expect(validateGameUi(doc(first, second)).panels).toHaveLength(2);
    first.children.push({ kind: 'text', id: 'value', text: 'duplicate' });
    expect(issueCodes(() => validateGameUi(doc(first)))).toContain('duplicate-id');
  });

  it('normalizes optional undefined object fields but rejects undefined array entries and functions', () => {
    const input = doc(panel('a', 'custom', { title: undefined, children: [{ kind: 'text', text: 'a', tone: undefined }] }));
    expect(validateGameUi(input)).toEqual(doc(panel('a')));
    const arrayValue = doc(panel('a')); (arrayValue.panels[0]!.children as unknown[]).push(undefined);
    expect(issueCodes(() => validateGameUi(arrayValue))).toContain('invalid-document');
    expect(issueCodes(() => validateGameUi({ ...input, unexpected: () => 'ignored by JSON' }))).toContain('invalid-document');
  });

  it('rejects malformed grid occupancy while accepting rotated spatial items', () => {
    const logical = doc(panel('inventory', 'inventory', { presentation: 'modal', children: [{ kind: 'grid', id: 'bag', label: 'Bag', columns: 2, rows: 2, items: [{ id: 'a', label: 'A', slot: 1 }, { id: 'b', label: 'B', slot: 1 }] }] }));
    expect(issueCodes(() => validateGameUi(logical))).toContain('grid-overlap');
    const spatial = doc(panel('inventory', 'inventory', { presentation: 'modal', children: [{ kind: 'grid', id: 'bag', label: 'Bag', columns: 3, rows: 2, spatial: true, items: [{ id: 'a', label: 'A', x: 0, y: 0, width: 2, height: 3, rotated: true }] }] }));
    expect(validateGameUi(spatial)).toEqual(spatial);
    (spatial.panels[0]!.children[0] as { items: { x: number }[] }).items[0]!.x = 1;
    expect(issueCodes(() => validateGameUi(spatial))).toContain('grid-bounds');
  });

  it('bounds document size, panel count, node count and nesting', () => {
    expect(issueCodes(() => validateGameUi(doc(...Array.from({ length: 33 }, (_, i) => panel(`p${i}`)))))).toContain('invalid-document');
    expect(issueCodes(() => validateGameUi(doc(panel('large', 'custom', { children: Array.from({ length: 2049 }, () => ({ kind: 'text' as const, text: 'x' })) }))))).toContain('document-budget');
    let children: GameUiPanel['children'] = [{ kind: 'text', text: 'deep' }];
    for (let i = 0; i < 12; i++) children = [{ kind: 'stack', children }];
    expect(issueCodes(() => validateGameUi(doc(panel('deep', 'custom', { children }))))).toContain('document-budget');
    expect(issueCodes(() => validateGameUi(doc(panel('big', 'custom', { title: '🚀'.repeat(40_000) }))))).toContain('document-budget');
  });

  it('charges generated grid slots, including empty and inactive grids, to the document budget', () => {
    const grid = (id: string, columns = 32, rows = 32): GameUiNode => ({ kind: 'grid', id, label: 'Storage', columns, rows, items: [] });
    const huge = doc(panel('inventory', 'inventory', { presentation: 'modal', children: Array.from({ length: 700 }, (_, index) => grid(`g${index}`, 64, 64)) }));
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeLessThan(128 * 1024);
    expect(issueCodes(() => validateGameUi(huge))).toContain('document-budget');
    expect(() => validateGameUi(huge)).toThrow(/rendered grid slots; reduce grid dimensions/);
    const tabs = doc(panel('inventory', 'inventory', { presentation: 'modal', children: [{ kind: 'tabs', label: 'Bags', selected: 'first', tabs: [
      { id: 'first', label: 'First', children: [grid('first-grid')] },
      { id: 'inactive', label: 'Inactive', children: [grid('inactive-grid')] },
    ] }] }));
    expect(issueCodes(() => validateGameUi(tabs))).toContain('document-budget');
    const hidden = doc(panel('visible', 'inventory', { children: [grid('visible-grid')] }), panel('hidden', 'inventory', { visible: false, children: [grid('hidden-grid')] }));
    expect(issueCodes(() => validateGameUi(hidden))).toContain('document-budget');
    expect(() => validateGameUi(doc(panel('small', 'inventory', { children: [grid('small-grid', 16, 32)] })))).not.toThrow();
  });

  it('limits crosshair ownership to one visible center HUD panel', () => {
    expect(issueCodes(() => validateGameUi(doc(panel('a', 'crosshair'), panel('b', 'crosshair'))))).toContain('exclusive-crosshair');
    expect(issueCodes(() => validateGameUi(doc(panel('a', 'custom', { children: [{ kind: 'crosshair' }] }))))).toContain('crosshair-role');
    expect(issueCodes(() => validateGameUi(doc(panel('a', 'crosshair', { region: 'top-left' }))))).toContain('crosshair-role');
  });

  it('keeps crosshair thickness and tick gaps inside the rendered size and defaults', () => {
    const crosshair = (extra: Partial<Extract<GameUiNode, { kind: 'crosshair' }>>): GameUiDocument => doc(panel('aim', 'crosshair', { children: [{ kind: 'crosshair', ...extra }] }));
    for (const input of [crosshair({ shape: 'ticks', size: 20, gap: 20 }), crosshair({ shape: 'ticks', gap: 20 }), crosshair({ shape: 'ticks', size: 2 }), crosshair({ size: 2, thickness: 3 })]) {
      expect(issueCodes(() => validateGameUi(input))).toContain('crosshair-geometry');
    }
    for (const input of [crosshair({ shape: 'ticks', size: 20, gap: 19, thickness: 8 }), crosshair({ shape: 'plus', size: 2, gap: 24, thickness: 2 }), crosshair({ shape: 'dot', thickness: 8 })]) {
      expect(() => validateGameUi(input)).not.toThrow();
    }
  });
});

describe('component CSS capability validation', () => {
  it('allows ordinary scoped skin and layout CSS', () => {
    expect(() => validateGameUiCss('.ui-panel{display:grid;gap:8px;background:linear-gradient(#123,#234)} .ui-slot[data-rarity="rare"]{color:var(--ui-accent);border:1px solid #fff} @media(max-width:500px){.ui-panel{grid-template-columns:1fr}}')).not.toThrow();
  });
  it.each([
    ':host{position:fixed}', ':host-context(body){color:red}', '::slotted(button){color:red}',
    '@import "https://example.com/a.css";', '.ui-panel{background:url(https://example.com/x)}',
    '.ui-panel{background:u\\72l(https://example.com/x)}', '.ui-panel{background:image-set("https://example.com/x" 1x)}',
    '.ui-panel{position:fixed}', '.ui-panel{position:var(--ui-position,fixed)}', '.ui-panel{width:expression(alert(1))}',
    '.ui-panel{background:u/**/rl(https://example.com/x)}',
  ])('rejects escaped/host/network/executable CSS %s', css => {
    expect(() => validateGameUiCss(css)).toThrow(GameUiLayoutError);
  });
  it('bounds CSS independently of document size', () => {
    expect(issueCodes(() => validateGameUiCss(' '.repeat(32 * 1024 + 1)))).toContain('css-budget');
  });
});

describe('game UI layout', () => {
  it('uses semantic defaults on a roomy desktop and keeps the center aim clear', () => {
    const input = doc(...(['health', 'hotbar', 'ammo', 'minimap', 'objective', 'status', 'chat', 'crosshair'] as const).map(role => panel(role, role)));
    const viewport = { width: 1440, height: 900 };
    const placements = layoutGameUi(input, viewport);
    expect(Object.fromEntries(placements.map(p => [p.id, p.region]))).toEqual({ health: 'bottom-left', hotbar: 'bottom-center', ammo: 'bottom-right', minimap: 'top-left', objective: 'top-center', status: 'top-right', chat: 'middle-left', crosshair: 'center' });
    clean(placements, viewport);
  });

  it.each([
    { width: 320, height: 568 },
    { width: 360, height: 640, touch: true },
    { width: 390, height: 844, touch: true, leftHanded: true, safeArea: { top: 47, right: 8, bottom: 34, left: 8 } },
    { width: 568, height: 320, touch: true },
  ])('reflows narrow HUDs without target scaling or overlaps at %j', viewport => {
    const input = doc(panel('health', 'health'), panel('ammo', 'ammo'), panel('hotbar', 'hotbar'), panel('objective', 'objective'), panel('aim', 'crosshair'));
    const placements = layoutGameUi(input, viewport);
    clean(placements, viewport);
    for (const p of placements.filter(p => p.id !== 'aim')) { expect(p.width).toBeGreaterThanOrEqual(44); expect(p.height).toBeGreaterThanOrEqual(44); }
  });

  it('packs auto panels in stable id order regardless of mod array ordering', () => {
    const panels = [panel('z'), panel('a'), panel('m')];
    const viewport = { width: 800, height: 600 };
    const first = layoutGameUi(doc(...panels), viewport);
    const reordered = layoutGameUi(doc(...panels.reverse()), viewport);
    expect(reordered).toEqual(first);
    clean(first, viewport);
  });

  it('honors safe-area and caller host reservations', () => {
    const viewport = { width: 800, height: 600, safeArea: { top: 20, right: 30, bottom: 40, left: 10 }, reservations: [{ id: 'host:timer', x: 300, y: 20, width: 200, height: 60 }] };
    const placements = layoutGameUi(doc(panel('objective', 'objective'), panel('health', 'health')), viewport);
    clean(placements, viewport);
    expect(placements.every(p => p.x >= 10 && p.y >= 20 && p.x + p.width <= 770 && p.y + p.height <= 560)).toBe(true);
  });

  it('rejects explicit unsafe regions with panel ids and a concrete remedy', () => {
    const input = doc(panel('one', 'custom', { region: 'top-left' }), panel('two', 'custom', { region: 'top-left' }));
    try { layoutGameUi(input, { width: 800, height: 600 }); throw new Error('expected a conflict'); }
    catch (error) {
      expect(error).toBeInstanceOf(GameUiLayoutError);
      const issue = (error as GameUiLayoutError).issues[0]!;
      expect(issue.panel).toBe('two'); expect(issue.conflictsWith).toBe('one'); expect(issue.message).toContain('region:"auto"');
    }
    expect(issueCodes(() => layoutGameUi(doc(panel('center', 'health', { region: 'center' })), { width: 800, height: 600 }))).toContain('requested-region-conflict');
    expect(issueCodes(() => layoutGameUi(doc(panel('touch-collision', 'ammo', { region: 'bottom-right' })), { width: 390, height: 844, touch: true }))).toContain('requested-region-conflict');
  });

  it('reports crowded HUDs instead of silently overlapping', () => {
    expect(issueCodes(() => layoutGameUi(doc(...Array.from({ length: 12 }, (_, i) => panel(`p${i}`, 'custom', { width: 200, height: 150 }))), { width: 320, height: 480 }))).toContain('hud-overflow');
  });

  it('clamps modal dimensions to the safe viewport and hides HUD during the modal', () => {
    const viewport = { width: 320, height: 480, touch: true, safeArea: { top: 20, right: 10, bottom: 15, left: 10 } };
    const placements = layoutGameUi(doc(panel('health', 'health'), panel('bag', 'inventory', { presentation: 'modal', width: 1000, height: 1000 })), viewport);
    expect(placements).toEqual([{ id: 'bag', region: 'center', modal: true, x: 10, y: 20, width: 300, height: 445 }]);
    clean(placements, viewport);
  });

  it.each([
    { width: 390, height: 844, touch: true, safeArea: { top: 47, right: 0, bottom: 34, left: 0 }, menu: { x: 306, y: 47, width: 70, height: 44 } },
    { width: 844, height: 390, touch: true, safeArea: { top: 0, right: 20, bottom: 12, left: 20 }, menu: { x: 760, y: 62, width: 70, height: 44 } },
  ])('keeps modal title and close lanes clear of the actual touch menu at $width×$height', ({ menu, ...viewport }) => {
    const reserved: GameUiViewport = { ...viewport, reservations: [{ id: 'host:menu', role: 'host', ...menu }, { id: 'host:touch', role: 'touch', x: 0, y: 0, width: viewport.width, height: viewport.height }] };
    const input = doc(panel('bag', 'inventory', { presentation: 'modal', width: 1000, height: 1000 }));
    const placements = layoutGameUi(input, reserved);
    clean(placements, reserved);
    const modal = placements[0]!;
    expect(modal.width).toBeGreaterThanOrEqual(44); expect(modal.height).toBeGreaterThanOrEqual(44);
    expect(modal.x + modal.width <= menu.x - 4 || modal.y >= menu.y + menu.height + 4 || modal.y + modal.height <= menu.y - 4 || modal.x >= menu.x + menu.width + 4).toBe(true);
    expect(layoutGameUi(input, { ...reserved, reservations: [...reserved.reservations!].reverse() })).toEqual(placements);
  });

  it('allocates non-dismissible panels below the mobile menu even when their component skin is unusable', () => {
    const viewport: GameUiViewport = { width: 390, height: 844, touch: true, reservations: [{ id: 'host:menu', role: 'host', x: 306, y: 18, width: 70, height: 44 }] };
    const input = doc(panel('broken', 'inventory', { presentation: 'modal', width: 1000, height: 1000, children: [{ kind: 'button', label: 'Use', action: { name: 'use' } }] }));
    input.actions = [{ name: 'use', label: 'Use item' }]; input.theme = { css: '.ui-button{min-width:0;min-height:0;width:12px;height:12px;padding:0}' };
    const placements = layoutGameUi(input, viewport);
    expect(placements[0]!.y).toBe(66);
    expect(input.panels[0]!.onDismiss).toBeUndefined(); clean(placements, viewport);
  });

  it('bounds caller reservation counts and reports host controls which leave no usable modal lane', () => {
    const input = doc(panel('bag', 'inventory', { presentation: 'modal' }));
    expect(issueCodes(() => layoutGameUi(input, { width: 800, height: 600, reservations: Array.from({ length: 65 }, (_, index) => ({ id: `host:${index}`, role: 'host', x: 0, y: 0, width: 1, height: 1 })) }))).toContain('invalid-reservation');
    try { layoutGameUi(input, { width: 100, height: 100, reservations: [{ id: 'host:menu', role: 'host', x: 0, y: 0, width: 100, height: 100 }] }); throw new Error('Expected a modal overflow'); }
    catch (error) { expect(error).toBeInstanceOf(GameUiLayoutError); expect((error as GameUiLayoutError).issues[0]).toMatchObject({ code: 'modal-overflow', panel: 'bag', conflictsWith: 'host:menu' }); }
    const measured = inspectGameUiLayout([{ id: 'bag', region: 'center', modal: true, x: 0, y: 0, width: 100, height: 100 }], { width: 100, height: 100, reservations: [{ id: 'host:menu', role: 'host', x: 0, y: 0, width: 44, height: 44 }] });
    expect(measured[0]).toMatchObject({ code: 'requested-region-conflict', panel: 'bag', conflictsWith: 'host:menu' });
  });

  it('finds a stable largest free lane with the maximum scattered host reservations', () => {
    const viewport: GameUiViewport = { width: 1280, height: 720, reservations: Array.from({ length: 64 }, (_, index) => ({
      id: `host:${index}`, role: 'host', x: 60 + index % 8 * 100, y: 20 + Math.floor(index / 8) * 80, width: 20, height: 20,
    })) };
    const input = doc(panel('bag', 'inventory', { presentation: 'modal', width: 2000, height: 2000 }));
    const placements = layoutGameUi(input, viewport);
    expect(placements).toEqual([{ id: 'bag', region: 'center', modal: true, x: 784, y: 0, width: 496, height: 720 }]);
    expect(layoutGameUi(input, { ...viewport, reservations: [...viewport.reservations!].reverse() })).toEqual(placements);
    clean(placements, viewport);
  });

  it('reports measured clipping and collisions after rendering', () => {
    const issues = inspectGameUiLayout([{ id: 'a', region: 'top-left', modal: false, x: -1, y: 0, width: 200, height: 100 }, { id: 'b', region: 'top-left', modal: false, x: 20, y: 20, width: 100, height: 80 }], { width: 800, height: 600 });
    expect(issues.map(issue => issue.code)).toEqual(['panel-clipping', 'requested-region-conflict']);
  });
});
