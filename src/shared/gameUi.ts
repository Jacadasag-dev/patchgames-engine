/** Versioned, serializable game UI. The engine creates HTML/CSS; authored code never receives DOM access. */
export type GameUiRegion = 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'center';
export type GameUiRole = 'health' | 'status' | 'objective' | 'minimap' | 'ammo' | 'hotbar' | 'chat'
  | 'inventory' | 'loot' | 'store' | 'selection' | 'crosshair' | 'custom';
export type GameUiPreset = 'voxel' | 'spatial-pack' | 'mmo-bags' | 'survival' | 'compact-loot'
  | 'shop' | 'rpg-classes' | 'agent-select' | 'champion-draft';

/** An intent, never a state mutation. Map this to ordinary checked gameplay input in writeInput. */
export interface GameUiAction {
  /** A declared game intent. host:chooseClass selects a catalogued host class via item during waiting/ended. */
  name: string;
  value?: number;
  item?: string;
  source?: string;
  target?: string;
  index?: number;
  /** Reserved scene intents carry their original authoritative instance. */
  sceneSequence?: number;
  x?: number;
  y?: number;
  rotated?: boolean;
}
export interface GameUiEvent extends GameUiAction { panel: string }

export interface GameUiItem {
  id: string;
  label: string;
  /** Text glyph, not HTML or a URL. Skins may style [data-item] and its stable semantic parts. */
  icon?: string;
  description?: string;
  count?: number;
  selected?: boolean;
  disabled?: boolean;
  rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  /** Logical slot index; spatial containers instead use x/y and cell width/height. */
  slot?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotated?: boolean;
  meta?: string;
  action?: GameUiAction;
}
export interface GameUiChoice {
  id: string;
  label: string;
  description?: string;
  role?: string;
  icon?: string;
  meta?: string;
  selected?: boolean;
  confirmed?: boolean;
  disabled?: boolean;
  action?: GameUiAction;
}
interface GameUiNodeBase { id?: string; className?: string }
export type GameUiNode =
  | (GameUiNodeBase & { kind: 'text'; text: string; tone?: 'muted' | 'accent' | 'danger' | 'success'; heading?: boolean })
  | (GameUiNodeBase & { kind: 'row' | 'stack'; children: GameUiNode[]; label?: string })
  | (GameUiNodeBase & { kind: 'bar'; label: string; value: number; max: number; tone?: 'health' | 'armor' | 'energy' })
  | (GameUiNodeBase & { kind: 'button'; label: string; action: GameUiAction; disabled?: boolean; primary?: boolean })
  | (GameUiNodeBase & { kind: 'grid'; id: string; label: string; columns: number; rows: number; items: GameUiItem[];
      spatial?: boolean; flow?: 'reflow' | 'scroll'; action?: GameUiAction; moveAction?: GameUiAction; selected?: string })
  | (GameUiNodeBase & { kind: 'choices'; label: string; items: GameUiChoice[]; columns?: number;
      variant?: 'cards' | 'portraits' | 'roster'; action?: GameUiAction; searchable?: boolean })
  | (GameUiNodeBase & { kind: 'tabs'; label: string; tabs: { id: string; label: string; children: GameUiNode[] }[]; selected?: string })
  | (GameUiNodeBase & { kind: 'crosshair'; shape?: 'dot' | 'plus' | 'ring' | 'ticks'; color?: string;
      size?: number; gap?: number; thickness?: number; outline?: boolean });

export interface GameUiPanel {
  /** Stable across frames and mod ordering; diagnostics and skins identify this panel by id. */
  id: string;
  role: GameUiRole;
  title?: string;
  /** Auto uses semantic defaults and collision-free fallback. Explicit regions produce errors on conflict. */
  region?: GameUiRegion | 'auto';
  /** HUD panels share reserved lanes; modal panels replace the game HUD and pause local gameplay input. */
  presentation?: 'hud' | 'modal';
  width?: number;
  height?: number;
  /** Smaller priority numbers reserve space first. Role and id provide stable tie-breaking. */
  priority?: number;
  visible?: boolean;
  onDismiss?: GameUiAction;
  children: GameUiNode[];
  /** Explicit target replacement for a reskin/mod. An absent target is a composition error. */
  replaces?: string;
}
export interface GameUiTheme {
  id?: string;
  /** CSS custom properties, e.g. {'--ui-accent':'#7cf2c4','--ui-radius':'4px'}. */
  tokens?: Record<string, string>;
  /** Ordinary component CSS, scoped inside each panel's shadow root. Cannot style host geometry or fetch resources. */
  css?: string;
}
export interface GameUiDocument {
  version: 1;
  /** Optional authoritative scene scope. Blocked scenes reject UI from another id or sequence. */
  scene?: {id:string;sequence:number};
  panels: GameUiPanel[];
  theme?: GameUiTheme;
  /** Declared intent names; renderers reject undeclared button/transfer actions. */
  actions?: { name: string; label: string }[];
  /** Health is engine-owned. Override its appearance/placement with a health-role panel; never forge its authority. */
  defaults?: { health?: boolean; timer?: boolean; status?: boolean; info?: boolean; crosshair?: boolean };
}
export interface GameUiRect { x: number; y: number; width: number; height: number }
export interface GameUiReservation extends GameUiRect { id: string; role?: GameUiRole | 'touch' | 'host'; region?: GameUiRegion }
export interface GameUiViewport {
  width: number;
  height: number;
  touch?: boolean;
  leftHanded?: boolean;
  safeArea?: { top: number; right: number; bottom: number; left: number };
  reservations?: GameUiReservation[];
}
export interface GameUiPlacement extends GameUiRect { id: string; region: GameUiRegion; modal: boolean }
export interface GameUiIssue {
  code: string;
  message: string;
  panel?: string;
  conflictsWith?: string;
  rect?: GameUiRect;
}
export class GameUiLayoutError extends Error {
  readonly issues: readonly GameUiIssue[];
  constructor(issues: readonly GameUiIssue[]) {
    super(issues.map(issue => issue.message).join('\n'));
    this.name = 'GameUiLayoutError';
    this.issues = issues;
  }
}
