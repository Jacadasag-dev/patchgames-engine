import type { GameUiAction, GameUiDocument, GameUiEvent, GameUiIssue, GameUiItem, GameUiNode, GameUiPanel, GameUiPlacement, GameUiViewport } from '../../shared/gameUi.ts';
import { GameUiLayoutError } from '../../shared/gameUi.ts';
import { layoutGameUi, validateGameUi } from '../../shared/gameUiLayout.ts';
import { gameUiCss } from './gameUiStyle.ts';

export interface GameUiHostOptions {
  container?: HTMLElement;
  onAction: (event: GameUiEvent) => void;
  onBlockingChange?: (blocking: boolean) => void;
  onDiagnostics?: (issues: readonly GameUiIssue[]) => void;
  /** Explicit trusted host controls which stay available beside a game modal. */
  hostFocusTargets?:()=>readonly HTMLElement[];
}
type Selection = { item: GameUiItem; source: string; move?: GameUiAction; rotated: boolean };
type GridRuntime = { node: Extract<GameUiNode, { kind: 'grid' }>; grid: HTMLElement; scroll: HTMLElement; cells: HTMLButtonElement[]; visualColumns: number };
type FocusSnapshot = { panel: string; key: string; index: number };
type PanelEntry = { host: HTMLElement; shadow: ShadowRoot; panel: GameUiPanel; signature: string; shell: string };
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag); element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** Engine-owned HTML. Every action is an intent; this class never changes gameplay state. */
export class GameUiHost {
  readonly root: HTMLDivElement;
  private readonly options: GameUiHostOptions;
  private current: GameUiDocument | null = null;
  private signature = '';
  private isSuspended = false;
  private isBlocking = false;
  private issues: readonly GameUiIssue[] = [];
  private readonly panels = new Map<string, PanelEntry>();
  private readonly nodeElements = new Map<string, Map<string, HTMLElement>>();
  private readonly tabs = new Map<string, string>();
  private readonly searches = new Map<string, string>();
  private readonly selections = new Map<string, Selection>();
  private previousFocus: HTMLElement | null = null;
  private escapeAt = 0;
  private placed: readonly GameUiPlacement[] = [];
  private readonly hostPanels = new Map<string, { element: HTMLElement; css: string }>();
  private hostRevision = 0;
  private requestedModal = false;
  private measureTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMeasurement = -Infinity;
  private measureKey = '';
  private touchViewport = false;
  private layoutIssues: readonly GameUiIssue[] = [];
  private measuredIssues: readonly GameUiIssue[] = [];
  private readonly invalidPanels = new Set<string>();
  private readonly observers = new Map<string, MutationObserver>();
  private disposed = false;
  private readonly grids = new Map<string, GridRuntime[]>();

  constructor(options: GameUiHostOptions) {
    this.options = options;
    this.root = make('div', 'game-ui-host'); this.root.dataset.gameUiHost = '';
    this.root.dataset.gameUiBlocking = 'false';
    Object.assign(this.root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '11' });
    (options.container ?? document.body).append(this.root);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    document.addEventListener('pointerdown', this.outsidePointer, true);
  }
  get blocking(): boolean { return this.isBlocking; }
  get diagnostics(): readonly GameUiIssue[] { return this.issues; }
  get placements(): readonly GameUiPlacement[] { return this.placed; }
  get focused(): boolean { return !this.isSuspended && [...this.panels.values()].some(entry => !entry.host.hidden && !!entry.shadow.activeElement); }
  attachHostPanel(id: string, element: HTMLElement, css = ''): () => void {
    element.remove(); this.hostPanels.set(id, { element, css }); this.signature = ''; this.hostRevision++;
    return () => { if (this.hostPanels.get(id)?.element === element) { this.hostPanels.delete(id); this.signature = ''; this.hostRevision++; element.remove(); } };
  }
  dismissTop(): boolean {
    if (this.isSuspended) return false;
    if (this.selections.size) {
      this.selections.clear();
      for (const entry of this.panels.values()) entry.shadow.querySelectorAll('[data-picked]').forEach(element => element.removeAttribute('data-picked'));
      return true;
    }
    const panel = [...this.panels.values()].reverse().find(entry => entry.panel.presentation === 'modal' && !entry.host.hidden)?.panel;
    if (!panel?.onDismiss) return false;
    this.emit(panel, panel.onDismiss); return true;
  }
  suspend(value: boolean): void {
    this.isSuspended = value; this.root.hidden = value;
    this.setBlocking(!value && this.requestedModal); if (!value) this.scheduleMeasurement();
  }
  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.keyDown); window.removeEventListener('keyup', this.keyUp);
    document.removeEventListener('pointerdown', this.outsidePointer, true);
    clearTimeout(this.measureTimer); this.observers.forEach(observer => observer.disconnect()); this.observers.clear();
    this.panels.clear(); this.nodeElements.clear(); this.grids.clear(); this.root.remove(); this.setBlocking(false);
  }
  /** Inspect actual rendered hit targets after CSS, scrolling and host content have laid out. */
  measureLayout(): GameUiIssue[] {
    if (this.disposed || this.isSuspended || typeof this.root.getBoundingClientRect !== 'function') return [...this.issues];
    this.reflowGrids();
    const rootRect = this.root.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return [...this.issues];
    type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
    const intersect = (a: Rect, b: Rect): Rect => { const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top), right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom); return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }; };
    const issues: GameUiIssue[] = [];
    const invalid = new Set<string>();
    const addIssue = (issue: GameUiIssue) => { if (issue.panel && issue.code !== 'measurement-limit') invalid.add(issue.panel); if (issues.length < 128) issues.push(issue); };
    const styles = new WeakMap<Element, CSSStyleDeclaration>();
    const style = (element: Element): CSSStyleDeclaration | undefined => {
      if (typeof getComputedStyle !== 'function') return undefined;
      let value = styles.get(element); if (!value) { value = getComputedStyle(element); styles.set(element, value); } return value;
    };
    const rects = new WeakMap<Element, DOMRect>();
    const rect = (element: Element): DOMRect => { let value = rects.get(element); if (!value) { value = element.getBoundingClientRect(); rects.set(element, value); } return value; };
    const identify = (element: HTMLElement): string => element.dataset.slot !== undefined ? `${element.closest<HTMLElement>('[data-grid]')?.dataset.grid ?? 'grid'}/slot:${element.dataset.slot}` : element.dataset.choice ? `choice:${element.dataset.choice}` : element.dataset.action ? `action:${element.dataset.action}` : element.id || element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 48) || element.tagName.toLowerCase();
    const local = (bounds: Rect) => ({ x: bounds.left - rootRect.left, y: bounds.top - rootRect.top, width: bounds.width, height: bounds.height });
    for (const [id, entry] of this.panels) {
      if (entry.host.hidden || typeof entry.host.getBoundingClientRect !== 'function') continue;
      const panelClip = intersect(rect(entry.host), rootRect);
      if (panelClip.width <= 0 || panelClip.height <= 0) continue;
      const inspect = (element: HTMLElement) => {
        const bounds = rect(element); let visible = intersect(bounds, panelClip), hidden = false;
        // Track the possible target origins through the entire clipping chain.
        // Scroll position may put a valid target above/left of its viewport, and
        // an outer scroller may bring a currently off-panel inner scroller back.
        type Reach = { min: number; max: number; possible: boolean };
        const x: Reach = { min: bounds.left, max: bounds.left, possible: true }, y: Reach = { min: bounds.top, max: bounds.top, possible: true };
        const constrain = (reach: Reach, start: number, end: number, size: number) => {
          if (!reach.possible) return;
          reach.min = Math.max(reach.min, start - 1); reach.max = Math.min(reach.max, end - size + 1);
          reach.possible = reach.min <= reach.max;
        };
        const scrollReach = (reach: Reach, position: number, extent: number, rtl = false) => {
          if (!reach.possible || !Number.isFinite(extent) || extent <= 1) return;
          const current = Math.max(rtl ? -extent : 0, Math.min(rtl ? 0 : extent, position || 0));
          reach.min += current - (rtl ? 0 : extent); reach.max += current + (rtl ? extent : 0);
        };
        for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
          const appearance = style(ancestor);
          if (ancestor.hidden || appearance?.display === 'none' || appearance?.visibility === 'hidden' || appearance?.visibility === 'collapse' || appearance?.opacity === '0') hidden = true;
          if (ancestor === element) continue;
          const clip = rect(ancestor), overflowX = appearance?.overflowX ?? 'visible', overflowY = appearance?.overflowY ?? 'visible';
          if (/^(auto|scroll)$/.test(overflowX)) scrollReach(x, ancestor.scrollLeft, ancestor.scrollWidth - ancestor.clientWidth, appearance?.direction === 'rtl');
          if (/^(auto|scroll)$/.test(overflowY)) scrollReach(y, ancestor.scrollTop, ancestor.scrollHeight - ancestor.clientHeight);
          if (overflowX !== 'visible') { const clipped = intersect(visible, { ...visible, left: clip.left, right: clip.right, width: clip.width }); visible = { ...visible, left: clipped.left, right: clipped.right, width: clipped.width }; }
          if (overflowY !== 'visible') { const clipped = intersect(visible, { ...visible, top: clip.top, bottom: clip.bottom, height: clip.height }); visible = { ...visible, top: clipped.top, bottom: clipped.bottom, height: clipped.height }; }
          if (overflowX !== 'visible') constrain(x, clip.left, clip.right, bounds.width);
          if (overflowY !== 'visible') constrain(y, clip.top, clip.bottom, bounds.height);
        }
        constrain(x, panelClip.left, panelClip.right, bounds.width); constrain(y, panelClip.top, panelClip.bottom, bounds.height);
        return { bounds, visible, hidden, reachableX: x.possible, reachableY: y.possible };
      };
      const close = entry.shadow.querySelector<HTMLButtonElement>('.ui-close');
      if (entry.panel.presentation === 'modal' && entry.panel.onDismiss) {
        const measured = close && inspect(close);
        if (!close || close.disabled || !measured || measured.hidden || measured.visible.width < 1 || measured.visible.height < 1 || style(close)?.pointerEvents === 'none') addIssue({ code: 'modal-close-hidden', panel: id, message: `Panel "${id}" must keep its close button visible and usable.` });
      }
      const nodes = [...entry.shadow.querySelectorAll<HTMLElement>('button,input,select,textarea,[role="button"]')];
      const visible: { element: HTMLElement; bounds: Rect; name: string }[] = [];
      if (nodes.length > 2048) addIssue({ code: 'measurement-limit', panel: id, message: `Panel "${id}" exceeds the 2048-target inspection limit.` });
      for (const element of nodes.slice(0, 2048)) {
        if ((element as HTMLButtonElement).disabled) continue;
        const measured = inspect(element); if (measured.hidden || measured.bounds.width <= 0 || measured.bounds.height <= 0) continue;
        const name = identify(element), bounds = measured.bounds;
        if (!measured.reachableX || !measured.reachableY) addIssue({ code: 'action-clipped', panel: id, message: `Panel "${id}" target "${name}" is clipped and cannot be fully reached by scrolling.`, rect: local(bounds) });
        if (measured.visible.width < 1 || measured.visible.height < 1) continue;
        if (this.touchViewport && (bounds.width < 43.5 || bounds.height < 43.5)) addIssue({ code: 'touch-target-too-small', panel: id, message: `Panel "${id}" target "${name}" measures ${Math.round(bounds.width)}×${Math.round(bounds.height)}; touch targets need at least 44×44 CSS pixels.`, rect: local(bounds) });
        if (visible.length < 256) visible.push({ element, bounds: measured.visible, name });
      }
      visible.sort((a, b) => a.bounds.left - b.bounds.left);
      for (let index = 0; index < visible.length; index++) for (let other = index + 1; other < visible.length && visible[other].bounds.left < visible[index].bounds.right - 1; other++) {
        const a = visible[index], b = visible[other]; if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        const overlap = intersect(a.bounds, b.bounds);
        if (overlap.width > 1 && overlap.height > 1) addIssue({ code: 'interactive-overlap', panel: id, conflictsWith: b.name, message: `Panel "${id}" targets "${a.name}" and "${b.name}" overlap by ${Math.round(overlap.width)}×${Math.round(overlap.height)} CSS pixels.`, rect: local(overlap) });
      }
    }
    this.lastMeasurement = performance.now(); this.measuredIssues = issues; this.invalidPanels.clear();
    for (const id of invalid) this.invalidPanels.add(id);
    for (const [id, entry] of this.panels) entry.host.dataset.layoutInvalid = String(this.invalidPanels.has(id));
    this.publishIssues(); return [...this.issues];
  }
  private scheduleMeasurement(): void {
    if (this.disposed || this.measureTimer !== undefined || typeof requestAnimationFrame !== 'function') return;
    this.measureTimer = setTimeout(() => {
      this.measureTimer = undefined;
      requestAnimationFrame(() => { if (!this.disposed) this.measureLayout(); });
    }, Math.max(0, 160 - (performance.now() - this.lastMeasurement)));
  }
  update(value: GameUiDocument | null, viewport: GameUiViewport): void {
    this.requestedModal = !!value && Array.isArray(value.panels) && value.panels.some(panel => panel?.presentation === 'modal' && panel.visible !== false);
    this.touchViewport = !!viewport.touch;
    let focus: FocusSnapshot | undefined, externalFocus: HTMLElement | undefined;
    try {
      const signature = JSON.stringify(value);
      if (signature !== this.signature) {
        const next = value ? validateGameUi(value) : null;
        focus = this.focusKey();
        externalFocus = [...this.panels.values()].map(entry => entry.shadow.activeElement).find(element => element && [...this.hostPanels.values()].some(panel => panel.element.contains(element))) as HTMLElement | undefined;
        const scroll = new Map([...this.panels].map(([id, entry]) => [id, entry.shadow.querySelector('.ui-content')?.scrollTop ?? 0]));
        this.current = next; this.signature = signature; this.pruneSelections();
        const desired = next?.panels.filter(panel => panel.visible !== false) ?? [];
        const retained = new Set(desired.map(panel => panel.id));
        for (const [id, entry] of this.panels) if (!retained.has(id)) { this.observers.get(id)?.disconnect(); this.observers.delete(id); this.grids.delete(id); this.nodeElements.delete(id); entry.host.remove(); this.panels.delete(id); }
        if (next) for (const panel of desired) {
          const panelSignature = JSON.stringify([panel, next.theme, this.hostRevision]);
          const entry = this.panels.get(panel.id);
          if (entry?.signature === panelSignature) continue;
          if (entry && entry.shell === this.panelShell(panel, next) && this.patchNodes(entry.panel.children, panel.children, panel.id)) { entry.panel = panel; entry.signature = panelSignature; continue; }
          this.observers.get(panel.id)?.disconnect(); this.observers.delete(panel.id); this.panels.get(panel.id)?.host.remove(); this.panels.delete(panel.id); this.mountPanel(panel, next, panelSignature);
        }
        for (const [id, entry] of this.panels) { const content = entry.shadow.querySelector('.ui-content'); if (content) content.scrollTop = scroll.get(id) ?? 0; }
      }
      const placements = this.current ? layoutGameUi(this.current, viewport) : []; this.placed = placements;
      const visible = new Set(placements.map(placement => placement.id));
      for (const [id, entry] of this.panels) entry.host.hidden = !visible.has(id);
      for (const placement of placements) {
        const entry = this.panels.get(placement.id); if (!entry) continue;
        Object.assign(entry.host.style, { left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px` });
        entry.host.dataset.touch = String(!!viewport.touch);
      }
      this.reflowGrids();
      if (focus) this.restoreFocus(focus);
      else if (externalFocus?.isConnected && [...this.panels.values()].some(entry => !entry.host.hidden && entry.shadow.contains(externalFocus!))) externalFocus.focus({ preventScroll: true });
      this.layoutIssues = []; this.publishIssues();
      this.setBlocking(!this.isSuspended && placements.some(placement => placement.modal));
      const measureKey = JSON.stringify([this.signature, placements, !!viewport.touch]);
      if (measureKey !== this.measureKey) { this.measureKey = measureKey; this.scheduleMeasurement(); }
    } catch (error) {
      this.root.replaceChildren(); this.panels.clear(); this.nodeElements.clear(); this.grids.clear(); this.current = null; this.signature = ''; this.placed = [];
      this.observers.forEach(observer => observer.disconnect()); this.observers.clear();
      this.layoutIssues = error instanceof GameUiLayoutError ? error.issues : [{ code: 'invalid-ui', message: error instanceof Error ? error.message : 'Invalid game UI' }];
      this.measuredIssues = []; this.invalidPanels.clear(); this.publishIssues();
      this.setBlocking(!this.isSuspended && this.requestedModal);
    }
  }
  private report(issues: readonly GameUiIssue[]): void {
    if (JSON.stringify(issues) !== JSON.stringify(this.issues)) { this.issues = issues; this.options.onDiagnostics?.(issues); }
  }
  private publishIssues(): void { this.report([...this.layoutIssues, ...this.measuredIssues]); }
  private setBlocking(value: boolean): void {
    this.root.dataset.gameUiBlocking = String(value);
    if (value === this.isBlocking) return;
    this.isBlocking = value;
    if (value) {
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      queueMicrotask(() => { if (this.isBlocking && !this.isSuspended && !this.root.contains(document.activeElement)) this.firstModal()?.querySelector<HTMLElement>('[tabindex],button,input')?.focus({ preventScroll: true }); });
    } else if (!this.isSuspended) this.previousFocus?.focus({ preventScroll: true });
    this.options.onBlockingChange?.(value);
  }
  private emit(panel: GameUiPanel, action: GameUiAction | undefined, extra: Partial<GameUiAction> = {}): void {
    if (this.isSuspended || !action || !this.current?.actions?.some(item => item.name === action.name)) return;
    if (this.invalidPanels.has(panel.id) && action.name !== panel.onDismiss?.name) return;
    this.options.onAction({ ...action, ...extra, panel: panel.id });
  }
  private mountPanel(panel: GameUiPanel, doc: GameUiDocument, signature: string): void {
    this.grids.set(panel.id, []);
    this.nodeElements.set(panel.id, new Map());
    const host = make('section', 'game-ui-panel-host'); host.dataset.panel = panel.id; host.dataset.role = panel.role;
    Object.assign(host.style, { position: 'absolute', overflow: 'hidden', pointerEvents: panel.role === 'crosshair' ? 'none' : 'auto', boxSizing: 'border-box', contain: 'layout paint style', isolation: 'isolate' });
    const shadow = host.attachShadow({ mode: 'open' });
    for (const type of ['pointerdown', 'click', 'keydown', 'submit']) shadow.addEventListener(type, event => {
      if (!this.invalidPanels.has(panel.id) || (event as KeyboardEvent).key === 'Escape' || (event.target as HTMLElement)?.closest?.('.ui-close')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    // Stop composed UI input before it reaches the gameplay surface or window bindings.
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'contextmenu', 'keydown', 'keyup']) shadow.addEventListener(type, event => {
      if (type === 'keydown' && (event as KeyboardEvent).key === 'Tab') this.keyDown(event as KeyboardEvent);
      if ((event as KeyboardEvent).key !== 'Escape') event.stopPropagation();
    });
    const external = this.hostPanels.get(panel.id);
    shadow.append(make('style', '', gameUiCss + '\n' + (external?.css ?? '') + '\n' + (doc.theme?.css ?? '')));
    const surface = make('div', `ui-panel ${panel.presentation === 'modal' ? 'ui-modal' : 'ui-hud'} ui-role-${panel.role}`);
    surface.part.add('panel'); surface.dataset.panel = panel.id;
    for (const [token, value] of Object.entries(doc.theme?.tokens ?? {})) surface.style.setProperty(token, value);
    if (panel.presentation === 'modal') { surface.setAttribute('role', 'dialog'); surface.setAttribute('aria-modal', 'true'); }
    surface.setAttribute('aria-label', panel.title ?? panel.role);
    if (panel.title || panel.onDismiss) {
      const header = make('header', 'ui-header'); const title = make('h2', 'ui-title', panel.title ?? panel.role); title.part.add('title'); title.tabIndex = -1; title.dataset.focusKey = `${panel.id}/@title`; header.append(title);
      if (panel.onDismiss) { const close = this.button('Close', () => this.emit(panel, panel.onDismiss)); close.classList.add('ui-close'); close.dataset.focusKey = `${panel.id}/@close`; close.textContent = '×'; close.setAttribute('aria-label', `Close ${panel.title}`); header.append(close); }
      surface.append(header);
    }
    const content = make('div', 'ui-content'); content.part.add('content');
    let footer: HTMLElement | undefined;
    if (external) content.append(external.element);
    else {
      const trailing = panel.children[panel.children.length - 1];
      const pinned = panel.presentation === 'modal' && trailing && (trailing.kind === 'button' && trailing.primary || trailing.kind === 'row' && trailing.children.some(node => node.kind === 'button' && node.primary));
      panel.children.forEach((node, index) => {
        const rendered = this.renderNode(node, panel, `${panel.id}/${index}`);
        if (pinned && index === panel.children.length - 1) { footer = make('footer', 'ui-footer'); footer.part.add('footer'); footer.append(rendered); }
        else content.append(rendered);
      });
    }
    const status = make('p', 'ui-live'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    surface.append(content); if (footer) surface.append(footer); surface.append(status); shadow.append(surface); this.root.append(host); this.panels.set(panel.id, { host, shadow, panel, signature, shell: this.panelShell(panel, doc) });
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => this.scheduleMeasurement()); observer.observe(shadow, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'disabled'] }); this.observers.set(panel.id, observer);
    }
    shadow.addEventListener('scroll', () => this.scheduleMeasurement(), true);
  }
  private button(label: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = make('button', 'ui-button', label); button.type = 'button'; button.disabled = disabled; button.part.add('button');
    button.addEventListener('click', action); return button;
  }
  private renderNode(node: GameUiNode, panel: GameUiPanel, key: string): HTMLElement {
    key = node.id ? `${panel.id}/node:${node.id}` : key;
    let result: HTMLElement;
    if (node.kind === 'text') { result = make(node.heading ? 'h3' : 'p', `ui-text ui-tone-${node.tone ?? 'normal'}`, node.text); }
    else if (node.kind === 'row' || node.kind === 'stack') {
      result = make('div', `ui-${node.kind}`); if (node.label) result.setAttribute('aria-label', node.label);
      node.children.forEach((child, index) => result.append(this.renderNode(child, panel, `${key}/${index}`)));
    } else if (node.kind === 'button') { result = this.button(node.label, () => this.emit(panel, node.action), node.disabled); result.dataset.action = node.action.name; result.dataset.focusKey = key; if (node.primary) result.classList.add('ui-primary'); }
    else if (node.kind === 'bar') {
      result = make('div', `ui-bar ui-bar-${node.tone ?? 'health'}`); result.part.add('bar');
      result.setAttribute('role', 'progressbar'); result.setAttribute('aria-label', node.label); result.setAttribute('aria-valuemin', '0'); result.setAttribute('aria-valuemax', String(node.max)); result.setAttribute('aria-valuenow', String(node.value));
      const fill = make('span', 'ui-bar-fill'); fill.style.width = `${Math.max(0, Math.min(100, node.value / Math.max(1, node.max) * 100))}%`;
      result.append(fill, make('span', 'ui-bar-label', `${node.label}  ${Math.round(node.value)} / ${Math.round(node.max)}`));
    } else if (node.kind === 'grid') result = this.grid(node, panel, key);
    else if (node.kind === 'choices') result = this.choices(node, panel, key);
    else if (node.kind === 'tabs') {
      result = make('div', 'ui-tabs'); const list = make('div', 'ui-tablist'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', node.label);
      const requested = this.tabs.get(key) ?? node.selected; const selected = node.tabs.some(tab => tab.id === requested) ? requested! : node.tabs[0]?.id; const contents: HTMLElement[] = []; const buttons: HTMLButtonElement[] = [];
      const activate = (id: string) => { this.tabs.set(key, id); buttons.forEach((button, index) => { const active = node.tabs[index].id === id; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; contents[index].hidden = !active; }); };
      node.tabs.forEach((tab, index) => {
        const button = this.button(tab.label, () => activate(tab.id)); button.setAttribute('role', 'tab'); button.dataset.focusKey = `${key}/tab:${tab.id}`; button.id = `tab-${key.replace(/\W/g, '-')}-${index}`;
        const content = make('div', 'ui-tab-content'); content.setAttribute('role', 'tabpanel'); content.id = `${button.id}-content`; content.setAttribute('aria-labelledby', button.id); button.setAttribute('aria-controls', content.id);
        tab.children.forEach((child, childIndex) => content.append(this.renderNode(child, panel, `${key}/${tab.id}/${childIndex}`)));
        buttons.push(button); contents.push(content); list.append(button);
        button.addEventListener('keydown', event => { const next = this.navigationIndex(event, index, buttons.length, 1); if (next !== null) { event.preventDefault(); activate(node.tabs[next].id); buttons[next].focus(); } });
      }); result.append(list, ...contents); activate(selected);
    } else if (node.kind === 'crosshair') {
      result = make('div', `ui-crosshair ui-crosshair-${node.shape ?? 'plus'}`); result.part.add('crosshair'); result.setAttribute('aria-hidden', 'true');
      result.style.setProperty('--cross-size', `${node.size ?? 20}px`); result.style.setProperty('--cross-gap', `${node.gap ?? 4}px`); result.style.setProperty('--cross-thickness', `${node.thickness ?? 2}px`); result.style.color = node.color ?? 'white';
      if (node.outline !== false) result.classList.add('ui-crosshair-outlined');
      for (let index = 0; index < 4; index++) result.append(make('i', `ui-cross-arm ui-cross-arm-${index}`));
    } else result = make('div', 'ui-stack');
    if (node.id) result.dataset.node = node.id;
    if (node.className) result.classList.add(...node.className.split(/\s+/).filter(Boolean));
    this.nodeElements.get(panel.id)?.set(key, result);
    return result;
  }
  private panelShell(panel: GameUiPanel, document: GameUiDocument): string {
    const { children: _children, ...metadata } = panel;
    return JSON.stringify([metadata, document.theme, this.hostRevision]);
  }
  private patchNodes(previous: GameUiNode[], next: GameUiNode[], panel: string, path = panel): boolean {
    if (previous.length !== next.length) return false;
    const compatible = (before: GameUiNode, after: GameUiNode): boolean => {
      if (JSON.stringify(before) === JSON.stringify(after)) return true;
      if (before.kind !== after.kind || before.id !== after.id || before.className !== after.className) return false;
      if (before.kind === 'text' && after.kind === 'text') return before.heading === after.heading && before.tone === after.tone;
      if (before.kind === 'bar' && after.kind === 'bar') return before.tone === after.tone;
      if (before.kind === 'button' && after.kind === 'button') return before.primary === after.primary && JSON.stringify(before.action) === JSON.stringify(after.action);
      if ((before.kind === 'row' || before.kind === 'stack') && (after.kind === 'row' || after.kind === 'stack')) return before.label === after.label && before.children.length === after.children.length && before.children.every((node, index) => compatible(node, after.children[index]));
      return false;
    };
    if (!previous.every((node, index) => compatible(node, next[index]))) return false;
    for (let index = 0; index < previous.length; index++) {
      const before = previous[index], after = next[index], key = after.id ? `${panel}/node:${after.id}` : `${path}/${index}`;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const element = this.nodeElements.get(panel)?.get(key); if (!element) continue;
      if (after.kind === 'text' && before.kind === 'text' && after.text !== before.text) element.textContent = after.text;
      if (after.kind === 'button' && before.kind === 'button') { if (before.label !== after.label) element.textContent = after.label; (element as HTMLButtonElement).disabled = !!after.disabled; }
      if (after.kind === 'bar' && before.kind === 'bar') {
        element.setAttribute('aria-label', after.label); element.setAttribute('aria-valuemax', String(after.max)); element.setAttribute('aria-valuenow', String(after.value));
        const fill = element.querySelector<HTMLElement>('.ui-bar-fill'), label = element.querySelector('.ui-bar-label');
        if (fill) fill.style.width = `${Math.max(0, Math.min(100, after.value / Math.max(1, after.max) * 100))}%`;
        if (label) label.textContent = `${after.label}  ${Math.round(after.value)} / ${Math.round(after.max)}`;
      }
      if ((after.kind === 'row' || after.kind === 'stack') && (before.kind === 'row' || before.kind === 'stack')) this.patchNodes(before.children, after.children, panel, key);
    }
    return true;
  }
  private grid(node: Extract<GameUiNode, { kind: 'grid' }>, panel: GameUiPanel, key: string): HTMLElement {
    const section = make('section', 'ui-inventory'); section.append(make('h3', 'ui-section-title', node.label));
    const help = make('p', 'ui-help', node.moveAction ? 'Select an item, then a destination slot.' : 'Select an item to inspect or use it.'); help.setAttribute('aria-live', 'polite'); section.append(help);
    const scroll = make('div', 'ui-grid-scroll'); const grid = make('div', `ui-grid${node.spatial ? ' ui-spatial' : ''}`); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', node.label); grid.setAttribute('aria-rowcount', String(node.rows)); grid.setAttribute('aria-colcount', String(node.columns)); grid.dataset.grid = node.id;
    grid.style.setProperty('--columns', String(node.columns)); grid.style.setProperty('--rows', String(node.rows));
    const rowGroups = Array.from({ length: node.rows }, () => { const row = make('div', 'ui-grid-row'); row.setAttribute('role', 'row'); grid.append(row); return row; });
    const cells: HTMLButtonElement[] = []; const occupied = new Set<number>();
    const runtime: GridRuntime = { node, grid, scroll, cells, visualColumns: node.columns }; this.grids.get(panel.id)?.push(runtime);
    const positions = new Map<number, GameUiItem>();
    for (const [index, item] of node.items.entries()) {
      const position = node.spatial ? (item.y ?? 0) * node.columns + (item.x ?? index) : item.slot ?? index;
      positions.set(position, item);
      const width = item.rotated ? item.height ?? 1 : item.width ?? 1, height = item.rotated ? item.width ?? 1 : item.height ?? 1;
      if (node.spatial) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x || y) occupied.add(position + y * node.columns + x);
    }
    for (let index = 0; index < node.columns * node.rows; index++) {
      if (occupied.has(index)) continue;
      const item = positions.get(index); const cell = this.button('', () => {
        const selected = this.selections.get(panel.id); const move = node.moveAction ?? selected?.move;
        if (selected && (!item || item.id !== selected.item.id) && move) {
          this.emit(panel, move, { item: selected.item.id, source: selected.source, target: node.id, index, x: index % node.columns, y: Math.floor(index / node.columns), rotated: selected.rotated });
          this.selections.delete(panel.id); help.textContent = 'Move requested.'; grid.querySelectorAll('[data-picked]').forEach(element => element.removeAttribute('data-picked')); return;
        }
        if (item) { this.selections.set(panel.id, { item, source: node.id, move: node.moveAction, rotated: !!item.rotated }); help.textContent = `${item.label}${item.description ? ' · ' + item.description : ''}${item.meta ? ' · ' + item.meta : ''}`; grid.querySelectorAll('[data-picked]').forEach(element => element.removeAttribute('data-picked')); cell.dataset.picked = 'true'; this.emit(panel, item.action ?? node.action, { item: item.id, source: node.id, index }); }
      }, item?.disabled);
      cell.className = 'ui-slot'; cell.part.add('slot'); cell.dataset.slot = String(index); cell.dataset.focusKey = `${key}/${index}`; cell.tabIndex = cells.length ? -1 : 0;
      cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-label', item ? `${item.label}${item.count !== undefined ? ', ' + item.count : ''}${item.meta ? ', ' + item.meta : ''}` : `Empty slot ${index + 1}`);
      cell.setAttribute('aria-rowindex', String(Math.floor(index / node.columns) + 1)); cell.setAttribute('aria-colindex', String(index % node.columns + 1));
      if (node.spatial && item) { cell.setAttribute('aria-colspan', String(item.rotated ? item.height ?? 1 : item.width ?? 1)); cell.setAttribute('aria-rowspan', String(item.rotated ? item.width ?? 1 : item.height ?? 1)); }
      cell.style.gridColumn = `${index % node.columns + 1} / span ${node.spatial ? item?.rotated ? item.height ?? 1 : item?.width ?? 1 : 1}`; cell.style.gridRow = `${Math.floor(index / node.columns) + 1} / span ${node.spatial ? item?.rotated ? item.width ?? 1 : item?.height ?? 1 : 1}`;
      if (item) {
        cell.dataset.item = item.id; cell.dataset.rarity = item.rarity ?? 'common'; cell.setAttribute('aria-selected', String(!!item.selected || node.selected === item.id));
        if (this.selections.get(panel.id)?.item.id === item.id && this.selections.get(panel.id)?.source === node.id) cell.dataset.picked = 'true';
        const icon = make('span', 'ui-item-icon', item.icon ?? '◇'); icon.part.add('item-icon'); const label = make('span', 'ui-item-label', item.label); label.part.add('item-label'); cell.append(icon, label);
        if (item.count !== undefined) cell.append(make('span', 'ui-item-count', String(item.count)));
        if (item.meta) cell.title = `${item.label} · ${item.meta}`;
      } else cell.append(make('span', 'ui-empty-slot', '·'));
      cells.push(cell); rowGroups[Math.floor(index / node.columns)].append(cell);
    }
    let firstEnabled = true; for (const cell of cells) { cell.tabIndex = !cell.disabled && firstEnabled ? 0 : -1; if (!cell.disabled) firstEnabled = false; }
    // Bind after all cells exist so keyboard navigation sees the complete grid.
    grid.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const at = cells.indexOf(event.target as HTMLButtonElement); const next = this.gridNavigation(event, cells, at, runtime.visualColumns);
      if (next !== null) { event.preventDefault(); cells.forEach((entry, index) => entry.tabIndex = index === next ? 0 : -1); cells[next].focus(); }
    }, true);
    scroll.append(grid); section.append(scroll);
    if (node.spatial && node.moveAction) { const rotate = this.button('Rotate selected item', () => { const selected = this.selections.get(panel.id); if (selected) { selected.rotated = !selected.rotated; help.textContent = `${selected.item.label} · ${selected.rotated ? 'rotated' : 'original orientation'} · choose a destination`; } }); rotate.dataset.focusKey = `${key}/@rotate`; section.append(rotate); }
    return section;
  }
  private reflowGrids(): void {
    for (const [panelId, entries] of this.grids) {
      if (this.panels.get(panelId)?.host.hidden) continue;
      for (const runtime of entries) {
        if (runtime.node.spatial || runtime.node.flow === 'scroll' || !Number.isFinite(runtime.scroll.clientWidth) || runtime.scroll.clientWidth <= 0) continue;
        const appearance = typeof getComputedStyle === 'function' ? getComputedStyle(runtime.scroll) : undefined;
        const width = runtime.scroll.clientWidth - (parseFloat(appearance?.paddingLeft ?? '0') || 0) - (parseFloat(appearance?.paddingRight ?? '0') || 0);
        const columns = Math.max(1, Math.min(runtime.node.columns, Math.floor((width + 5) / 49)));
        if (columns === runtime.visualColumns) continue;
        const root = runtime.grid.getRootNode?.() as Document | ShadowRoot | undefined;
        const focused = runtime.cells.includes(root?.activeElement as HTMLButtonElement) ? root?.activeElement as HTMLElement : null;
        const rows = Math.ceil(runtime.node.columns * runtime.node.rows / columns);
        const groups = Array.from({ length: rows }, () => { const row = make('div', 'ui-grid-row'); row.setAttribute('role', 'row'); return row; });
        runtime.grid.replaceChildren(...groups);
        for (const cell of runtime.cells) {
          // Logical slot IDs and action coordinates remain in the original container grid.
          const slot = Number(cell.dataset.slot), x = slot % columns, y = Math.floor(slot / columns);
          cell.style.gridColumn = `${x + 1} / span 1`; cell.style.gridRow = `${y + 1} / span 1`;
          cell.setAttribute('aria-rowindex', String(y + 1)); cell.setAttribute('aria-colindex', String(x + 1)); groups[y].append(cell);
        }
        runtime.grid.style.setProperty('--columns', String(columns)); runtime.grid.style.setProperty('--rows', String(rows));
        runtime.grid.setAttribute('aria-colcount', String(columns)); runtime.grid.setAttribute('aria-rowcount', String(rows)); runtime.visualColumns = columns;
        focused?.focus({ preventScroll: true });
      }
    }
  }
  private choices(node: Extract<GameUiNode, { kind: 'choices' }>, panel: GameUiPanel, key: string): HTMLElement {
    const section = make('section', 'ui-choices'); section.append(make('h3', 'ui-section-title', node.label));
    const list = make('div', `ui-choice-list ui-choice-${node.variant ?? 'cards'}`); list.setAttribute('role', 'group'); list.setAttribute('aria-label', node.label); list.style.setProperty('--choice-columns', String(node.columns ?? 3));
    const entries: { item: typeof node.items[number]; button: HTMLButtonElement }[] = [];
    const detail = make('p', 'ui-choice-detail', node.items.find(item => item.selected)?.description ?? 'Choose a portrait to preview its role and abilities.'); detail.setAttribute('role', 'status');
    const filter = (value: string) => { this.searches.set(key, value); let first = true; entries.forEach(({ item, button }) => { button.hidden = !`${item.label} ${item.role ?? ''}`.toLowerCase().includes(value.toLowerCase()); button.tabIndex = !button.hidden && !button.disabled && first ? 0 : -1; if (!button.hidden && !button.disabled) first = false; }); };
    if (node.searchable) { const search = make('input', 'ui-search'); search.type = 'search'; search.placeholder = 'Search characters'; search.setAttribute('aria-label', `Search ${node.label}`); search.value = this.searches.get(key) ?? ''; search.dataset.focusKey = `${key}/search`; search.addEventListener('input', () => filter(search.value)); section.append(search); }
    for (const [index, item] of node.items.entries()) {
      const button = this.button('', () => { detail.textContent = `${item.label} · ${item.description ?? item.role ?? ''}${item.meta ? ' · ' + item.meta : ''}`; this.emit(panel, item.action ?? node.action, { item: item.id, index }); }, item.disabled);
      button.className = 'ui-choice'; button.part.add('choice'); button.dataset.choice = item.id; button.dataset.focusKey = `${key}/${item.id}`; button.dataset.confirmed = String(!!item.confirmed); button.setAttribute('aria-pressed', String(!!item.selected));
      button.append(make('span', 'ui-choice-icon', item.icon ?? '✦'), make('strong', 'ui-choice-label', item.label));
      if (item.role) button.append(make('span', 'ui-choice-role', item.role));
      if (item.meta || item.confirmed) button.append(make('span', 'ui-choice-meta', item.confirmed ? 'Locked in' : item.meta));
      button.setAttribute('aria-label', `${item.label}${item.role ? ', ' + item.role : ''}${item.confirmed ? ', locked in' : ''}${item.disabled ? ', unavailable' : ''}`);
      entries.push({ item, button }); list.append(button);
    }
    list.addEventListener('keydown', event => {
      const visible = entries.map(entry => entry.button).filter(button => !button.hidden && !button.disabled);
      const at = visible.indexOf(event.target as HTMLButtonElement); if (at < 0) return;
      const next = this.navigationIndex(event, at, visible.length, node.columns ?? 3); if (next === null) return;
      event.preventDefault(); entries.forEach(entry => entry.button.tabIndex = -1); visible[next].tabIndex = 0; visible[next].focus();
    });
    filter(this.searches.get(key) ?? ''); section.append(list, detail); return section;
  }
  private navigationIndex(event: KeyboardEvent, at: number, count: number, columns: number): number | null {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : 0;
    if (event.key === 'Home') return 0; if (event.key === 'End') return count - 1;
    return delta ? Math.max(0, Math.min(count - 1, at + delta)) : null;
  }
  private gridNavigation(event: KeyboardEvent, cells: HTMLButtonElement[], at: number, columns: number): number | null {
    if (at < 0) return null;
    if (event.key === 'Home') return cells.findIndex(cell => !cell.disabled); if (event.key === 'End') return cells.findLastIndex(cell => !cell.disabled);
    const origin = Number(cells[at].dataset.slot), x = origin % columns, y = Math.floor(origin / columns);
    const candidates = cells.map((cell, index) => ({ index, slot: Number(cell.dataset.slot), disabled: cell.disabled })).filter(item => !item.disabled).map(item => ({ ...item, x: item.slot % columns, y: Math.floor(item.slot / columns) }));
    const direction = event.key;
    const matches = candidates.filter(item => direction === 'ArrowRight' ? item.y === y && item.x > x : direction === 'ArrowLeft' ? item.y === y && item.x < x : direction === 'ArrowDown' ? item.y > y : direction === 'ArrowUp' ? item.y < y : false);
    matches.sort((a, b) => direction === 'ArrowRight' || direction === 'ArrowLeft' ? Math.abs(a.x - x) - Math.abs(b.x - x) : Math.abs(a.y - y) * columns + Math.abs(a.x - x) - (Math.abs(b.y - y) * columns + Math.abs(b.x - x)));
    return matches[0]?.index ?? at;
  }
  private pruneSelections(): void {
    const find = (nodes: GameUiNode[], source: string, id: string): GameUiItem | undefined => {
      for (const node of nodes) {
        if (node.kind === 'grid' && node.id === source) { const item = node.items.find(item => item.id === id); if (item) return item; }
        if (node.kind === 'row' || node.kind === 'stack') { const item = find(node.children, source, id); if (item) return item; }
        if (node.kind === 'tabs') for (const tab of node.tabs) { const item = find(tab.children, source, id); if (item) return item; }
      }
      return undefined;
    };
    for (const [panelId, selection] of this.selections) {
      const panel = this.current?.panels.find(panel => panel.id === panelId && panel.visible !== false);
      const item = panel && find(panel.children, selection.source, selection.item.id);
      if (!item || item.disabled) this.selections.delete(panelId); else selection.item = item;
    }
  }
  private firstModal(): ShadowRoot | undefined { return [...this.panels.values()].find(entry => entry.panel.presentation === 'modal' && !entry.host.hidden)?.shadow; }
  private outsidePointer = (event: PointerEvent): void => {
    if (this.root.contains(event.target as Node)) return;
    for (const entry of this.panels.values()) (entry.shadow.activeElement as HTMLElement | null)?.blur();
  };
  private keyDown = (event: KeyboardEvent): void => {
    if (!this.blocking || this.isSuspended) return;
    if (event.key === 'Escape' && !event.repeat) this.escapeAt = performance.now();
    if (event.key !== 'Tab') return;
    const shadow = this.firstModal(); if (!shadow) return;
    const targets = [...shadow.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'),...(this.options.hostFocusTargets?.()??[])].filter(element => element.tabIndex>=0 && !element.hidden && !(element as HTMLButtonElement).disabled && !element.closest('[hidden]'));
    if (!targets.length) return;
    const active = shadow.activeElement??document.activeElement; const at = targets.indexOf(active as HTMLElement);
    event.preventDefault();targets[at<0?(event.shiftKey?targets.length-1:0):(at+(event.shiftKey?-1:1)+targets.length)%targets.length]!.focus();
  };
  private keyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.blocking || this.isSuspended || !this.escapeAt) return;
    const elapsed = performance.now() - this.escapeAt; this.escapeAt = 0; if (elapsed >= 450) return;
    if (this.dismissTop()) event.preventDefault();
  };
  private focusKey(): FocusSnapshot | undefined {
    for (const [panel, entry] of this.panels) { const active = entry.shadow.activeElement as HTMLElement | null; if (active?.dataset.focusKey) return { panel, key: active.dataset.focusKey, index: [...entry.shadow.querySelectorAll('[data-focus-key]')].indexOf(active) }; }
    return undefined;
  }
  private restoreFocus(snapshot: FocusSnapshot): void {
    const original = this.panels.get(snapshot.panel), entry = original && !original.host.hidden ? original : [...this.panels.values()].find(entry => !entry.host.hidden && entry.panel.presentation === 'modal') ?? [...this.panels.values()].find(entry => !entry.host.hidden);
    if (!entry) return;
    const controls = [...entry.shadow.querySelectorAll<HTMLElement>('[data-focus-key]')];
    const available = (element: HTMLElement) => !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true' && !element.hidden && !element.closest('[hidden]');
    const exact = controls.find(element => element.dataset.focusKey === snapshot.key && available(element));
    const actionable = (element: HTMLElement) => available(element) && ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName);
    const target = exact ?? controls.slice(Math.max(0, snapshot.index)).find(actionable) ?? controls.slice(0, Math.max(0, snapshot.index)).reverse().find(actionable) ?? controls.find(actionable);
    if (target && entry.shadow.activeElement !== target) target.focus({ preventScroll: true });
  }
}
