import { GameUiLayoutError } from './gameUi.ts';
import type {
  GameUiDocument, GameUiIssue, GameUiPanel, GameUiPlacement,
  GameUiRect, GameUiRegion, GameUiReservation, GameUiRole, GameUiViewport,
} from './gameUi.ts';

const MAX_JSON_BYTES = 128 * 1024;
const MAX_CSS_BYTES = 32 * 1024;
const MAX_NODES = 2048;
const roles: readonly GameUiRole[] = ['health', 'status', 'objective', 'minimap', 'ammo', 'hotbar', 'chat', 'inventory', 'loot', 'store', 'selection', 'crosshair', 'custom'];
const regions: readonly GameUiRegion[] = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right', 'center'];
const semanticRegions: Record<GameUiRole, GameUiRegion> = {
  health: 'bottom-left', hotbar: 'bottom-center', ammo: 'bottom-right', minimap: 'top-left',
  objective: 'top-center', status: 'top-right', chat: 'middle-left', crosshair: 'center',
  inventory: 'top-left', loot: 'top-right', store: 'top-center', selection: 'top-center', custom: 'top-right',
};
const defaultSizes: Record<GameUiRole, readonly [number, number]> = {
  health: [224, 64], hotbar: [360, 64], ammo: [128, 64], minimap: [160, 132],
  objective: [256, 64], status: [176, 64], chat: [240, 120], crosshair: [32, 32],
  inventory: [360, 320], loot: [300, 280], store: [480, 360], selection: [520, 360], custom: [200, 80],
};
const hudMinimumSizes: Partial<Record<GameUiRole, readonly [number, number]>> = {
  health: [140, 64], hotbar: [144, 84], minimap: [96, 96], objective: [140, 64],
  status: [140, 64], ammo: [96, 64], crosshair: [32, 32],
};
const encoder = new TextEncoder();
type Obj = Record<string, unknown>;
function object(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class Validation {
  readonly issues: GameUiIssue[] = [];
  nodes = 0;
  readonly nodeIds = new Set<string>();
  readonly actionNames = new Set<string>();
  crosshairs = 0;
  issue(path: string, message: string, panel?: string, code = 'invalid-document'): void {
    if (this.issues.length < 64) this.issues.push({ code, message: `${path}: ${message}`, ...(panel ? { panel } : {}) });
  }
  keys(value: Obj, allowed: readonly string[], path: string, panel?: string): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.issue(`${path}.${key}`, 'unknown field; use the version 1 UI contract.', panel);
  }
  str(value: unknown, path: string, max = 256, optional = false, panel?: string): value is string {
    if (optional && value === undefined) return false;
    if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
      this.issue(path, `expected nonempty text of at most ${max} characters without control characters.`, panel);
      return false;
    }
    return true;
  }
  id(value: unknown, path: string, optional = false, panel?: string): value is string {
    if (!this.str(value, path, 96, optional, panel)) return false;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(value)) this.issue(path, 'use a stable id containing letters, numbers, dots, colons, underscores or hyphens.', panel);
    return true;
  }
  num(value: unknown, path: string, min: number, max: number, optional = false, integer = false, panel?: string): value is number {
    if (optional && value === undefined) return false;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      this.issue(path, `expected a finite ${integer ? 'integer' : 'number'} from ${min} to ${max}.`, panel);
      return false;
    }
    return true;
  }
  bool(value: unknown, path: string, panel?: string): void {
    if (value !== undefined && typeof value !== 'boolean') this.issue(path, 'expected a boolean.', panel);
  }
  one(value: unknown, allowed: readonly string[], path: string, optional = true, panel?: string): void {
    if (!(optional && value === undefined) && (typeof value !== 'string' || !allowed.includes(value))) this.issue(path, `expected one of ${allowed.join(', ')}.`, panel);
  }
  action(value: unknown, path: string, optional: boolean, panel: string): void {
    if (optional && value === undefined) return;
    if (!object(value)) { this.issue(path, 'expected a declared action object.', panel); return; }
    this.keys(value, ['name', 'value', 'item', 'source', 'target', 'index', 'sceneSequence', 'x', 'y', 'rotated'], path, panel);
    if (this.id(value.name, `${path}.name`, false, panel) && !this.actionNames.has(value.name)) this.issue(`${path}.name`, `action "${value.name}" must be declared in document.actions.`, panel, 'undeclared-action');
    for (const key of ['item', 'source', 'target']) this.str(value[key], `${path}.${key}`, 96, true, panel);
    for (const key of ['value', 'x', 'y']) this.num(value[key], `${path}.${key}`, -1e6, 1e6, true, false, panel);
    this.num(value.index, `${path}.index`, 0, 1e6, true, true, panel);
    this.num(value.sceneSequence, `${path}.sceneSequence`, 1, 4294967295, true, true, panel);
    this.bool(value.rotated, `${path}.rotated`, panel);
  }
  count(path: string, panel: string, amount = 1): boolean {
    this.nodes += amount;
    if (this.nodes > MAX_NODES) { this.issue(path, `UI exceeds ${MAX_NODES} nodes/items/rendered grid slots; reduce grid dimensions or split/page the content.`, panel, 'document-budget'); return false; }
    return true;
  }
  children(value: unknown, path: string, depth: number, panel: string): void {
    if (!Array.isArray(value)) { this.issue(path, 'expected a node array.', panel); return; }
    if (depth > 12) { this.issue(path, 'node nesting exceeds 12 levels; flatten the component tree.', panel, 'document-budget'); return; }
    for (let i = 0; i < value.length && this.nodes <= MAX_NODES; i++) this.node(value[i], `${path}[${i}]`, depth, panel);
  }
  node(value: unknown, path: string, depth: number, panel: string): void {
    if (!this.count(path, panel)) return;
    if (!object(value)) { this.issue(path, 'expected a UI node.', panel); return; }
    if (value.id !== undefined && this.id(value.id, `${path}.id`, false, panel)) {
      const scopedId = `${panel}\0${value.id}`;
      if (this.nodeIds.has(scopedId)) this.issue(`${path}.id`, `duplicate node id "${value.id}" in panel "${panel}"; assign a unique stable id.`, panel, 'duplicate-id');
      this.nodeIds.add(scopedId);
    }
    if (this.str(value.className, `${path}.className`, 256, true, panel) && !/^[a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)*$/u.test(value.className)) this.issue(`${path}.className`, 'expected space-separated CSS class names.', panel);
    const base = ['kind', 'id', 'className'];
    switch (value.kind) {
      case 'text':
        this.keys(value, [...base, 'text', 'tone', 'heading'], path, panel);
        // Empty text is useful for a value which has not arrived yet.
        if (value.text !== '') this.str(value.text, `${path}.text`, 4096, false, panel);
        this.one(value.tone, ['muted', 'accent', 'danger', 'success'], `${path}.tone`, true, panel);
        this.bool(value.heading, `${path}.heading`, panel);
        break;
      case 'row': case 'stack':
        this.keys(value, [...base, 'children', 'label'], path, panel);
        this.str(value.label, `${path}.label`, 256, true, panel);
        this.children(value.children, `${path}.children`, depth + 1, panel);
        break;
      case 'bar':
        this.keys(value, [...base, 'label', 'value', 'max', 'tone'], path, panel);
        this.str(value.label, `${path}.label`, 256, false, panel);
        this.num(value.max, `${path}.max`, Number.MIN_VALUE, 1e6, false, false, panel);
        if (this.num(value.value, `${path}.value`, 0, 1e6, false, false, panel) && typeof value.max === 'number' && value.value > value.max) this.issue(`${path}.value`, 'bar value exceeds max.', panel);
        this.one(value.tone, ['health', 'armor', 'energy'], `${path}.tone`, true, panel);
        break;
      case 'button':
        this.keys(value, [...base, 'label', 'action', 'disabled', 'primary'], path, panel);
        this.str(value.label, `${path}.label`, 256, false, panel);
        this.action(value.action, `${path}.action`, false, panel);
        this.bool(value.disabled, `${path}.disabled`, panel); this.bool(value.primary, `${path}.primary`, panel);
        break;
      case 'grid': this.grid(value, path, panel, base); break;
      case 'choices': this.choices(value, path, panel, base); break;
      case 'tabs': {
        this.keys(value, [...base, 'label', 'tabs', 'selected'], path, panel);
        this.str(value.label, `${path}.label`, 256, false, panel);
        if (!Array.isArray(value.tabs) || value.tabs.length === 0 || value.tabs.length > 64) { this.issue(`${path}.tabs`, 'expected 1 to 64 tabs.', panel); break; }
        const ids = new Set<string>();
        for (let i = 0; i < value.tabs.length; i++) {
          const tab = value.tabs[i]; const tp = `${path}.tabs[${i}]`;
          if (!object(tab)) { this.issue(tp, 'expected a tab.', panel); continue; }
          this.keys(tab, ['id', 'label', 'children'], tp, panel);
          if (this.id(tab.id, `${tp}.id`, false, panel)) { if (ids.has(tab.id)) this.issue(`${tp}.id`, `duplicate tab id "${tab.id}".`, panel, 'duplicate-id'); ids.add(tab.id); }
          this.str(tab.label, `${tp}.label`, 256, false, panel); this.children(tab.children, `${tp}.children`, depth + 1, panel);
        }
        if (this.id(value.selected, `${path}.selected`, true, panel) && !ids.has(value.selected)) this.issue(`${path}.selected`, 'selected tab does not exist.', panel);
        break;
      }
      case 'crosshair': {
        this.keys(value, [...base, 'shape', 'color', 'size', 'gap', 'thickness', 'outline'], path, panel);
        this.crosshairs++;
        this.one(value.shape, ['dot', 'plus', 'ring', 'ticks'], `${path}.shape`, true, panel);
        if (this.str(value.color, `${path}.color`, 64, true, panel) && !/^(?:#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,24}|(?:rgb|hsl)a?\([\d\s.,%+-]+\))$/u.test(value.color)) this.issue(`${path}.color`, 'use a plain CSS color, such as #ffffff or rgb(255 255 255).', panel);
        this.num(value.size, `${path}.size`, 2, 64, true, false, panel);
        this.num(value.gap, `${path}.gap`, 0, 24, true, false, panel);
        this.num(value.thickness, `${path}.thickness`, 1, 8, true, false, panel);
        // Match the rendered node defaults, rather than its larger aim reservation.
        const size = typeof value.size === 'number' ? value.size : 20;
        const thickness = typeof value.thickness === 'number' ? value.thickness : 2;
        const gap = typeof value.gap === 'number' ? value.gap : 4;
        if (thickness > size) this.issue(`${path}.thickness`, 'crosshair thickness must not exceed its size.', panel, 'crosshair-geometry');
        if (value.shape === 'ticks' && gap >= size) this.issue(`${path}.gap`, 'tick crosshair gap must be smaller than its size so the arms remain visible.', panel, 'crosshair-geometry');
        this.bool(value.outline, `${path}.outline`, panel);
        break;
      }
      default: this.issue(`${path}.kind`, 'unknown node kind; use text, row, stack, bar, button, grid, choices, tabs or crosshair.', panel);
    }
  }
  grid(value: Obj, path: string, panel: string, base: string[]): void {
    this.keys(value, [...base, 'label', 'columns', 'rows', 'items', 'spatial', 'flow', 'action', 'moveAction', 'selected'], path, panel);
    if(value.flow!==undefined&&!['reflow','scroll'].includes(String(value.flow)))this.issue(`${path}.flow`,'use reflow or scroll.',panel);
    if(value.spatial===true&&value.flow==='reflow')this.issue(`${path}.flow`,'spatial containers preserve cell topology; use scroll.',panel);
    if (value.id === undefined) this.id(value.id, `${path}.id`, false, panel);
    this.str(value.label, `${path}.label`, 256, false, panel);
    const validColumns = this.num(value.columns, `${path}.columns`, 1, 64, false, true, panel);
    const validRows = this.num(value.rows, `${path}.rows`, 1, 64, false, true, panel);
    // The host eagerly creates every slot, including empty grids in hidden tabs.
    // Charge them before inspecting items so small documents cannot allocate huge DOM trees.
    if (validColumns && validRows && !this.count(path, panel, (value.columns as number) * (value.rows as number))) return;
    this.bool(value.spatial, `${path}.spatial`, panel);
    this.action(value.action, `${path}.action`, true, panel); this.action(value.moveAction, `${path}.moveAction`, true, panel);
    if (!Array.isArray(value.items)) { this.issue(`${path}.items`, 'expected an item array.', panel); return; }
    const ids = new Set<string>(); const occupied = new Map<number, string>();
    for (let i = 0; i < value.items.length && this.nodes <= MAX_NODES; i++) {
      const item = value.items[i]; const ip = `${path}.items[${i}]`;
      if (!this.count(ip, panel)) break;
      if (!object(item)) { this.issue(ip, 'expected an item.', panel); continue; }
      this.keys(item, ['id', 'label', 'icon', 'description', 'count', 'selected', 'disabled', 'rarity', 'slot', 'x', 'y', 'width', 'height', 'rotated', 'meta', 'action'], ip, panel);
      if (this.id(item.id, `${ip}.id`, false, panel)) { if (ids.has(item.id)) this.issue(`${ip}.id`, `duplicate item id "${item.id}".`, panel, 'duplicate-id'); ids.add(item.id); }
      this.str(item.label, `${ip}.label`, 256, false, panel);
      for (const key of ['icon', 'meta']) this.str(item[key], `${ip}.${key}`, 256, true, panel);
      this.str(item.description, `${ip}.description`, 4096, true, panel);
      this.num(item.count, `${ip}.count`, 0, 1e6, true, true, panel);
      for (const key of ['selected', 'disabled', 'rotated']) this.bool(item[key], `${ip}.${key}`, panel);
      this.one(item.rarity, ['common', 'uncommon', 'rare', 'epic', 'legendary'], `${ip}.rarity`, true, panel);
      this.action(item.action, `${ip}.action`, true, panel);
      for (const key of ['slot', 'x', 'y']) this.num(item[key], `${ip}.${key}`, 0, 4095, true, true, panel);
      for (const key of ['width', 'height']) this.num(item[key], `${ip}.${key}`, 1, 64, true, true, panel);
      if (!validColumns || !validRows) continue;
      const cols = value.columns as number; const rows = value.rows as number;
      let x: number; let y: number; let width = 1; let height = 1;
      if (value.spatial === true) {
        if (item.slot !== undefined) this.issue(`${ip}.slot`, 'spatial items use x/y coordinates instead of slot.', panel);
        if (!this.num(item.x, `${ip}.x`, 0, cols - 1, false, true, panel) || !this.num(item.y, `${ip}.y`, 0, rows - 1, false, true, panel)) continue;
        x = item.x as number; y = item.y as number;
        width = typeof item.width === 'number' ? item.width : 1; height = typeof item.height === 'number' ? item.height : 1;
        if (item.rotated === true) [width, height] = [height, width];
      } else {
        if (['x', 'y', 'width', 'height', 'rotated'].some(key => item[key] !== undefined)) this.issue(ip, 'logical slot grids use slot; set spatial:true for x/y and item dimensions.', panel);
        const slot = item.slot === undefined ? i : item.slot;
        if (!this.num(slot, `${ip}.slot`, 0, cols * rows - 1, false, true, panel)) continue;
        x = (slot as number) % cols; y = Math.floor((slot as number) / cols);
      }
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 64 || height > 64) continue;
      if (x + width > cols || y + height > rows) { this.issue(ip, `item "${String(item.id)}" extends beyond the ${cols}×${rows} grid; move, rotate or resize it.`, panel, 'grid-bounds'); continue; }
      for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
        const cell = (y + dy) * cols + x + dx; const previous = occupied.get(cell);
        if (previous) { this.issue(ip, `items "${previous}" and "${String(item.id)}" occupy the same cell; give them distinct slots or coordinates.`, panel, 'grid-overlap'); dy = height; break; }
        occupied.set(cell, String(item.id));
      }
    }
    if (this.id(value.selected, `${path}.selected`, true, panel) && !ids.has(value.selected)) this.issue(`${path}.selected`, 'selected item does not exist.', panel);
  }
  choices(value: Obj, path: string, panel: string, base: string[]): void {
    this.keys(value, [...base, 'label', 'items', 'columns', 'variant', 'action', 'searchable'], path, panel);
    this.str(value.label, `${path}.label`, 256, false, panel);
    this.num(value.columns, `${path}.columns`, 1, 64, true, true, panel);
    this.one(value.variant, ['cards', 'portraits', 'roster'], `${path}.variant`, true, panel);
    this.bool(value.searchable, `${path}.searchable`, panel); this.action(value.action, `${path}.action`, true, panel);
    if (!Array.isArray(value.items)) { this.issue(`${path}.items`, 'expected a choice array.', panel); return; }
    const ids = new Set<string>();
    for (let i = 0; i < value.items.length && this.nodes <= MAX_NODES; i++) {
      const item = value.items[i]; const ip = `${path}.items[${i}]`;
      if (!this.count(ip, panel)) break;
      if (!object(item)) { this.issue(ip, 'expected a choice.', panel); continue; }
      this.keys(item, ['id', 'label', 'description', 'role', 'icon', 'meta', 'selected', 'confirmed', 'disabled', 'action'], ip, panel);
      if (this.id(item.id, `${ip}.id`, false, panel)) { if (ids.has(item.id)) this.issue(`${ip}.id`, `duplicate choice id "${item.id}".`, panel, 'duplicate-id'); ids.add(item.id); }
      this.str(item.label, `${ip}.label`, 256, false, panel);
      this.str(item.description, `${ip}.description`, 4096, true, panel);
      for (const key of ['role', 'icon', 'meta']) this.str(item[key], `${ip}.${key}`, 256, true, panel);
      for (const key of ['selected', 'confirmed', 'disabled']) this.bool(item[key], `${ip}.${key}`, panel);
      this.action(item.action, `${ip}.action`, true, panel);
    }
  }
}

/** Decode CSS escapes before applying the capability policy, including escaped keywords. */
function normalizedCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f])/giu,
    (_match, hex: string | undefined, literal: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : literal ?? '').toLowerCase();
}

/** Skin CSS styles the clipped component interior and has no host or network capabilities. */
export function validateGameUiCss(css: string): void {
  const issues: GameUiIssue[] = [];
  if (typeof css !== 'string' || encoder.encode(css).length > MAX_CSS_BYTES) throw new GameUiLayoutError([{ code: 'css-budget', message: `theme.css must be a string of at most ${MAX_CSS_BYTES} UTF-8 bytes.` }]);
  const normalized = normalizedCss(css);
  const reject = (code: string, message: string) => issues.push({ code, message: `theme.css: ${message}` });
  if (/:host(?:\b|\s|\()|::(?:slotted|part)\s*\(|:root\b|(?:^|[{},])\s*(?:html|body)\b/u.test(normalized)) reject('css-host-selector', 'host selectors are reserved by the engine; style .ui-panel or component classes inside the panel.');
  if (/@(?:import|namespace|font-face|document|page|charset)\b|\b(?:url|src|image)\s*\(|(?:-webkit-)?image-set\s*\(/u.test(normalized)) reject('css-external-resource', 'external resources and imports are unavailable; use text glyphs, colors, gradients and engine assets.');
  if (/expression\s*\(|(?:javascript|vbscript|progid)\s*:|(?:^|[;{])\s*(?:behavior|-moz-binding)\s*:/u.test(normalized)) reject('css-executable', 'executable CSS is unavailable; use ordinary component styling.');
  for (const match of normalized.matchAll(/(?:^|[;{])\s*position\s*:\s*([^;}]+)/gu)) {
    if (!/^(?:static|relative|absolute)\s*(?:!\s*important)?\s*$/u.test(match[1]!)) {
      reject('css-host-geometry', 'position must be static, relative or absolute inside the clipped panel; use the panel region API for host placement.');
      break;
    }
  }
  if (/[\u0000\u0001-\u0008\u000b\u000e-\u001f]/u.test(css)) reject('css-invalid', 'control characters are not allowed.');
  if (issues.length) throw new GameUiLayoutError(issues);
}

/** Validate the serializable contract and resolve explicit panel replacement chains. */
export function validateGameUi(value: unknown): GameUiDocument {
  const v = new Validation();
  let json: string;
  try { json = JSON.stringify(value); } catch { throw new GameUiLayoutError([{ code: 'invalid-document', message: 'UI must contain only serializable JSON data without cycles.' }]); }
  if (typeof json !== 'string' || encoder.encode(json).length > MAX_JSON_BYTES) throw new GameUiLayoutError([{ code: 'document-budget', message: `UI document exceeds ${MAX_JSON_BYTES} UTF-8 bytes; shorten text or page the content.` }]);
  // Optional object fields may be undefined in typed authoring helpers; the wire omits them.
  // Other values which JSON would silently coerce or drop remain contract errors.
  const seen = new Set<object>();
  const serializable = (input: unknown, path: string, depth: number): void => {
    if (depth > 40) { v.issue(path, 'JSON nesting exceeds the document limit.'); return; }
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return;
    if (typeof input === 'number') { if (!Number.isFinite(input)) v.issue(path, 'non-finite numbers are not serializable UI values.'); return; }
    if (typeof input !== 'object' || input === undefined) { v.issue(path, 'expected JSON data; functions, undefined and symbols are unavailable.'); return; }
    if (seen.has(input)) { v.issue(path, 'cyclic or shared object references are unavailable; use JSON data.'); return; }
    seen.add(input);
    const proto = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && proto !== Object.prototype && proto !== null) v.issue(path, 'expected a plain JSON object.');
    for (const [key, child] of Object.entries(input)) {
      if (child === undefined && !Array.isArray(input)) continue;
      serializable(child, `${path}.${key}`, depth + 1);
    }
    seen.delete(input);
  };
  serializable(value, 'ui', 0);
  value = JSON.parse(json) as unknown;
  if (!object(value)) throw new GameUiLayoutError([{ code: 'invalid-document', message: 'UI must be a version 1 document object.' }]);
  v.keys(value, ['version', 'panels', 'theme', 'actions', 'defaults', 'scene'], 'ui');
  if (value.version !== 1) v.issue('ui.version', 'expected version:1.');
  if(value.scene!==undefined){
    if(!object(value.scene))v.issue('ui.scene','expected a scene id and sequence.');
    else {v.keys(value.scene,['id','sequence'],'ui.scene');v.id(value.scene.id,'ui.scene.id');v.num(value.scene.sequence,'ui.scene.sequence',1,4294967295,false,true);}
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions) || value.actions.length > 128) v.issue('ui.actions', 'expected an array of at most 128 declared intents.');
    else for (let i = 0; i < value.actions.length; i++) {
      const action = value.actions[i]; const path = `ui.actions[${i}]`;
      if (!object(action)) { v.issue(path, 'expected an action declaration.'); continue; }
      v.keys(action, ['name', 'label'], path);
      if (v.id(action.name, `${path}.name`)) { if (v.actionNames.has(action.name)) v.issue(`${path}.name`, `duplicate declared action "${action.name}".`, undefined, 'duplicate-action'); v.actionNames.add(action.name); }
      v.str(action.label, `${path}.label`);
    }
  }
  if (value.defaults !== undefined) {
    if (!object(value.defaults)) v.issue('ui.defaults', 'expected default visibility flags.');
    else { v.keys(value.defaults, ['health', 'timer', 'status', 'info', 'crosshair'], 'ui.defaults'); for (const key of Object.keys(value.defaults)) v.bool(value.defaults[key], `ui.defaults.${key}`); }
  }
  if (value.theme !== undefined) {
    if (!object(value.theme)) v.issue('ui.theme', 'expected a theme object.');
    else {
      v.keys(value.theme, ['id', 'tokens', 'css'], 'ui.theme'); v.id(value.theme.id, 'ui.theme.id', true);
      if (value.theme.css !== undefined) {
        if (typeof value.theme.css !== 'string') v.issue('ui.theme.css', 'expected component CSS text.');
        else try { validateGameUiCss(value.theme.css); } catch (error) { if (error instanceof GameUiLayoutError) v.issues.push(...error.issues); else throw error; }
      }
      if (value.theme.tokens !== undefined) {
        if (!object(value.theme.tokens) || Object.keys(value.theme.tokens).length > 64) v.issue('ui.theme.tokens', 'expected at most 64 --ui-* custom properties.');
        else for (const [key, token] of Object.entries(value.theme.tokens)) {
          if (!/^--ui-[a-z0-9-]{1,64}$/u.test(key)) v.issue(`ui.theme.tokens.${key}`, 'token names must start with --ui- and contain lowercase letters, numbers or hyphens.');
          if (v.str(token, `ui.theme.tokens.${key}`, 512)) {
            if (/[;{}]/u.test(token)) v.issue(`ui.theme.tokens.${key}`, 'tokens must be individual CSS values without declarations or rules.');
            try { validateGameUiCss(`.ui-panel{${key}:${token}}`); } catch (error) { if (error instanceof GameUiLayoutError) v.issues.push(...error.issues); else throw error; }
          }
        }
      }
    }
  }
  const panelIds = new Set<string>();
  const panelObjects: Obj[] = [];
  if (!Array.isArray(value.panels) || value.panels.length > 32) v.issue('ui.panels', 'expected an array of at most 32 panels.');
  else for (let i = 0; i < value.panels.length; i++) {
    const panel = value.panels[i]; const path = `ui.panels[${i}]`;
    if (!object(panel)) { v.issue(path, 'expected a panel.'); continue; }
    panelObjects.push(panel);
    const id = typeof panel.id === 'string' ? panel.id : path;
    v.keys(panel, ['id', 'role', 'title', 'region', 'presentation', 'width', 'height', 'priority', 'visible', 'onDismiss', 'children', 'replaces'], path, id);
    if (v.id(panel.id, `${path}.id`, false, id)) { if (panelIds.has(panel.id)) v.issue(`${path}.id`, `duplicate panel id "${panel.id}"; assign a unique stable id.`, id, 'duplicate-id'); panelIds.add(panel.id); }
    v.one(panel.role, roles, `${path}.role`, false, id); v.str(panel.title, `${path}.title`, 256, true, id);
    v.one(panel.region, [...regions, 'auto'], `${path}.region`, true, id); v.one(panel.presentation, ['hud', 'modal'], `${path}.presentation`, true, id);
    v.num(panel.width, `${path}.width`, 1, 8192, true, false, id); v.num(panel.height, `${path}.height`, 1, 8192, true, false, id);
    v.num(panel.priority, `${path}.priority`, -1e6, 1e6, true, false, id); v.bool(panel.visible, `${path}.visible`, id);
    v.action(panel.onDismiss, `${path}.onDismiss`, true, id); v.id(panel.replaces, `${path}.replaces`, true, id);
    const before = v.crosshairs; v.children(panel.children, `${path}.children`, 1, id);
    if (v.crosshairs > before && panel.role !== 'crosshair') v.issue(path, 'crosshair nodes belong in a crosshair-role panel so the engine can reserve the aim region.', id, 'crosshair-role');
    if (panel.role === 'crosshair') {
      if (v.crosshairs - before !== 1 || !Array.isArray(panel.children) || panel.children.length !== 1 || !object(panel.children[0]) || panel.children[0].kind !== 'crosshair') v.issue(path, 'a crosshair panel must contain exactly one crosshair node and no other content.', id, 'crosshair-role');
      if (panel.presentation === 'modal' || (panel.region !== undefined && panel.region !== 'auto' && panel.region !== 'center')) v.issue(path, 'a crosshair is a center HUD panel; remove modal presentation or an off-center region.', id, 'crosshair-role');
    }
  }
  const replaced = new Map<string, string>();
  for (const panel of panelObjects) if (typeof panel.replaces === 'string') {
    const id = String(panel.id); const target = panel.replaces;
    if (!panelIds.has(target)) v.issue(`panel "${id}".replaces`, `target "${target}" does not exist; use its exact panel id.`, id, 'missing-replacement');
    if (replaced.has(target)) v.issue(`panel "${id}".replaces`, `target "${target}" is already replaced by "${replaced.get(target)}"; select one replacement.`, id, 'replacement-conflict');
    replaced.set(target, id);
  }
  for (const panel of panelObjects) {
    let current = String(panel.id); const chain = new Set<string>();
    while (replaced.has(current)) {
      if (chain.has(current)) { v.issue(`panel "${String(panel.id)}".replaces`, 'replacement cycle; replacements must end at one surviving panel.', String(panel.id), 'replacement-cycle'); break; }
      chain.add(current); current = replaced.get(current)!;
    }
  }
  const active = panelObjects.filter(panel => !replaced.has(String(panel.id)));
  const exclusive = new Map<string, string>();
  let crosshairCount = 0;
  for (const panel of active) {
    if (panel.visible === false) continue;
    if (panel.role === 'crosshair') crosshairCount++;
    if (panel.presentation === 'modal' || panel.role === 'custom') continue;
    const role = String(panel.role); const id = String(panel.id); const previous = exclusive.get(role);
    if (previous) v.issue(`panel "${id}"`, `HUD role "${role}" is already owned by "${previous}"; declare replaces:"${previous}", use a custom role, or hide one panel.`, id, 'exclusive-role');
    else exclusive.set(role, id);
  }
  if (crosshairCount > 1) v.issue('ui.panels', 'only one visible crosshair panel is allowed; replace or hide the other crosshair.', undefined, 'exclusive-crosshair');
  if (v.issues.length) throw new GameUiLayoutError(v.issues);
  const result = JSON.parse(json) as GameUiDocument;
  result.panels = result.panels.filter(panel => !replaced.has(panel.id));
  // The composed document is valid on a second pass too: resolved targets no longer exist.
  for (const panel of result.panels) delete panel.replaces;
  return result;
}

function overlaps(a: GameUiRect, b: GameUiRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
function contains(bounds: GameUiRect, rect: GameUiRect): boolean {
  return rect.x >= bounds.x && rect.y >= bounds.y && rect.x + rect.width <= bounds.x + bounds.width + 0.001 && rect.y + rect.height <= bounds.y + bounds.height + 0.001;
}
function viewportBounds(viewport: GameUiViewport): GameUiRect {
  const issues: GameUiIssue[] = [];
  if (![viewport.width, viewport.height].every(n => Number.isFinite(n) && n > 0 && n <= 32768)) issues.push({ code: 'invalid-viewport', message: 'Viewport width and height must be finite positive numbers at most 32768.' });
  const area = viewport.safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 };
  if (![area.top, area.right, area.bottom, area.left].every(n => Number.isFinite(n) && n >= 0)) issues.push({ code: 'invalid-safe-area', message: 'All four safe-area insets must be finite nonnegative numbers.' });
  const bounds = { x: area.left, y: area.top, width: viewport.width - area.left - area.right, height: viewport.height - area.top - area.bottom };
  if (bounds.width < 44 || bounds.height < 44) issues.push({ code: 'insufficient-viewport', message: 'The safe viewport must be at least 44×44 pixels; enlarge the viewport or reduce the safe-area insets.' });
  if (issues.length) throw new GameUiLayoutError(issues);
  return bounds;
}

/** Both bottom corners are reserved for touch movement/look controls for either handedness. */
function reservations(viewport: GameUiViewport, bounds: GameUiRect): GameUiReservation[] {
  if (viewport.reservations !== undefined && (!Array.isArray(viewport.reservations) || viewport.reservations.length > 64)) {
    throw new GameUiLayoutError([{ code: 'invalid-reservation', message: 'Viewport reservations must be an array of at most 64 host/control rectangles.' }]);
  }
  const result = [...(viewport.reservations ?? [])];
  const issues: GameUiIssue[] = [];
  const ids = new Set<string>();
  for (const rect of result) {
    if (!rect.id || ids.has(rect.id) || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) issues.push({ code: 'invalid-reservation', message: `Reservation "${rect.id}" needs a unique id and finite coordinates with positive dimensions.` });
    ids.add(rect.id);
  }
  if (issues.length) throw new GameUiLayoutError(issues);
  if (viewport.touch) {
    const width = Math.min(140, Math.max(44, bounds.width * 0.3));
    const height = Math.min(144, Math.max(44, bounds.height * 0.24));
    result.push({ id: 'engine:touch-left', role: 'touch', x: bounds.x, y: bounds.y + bounds.height - height, width, height });
    result.push({ id: 'engine:touch-right', role: 'touch', x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height, width, height });
  }
  return result;
}

function aimRect(viewport: GameUiViewport): GameUiReservation {
  const size = Math.min(64, viewport.width, viewport.height);
  return { id: 'engine:aim', role: 'crosshair', x: (viewport.width - size) / 2, y: (viewport.height - size) / 2, width: size, height: size };
}

function anchor(region: GameUiRegion, width: number, height: number, bounds: GameUiRect): GameUiRect {
  const x = region.endsWith('left') ? bounds.x : region.endsWith('right') ? bounds.x + bounds.width - width : bounds.x + (bounds.width - width) / 2;
  const y = region.startsWith('top') ? bounds.y : region.startsWith('bottom') ? bounds.y + bounds.height - height : bounds.y + (bounds.height - height) / 2;
  return { x, y, width, height };
}

function desiredRegion(panel: GameUiPanel, viewport: GameUiViewport): GameUiRegion {
  return panel.region && panel.region !== 'auto' ? panel.region : panel.role === 'chat' && viewport.touch ? 'top-left' : semanticRegions[panel.role];
}

function panelSize(panel: GameUiPanel, bounds: GameUiRect, compact = false): readonly [number, number] {
  const crosshair = panel.role === 'crosshair' && panel.children[0]?.kind === 'crosshair' ? panel.children[0] : undefined;
  const [width, height] = crosshair ? [crosshair.size ?? 32, crosshair.size ?? 32] : defaultSizes[panel.role];
  const [minimumWidth, minimumHeight] = panel.presentation === 'modal' ? [44, 44] : hudMinimumSizes[panel.role] ?? [44, 44];
  // Narrow HUDs reflow inside their own scroll container. Never shrink interactive targets.
  const preferredWidth = panel.width ?? (compact ? Math.min(width, Math.max(96, bounds.width * 0.45)) : width);
  const preferredHeight = panel.height ?? (compact ? Math.max(44, Math.min(height, panel.role === 'chat' ? 88 : 64)) : height);
  return [Math.min(bounds.width, Math.max(minimumWidth, preferredWidth)), Math.min(bounds.height, Math.max(minimumHeight, preferredHeight))];
}

function conflictIssue(panel: string, rect: GameUiRect, conflict: GameUiReservation | GameUiPlacement | undefined, explicit: boolean): GameUiIssue {
  const target = conflict?.id ?? 'safe viewport';
  return { code: explicit ? 'requested-region-conflict' : 'hud-overflow', panel, conflictsWith: target, rect,
    message: `Panel "${panel}" ${explicit ? 'requests a region overlapping' : 'cannot fit without overlapping'} "${target}". ${explicit ? 'Use region:"auto", another region, smaller dimensions, or explicit replaces for the same HUD role.' : 'Reduce panel dimensions/content, hide a lower-priority HUD panel, or move the content into a modal.'}` };
}

/** Keep the largest usable modal lane clear of trusted host controls. Candidate
 * splitting is bounded even when a caller supplies many scattered reservations. */
function modalBounds(bounds: GameUiRect, host: readonly GameUiReservation[], panel: string): GameUiRect {
  let candidates: GameUiRect[] = [bounds];
  const compare = (a: GameUiRect, b: GameUiRect): number => b.width * b.height - a.width * a.height || a.y - b.y || a.x - b.x || b.width - a.width;
  const blockers = host.filter(rect => rect.role === 'host').sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id, 'en'));
  for (const blocker of blockers) {
    const padded = { x: blocker.x - 4, y: blocker.y - 4, width: blocker.width + 8, height: blocker.height + 8 };
    const next: GameUiRect[] = [];
    const add = (rect: GameUiRect) => { if (rect.width >= 44 && rect.height >= 44) next.push(rect); };
    for (const candidate of candidates) {
      if (!overlaps(candidate, padded)) { next.push(candidate); continue; }
      const right = candidate.x + candidate.width, bottom = candidate.y + candidate.height;
      add({ x: candidate.x, y: candidate.y, width: candidate.width, height: Math.min(bottom, padded.y) - candidate.y });
      add({ x: candidate.x, y: Math.max(candidate.y, padded.y + padded.height), width: candidate.width, height: bottom - Math.max(candidate.y, padded.y + padded.height) });
      add({ x: candidate.x, y: candidate.y, width: Math.min(right, padded.x) - candidate.x, height: candidate.height });
      add({ x: Math.max(candidate.x, padded.x + padded.width), y: candidate.y, width: right - Math.max(candidate.x, padded.x + padded.width), height: candidate.height });
    }
    // Larger containing candidates supersede smaller ones. Retain at most 64
    // free rectangles per split, keeping candidate growth bounded.
    const retained: GameUiRect[] = [];
    for (const candidate of next.sort(compare)) {
      if (!retained.some(rect => contains(rect, candidate))) retained.push(candidate);
      if (retained.length === 64) break;
    }
    candidates = retained;
    if (!candidates.length) throw new GameUiLayoutError([{ code: 'modal-overflow', panel, conflictsWith: blocker.id, rect: bounds,
      message: `Panel "${panel}" has no 44×44 safe modal area clear of host control "${blocker.id}". Enlarge the viewport or reduce the host reservations.` }]);
  }
  return candidates.sort(compare)[0]!;
}

/** Deterministic collision-free placement, independent of mod/panel array ordering. */
export function layoutGameUi(document: GameUiDocument, viewport: GameUiViewport): GameUiPlacement[] {
  const doc = validateGameUi(document);
  const bounds = viewportBounds(viewport);
  const host = reservations(viewport, bounds);
  const visible = doc.panels.filter(panel => panel.visible !== false);
  const modals = visible.filter(panel => panel.presentation === 'modal');
  if (modals.length) {
    if (modals.length > 1) throw new GameUiLayoutError([{ code: 'modal-conflict', panel: modals[0]!.id, conflictsWith: modals[1]!.id, message: `Modal panels "${modals[0]!.id}" and "${modals[1]!.id}" are both visible. Show one modal at a time or combine their content with tabs.` }]);
    const panel = modals[0]!;
    const safe = modalBounds(bounds, host, panel.id);
    const [width, height] = panelSize(panel, safe);
    return [{ id: panel.id, region: panel.region && panel.region !== 'auto' ? panel.region : 'center', modal: true, ...anchor(panel.region && panel.region !== 'auto' ? panel.region : 'center', width, height, safe) }];
  }
  const aim = aimRect(viewport);
  const placements: GameUiPlacement[] = [];
  const panels = visible.sort((a, b) =>
    Number(b.role === 'crosshair') - Number(a.role === 'crosshair') ||
    Number(Boolean(b.region && b.region !== 'auto')) - Number(Boolean(a.region && a.region !== 'auto')) ||
    (a.priority ?? 0) - (b.priority ?? 0) || a.role.localeCompare(b.role, 'en') || a.id.localeCompare(b.id, 'en'));
  for (const panel of panels) {
    const region = desiredRegion(panel, viewport);
    if (panel.role === 'crosshair') {
      const [width, height] = panelSize(panel, { ...bounds, width: Math.min(bounds.width, 64), height: Math.min(bounds.height, 64) });
      const rect = { x: viewport.width / 2 - width / 2, y: viewport.height / 2 - height / 2, width, height };
      const blocked = host.find(reserved => overlaps(rect, reserved));
      if (!contains(bounds, rect) || blocked) throw new GameUiLayoutError([conflictIssue(panel.id, rect, blocked, true)]);
      placements.push({ id: panel.id, region: 'center', modal: false, ...rect });
      continue;
    }
    const blockers = [...host, aim, ...placements];
    const explicit = Boolean(panel.region && panel.region !== 'auto');
    const compact = bounds.width < 600 || bounds.height < 440;
    const [width, height] = panelSize(panel, bounds, compact);
    const preferred = anchor(region, width, height, bounds);
    const minimum = hudMinimumSizes[panel.role];
    if (minimum && (bounds.width < minimum[0] || bounds.height < minimum[1])) throw new GameUiLayoutError([{
      code: 'hud-overflow', panel: panel.id, rect: preferred,
      message: `Panel "${panel.id}" needs at least ${minimum[0]}×${minimum[1]} pixels for its ${panel.role} content. Enlarge the safe viewport, hide the panel, or move it into a modal.`,
    }]);
    if (explicit) {
      const blocked = blockers.find(reserved => overlaps(preferred, reserved, 4));
      if (region === 'center' || blocked) throw new GameUiLayoutError([conflictIssue(panel.id, preferred, blocked ?? aim, true)]);
      placements.push({ id: panel.id, region, modal: false, ...preferred });
      continue;
    }
    const sizes: (readonly [number, number])[] = [[width, height]];
    // Standard HUD components have known scroll/reflow minima. Custom content retains its requested box.
    if (compact && minimum) {
      sizes.push([Math.min(width, Math.max(minimum[0], bounds.width * 0.45)), Math.min(height, Math.max(minimum[1], defaultSizes[panel.role][1]))]);
      sizes.push(minimum);
    }
    let rect: GameUiRect | undefined;
    for (const [candidateWidth, candidateHeight] of sizes) {
      // Candidate edges include every occupied edge, so adding panels can create new lanes.
      const target = anchor(region, candidateWidth, candidateHeight, bounds);
      const xs = new Set([bounds.x, bounds.x + bounds.width - candidateWidth, bounds.x + (bounds.width - candidateWidth) / 2]);
      const ys = new Set([bounds.y, bounds.y + bounds.height - candidateHeight, bounds.y + (bounds.height - candidateHeight) / 2]);
      for (const blocker of blockers) {
        xs.add(blocker.x - candidateWidth - 4); xs.add(blocker.x + blocker.width + 4);
        ys.add(blocker.y - candidateHeight - 4); ys.add(blocker.y + blocker.height + 4);
      }
      const candidates: GameUiRect[] = [];
      for (const x of xs) for (const y of ys) {
        const candidate = { x, y, width: candidateWidth, height: candidateHeight };
        if (contains(bounds, candidate) && !blockers.some(blocker => overlaps(candidate, blocker, 4))) candidates.push(candidate);
      }
      // Prefer the semantic anchor, then the nearest available edge; tie breaks are explicit.
      candidates.sort((a, b) => (Math.abs(a.x - target.x) + Math.abs(a.y - target.y)) - (Math.abs(b.x - target.x) + Math.abs(b.y - target.y)) || a.y - b.y || a.x - b.x);
      rect = candidates[0];
      if (rect) break;
    }
    if (!rect) throw new GameUiLayoutError([conflictIssue(panel.id, preferred, blockers.find(blocker => overlaps(preferred, blocker, 4)), false)]);
    placements.push({ id: panel.id, region, modal: false, ...rect });
  }
  return placements;
}

/** Check browser-measured panel rectangles against the same engine-owned reservations. */
export function inspectGameUiLayout(placements: readonly GameUiPlacement[], viewport: GameUiViewport): GameUiIssue[] {
  const bounds = viewportBounds(viewport);
  const host = reservations(viewport, bounds);
  const aim = aimRect(viewport);
  const issues: GameUiIssue[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < placements.length; i++) {
    const panel = placements[i]!;
    if (ids.has(panel.id)) issues.push({ code: 'duplicate-id', panel: panel.id, message: `Measured panel id "${panel.id}" is duplicated.` });
    ids.add(panel.id);
    if (![panel.x, panel.y, panel.width, panel.height].every(Number.isFinite) || panel.width <= 0 || panel.height <= 0 || !contains(bounds, panel)) issues.push({ code: 'panel-clipping', panel: panel.id, rect: panel, message: `Panel "${panel.id}" extends outside the safe viewport; clamp its dimensions and scroll its contents internally.` });
    for (const blocker of host) if ((!panel.modal || blocker.role === 'host') && overlaps(panel, blocker)) issues.push(conflictIssue(panel.id, panel, blocker, true));
    if (panel.modal) continue;
    if (panel.region !== 'center' && overlaps(panel, aim)) issues.push(conflictIssue(panel.id, panel, aim, true));
    for (let j = 0; j < i; j++) if (!placements[j]!.modal && overlaps(panel, placements[j]!)) issues.push(conflictIssue(panel.id, panel, placements[j]!, true));
  }
  return issues;
}
