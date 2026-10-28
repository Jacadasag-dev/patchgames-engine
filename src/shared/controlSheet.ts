import type { Binding, PointerControls } from './gameApi.ts';
import { assignBindings, keyLabel, mouseLabel } from './actionBindings.ts';

/**
 * The player-facing description of a game's declared controls, grouped by platform.
 * Built from the same validated declarations and the same default key assignment the
 * host uses, so the Games browser, the match menu and gameplay never disagree. A game
 * declares controls once; nothing here is authored separately.
 */
export interface ControlSheetEntry {
  /** Stable action id, or an engine-owned id such as `move`, `look` or `menu`. */
  id: string;
  label: string;
  description?: string;
  /** What the player does: "W / S", "Left click", "Joystick", "Hold button". */
  input: string;
}
export interface ControlSheet {
  /** Declared bindings only; empty for games that have not declared controls. */
  declared: number;
  keyboard: ControlSheetEntry[];
  touch: ControlSheetEntry[];
}

const HOST_MENU = 'Hold Escape (touch: the Menu button) for the game menu, voice and key rebinding.';

/** Describe controls as a fresh player receives them: declared keys, then automatic assignments. */
export function controlSheet(controls: { bindings: Binding[]; pointer?: PointerControls }): ControlSheet {
  const assigned = assignBindings(controls.bindings);
  const keyboard: ControlSheetEntry[] = [], touch: ControlSheetEntry[] = [];
  const movement = assigned.filter(binding => binding.role);
  const pointer = controls.pointer?.mode ?? 'free';
  for (const binding of assigned) {
    const entry = { id: binding.name, label: binding.label, ...(binding.description ? { description: binding.description } : {}) };
    const keys = binding.kind === 'axis' ? [binding.keys.map(keyLabel).join(' / ')] : binding.keys.map(keyLabel);
    const parts = [...keys.filter(Boolean), ...(binding.mouse === undefined ? [] : [mouseLabel(binding.mouse)])];
    keyboard.push({ ...entry, input: (binding.kind === 'held' ? 'Hold ' : '') + parts.join(' or ') });
    if (binding.role || binding.touch === 'hidden') continue;
    touch.push({ ...entry, input: binding.kind === 'axis' ? 'Slider' : binding.kind === 'held' ? 'Hold button' : 'Button' });
  }
  if (movement.length) {
    const labels = movement.map(binding => binding.label);
    touch.unshift({ id: 'move', label: 'Move', description: labels.join(' and ') + '.', input: 'Joystick' });
  }
  // Explicit lock/capture declares that pointer motion drives the game (looking or aiming).
  if (pointer !== 'free') {
    const look = { id: 'look', label: pointer === 'lock' ? 'Look around' : 'Aim' };
    keyboard.push({ ...look, input: pointer === 'lock' ? 'Move the mouse (click the game to lock it)' : 'Drag with the mouse' });
    touch.push({ ...look, input: 'Drag the screen' });
  }
  const menu = { id: 'menu', label: 'Game menu', description: HOST_MENU };
  keyboard.push({ ...menu, input: 'Hold Escape' });
  touch.push({ ...menu, input: 'Menu button' });
  return { declared: controls.bindings.length, keyboard, touch };
}
