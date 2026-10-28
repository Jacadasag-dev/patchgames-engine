import { GameUiLayoutError } from './gameUi.ts';
import type { GameUiDocument, GameUiNode, GameUiTheme } from './gameUi.ts';
import { validateGameUi } from './gameUiLayout.ts';

export interface GameUiMod {
  version: 1;
  name?: string;
  theme?: GameUiTheme;
  crosshair?: Partial<Pick<Extract<GameUiNode, { kind: 'crosshair' }>, 'shape' | 'color' | 'size' | 'gap' | 'thickness' | 'outline'>>;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const reject = (message: string): never => { throw new GameUiLayoutError([{ code: 'invalid-ui-mod', message }]); };
const reticleRelations = (value: GameUiMod['crosshair']): void => {
  if (!value) return;
  const size = value.size ?? 20, thickness = value.thickness ?? 2, gap = value.gap ?? 4;
  if (thickness > size) reject('Appearance crosshair thickness must not exceed its size.');
  if (value.shape === 'ticks' && gap >= size) reject('Appearance crosshair ticks need a gap smaller than their size.');
};

/** Player-local presentation only. The existing UI contract owns CSS and reticle bounds. */
export function validateGameUiMod(value: unknown): GameUiMod {
  if (!object(value) || value.version !== 1) return reject('Appearance package must be a version:1 object.');
  for (const key of Object.keys(value)) if (!['version', 'name', 'theme', 'crosshair'].includes(key)) reject(`Appearance package.${key} is unavailable; packages contain theme and crosshair presentation only.`);
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 96 || /[\u0000-\u001f]/u.test(value.name))) reject('Appearance package.name must be 1–96 characters without control characters.');
  if (value.crosshair !== undefined) {
    if (!object(value.crosshair)) reject('Appearance package.crosshair must be an object.');
    for (const key of Object.keys(value.crosshair as Record<string, unknown>)) if (!['shape', 'color', 'size', 'gap', 'thickness', 'outline'].includes(key)) reject(`Appearance package.crosshair.${key} is unavailable; visibility, actions and placement belong to the game.`);
  }
  const checked = validateGameUi({ version: 1, ...(value.theme !== undefined ? { theme: value.theme } : {}), panels: value.crosshair === undefined ? [] : [{ id: 'appearance:reticle', role: 'crosshair', children: [{ kind: 'crosshair', ...(value.crosshair as object) }] }] });
  const reticle = checked.panels[0]?.children[0];
  const crosshair = reticle?.kind === 'crosshair' ? (({ kind: _kind, ...fields }) => fields)(reticle) : undefined;
  reticleRelations(crosshair);
  return { version: 1, ...(value.name !== undefined ? { name: value.name as string } : {}), ...(checked.theme ? { theme: checked.theme } : {}), ...(crosshair ? { crosshair } : {}) };
}

/** Merge a validated package without creating UI or changing gameplay values or intents. */
export function applyGameUiMod(document: GameUiDocument, value: GameUiMod | null): GameUiDocument {
  if (value === null) return document;
  const mod = validateGameUiMod(value);
  validateGameUi(document);
  const result = JSON.parse(JSON.stringify(document)) as GameUiDocument;
  if (mod.theme) {
    const css = [result.theme?.css, mod.theme.css].filter(value => value !== undefined && value !== '').join('\n');
    const tokens = { ...result.theme?.tokens, ...mod.theme.tokens };
    result.theme = { ...result.theme, ...mod.theme, ...(Object.keys(tokens).length ? { tokens } : {}), ...(css ? { css } : {}) };
  }
  const modal = result.panels.some(panel => panel.visible !== false && panel.presentation === 'modal');
  if (mod.crosshair && !modal) for (const panel of result.panels) {
    if (panel.visible === false) continue;
    let changed = false;
    const visit = (nodes: GameUiNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'crosshair') { Object.assign(node, mod.crosshair); reticleRelations(node); changed = true; }
        if (node.kind === 'row' || node.kind === 'stack') visit(node.children);
        if (node.kind === 'tabs') { const active = node.tabs.find(tab => tab.id === node.selected) ?? node.tabs[0]; if (active) visit(active.children); }
      }
    };
    visit(panel.children);
    // Reticle growth stays inside the engine's bounded, centered aim reservation.
    if (changed && panel.role === 'crosshair' && mod.crosshair.size !== undefined) panel.width = panel.height = Math.max(32, mod.crosshair.size);
  }
  // This also checks the combined authored + local CSS budget and final reticle geometry.
  validateGameUi(result);
  return result;
}
