import * as THREE from 'three';
import type { ViewFrame } from '../shared/gameApi.ts';
import type { PlayerState, WorldState } from './shapes.ts';
import type { GameTuning } from './tuning.ts';
import { TABLES } from './layout.ts';
import { CARD_COLORS, EMOTES, canPlayCard, cardColor, cardLabel, cardValue } from './socialGames.ts';

/** A real final overlay pass: no world depth, fog or mirror can cover the controls. */
export class LoungeOverlay {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  private readonly canvas = new OffscreenCanvas(1280, 720);
  private readonly context = this.canvas.getContext('2d')!;
  private readonly texture = new THREE.CanvasTexture(this.canvas);
  private readonly material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly panel = new THREE.Mesh(this.geometry, this.material);
  private key = '';
  constructor() { this.camera.position.z = 1; this.texture.colorSpace = THREE.SRGBColorSpace; this.scene.add(this.panel); }
  resize(width: number, height: number) {
    const factor = Math.min(1, 1800 / Math.max(1, width));
    this.canvas.width = Math.max(1, Math.round(width * factor)); this.canvas.height = Math.max(1, Math.round(height * factor)); this.key = '';
  }
  private text(value: string, x: number, y: number, size = 20, color = '#f8efe0', align: CanvasTextAlign = 'center') {
    const c = this.context; c.font = `500 ${size}px sans-serif`; c.textAlign = align; c.textBaseline = 'middle'; c.fillStyle = color; c.fillText(value, x, y);
  }
  private panelBox(x: number, y: number, w: number, h: number, fill = '#141a2aee', border = '#b0a08a66', radius = 16) {
    const c = this.context; c.beginPath(); c.roundRect(x, y, w, h, radius); c.fillStyle = fill; c.fill();
    c.strokeStyle = border; c.lineWidth = 1.5; c.stroke();
  }
  private wrap(value: string, x: number, y: number, maxWidth: number, size: number, color = '#f8efe0') {
    const c = this.context; c.font = `500 ${size}px sans-serif`; const words = value.split(' '); let line = '', count = 0;
    for (const word of words) { const next = line ? `${line} ${word}` : word;
      if (line && c.measureText(next).width > maxWidth) { this.text(line, x, y + count * size * 1.4, size, color); line = word; count++; }
      else line = next;
    }
    if (line) this.text(line, x, y + count * size * 1.4, size, color);
  }
  private person(id: number, x: number, y: number, scale = 1) {
    const c = this.context; c.save(); c.translate(x, y); c.scale(scale, scale); c.strokeStyle = '#f9ead3'; c.lineWidth = 3.5; c.lineCap = 'round';
    c.beginPath(); c.arc(0, -20, 6, 0, Math.PI * 2); c.stroke();
    const line = (points: number[]) => { c.beginPath(); c.moveTo(points[0], points[1]); for (let n = 2; n < points.length; n += 2) c.lineTo(points[n], points[n + 1]); c.stroke(); };
    line([0, -10, 0, 11]); line([0, 11, -10, 28]); line([0, 11, 10, 28]);
    if (id === 1) { line([0, -6, -16, 5]); line([0, -6, 12, -11, 18, -28]); }
    if (id === 2) { line([0, -6, -17, -12, -22, -24]); line([0, -6, 18, 1, 23, -9]); }
    if (id === 3) { line([0, -6, -14, -18, -19, -32]); line([0, -6, 14, -18, 19, -32]); }
    if (id === 4) { line([0, -6, -16, 6, -4, 9]); line([0, -6, 16, 6, 4, 9]); }
    if (id === 5) { line([0, -6, -16, -2, -4, -13]); line([0, -6, 16, -2, 4, -13]); }
    if (id === 6) { line([0, -6, -15, 4, -4, 11]); line([0, -6, 16, 3]); }
    c.restore();
  }
  update(frame: ViewFrame<WorldState, PlayerState, GameTuning>, mirrorAvailable: boolean) {
    const me = frame.players.find(p => p.isLocal && p.active !== false), s = me?.state;
    const table = frame.world?.tables?.find(t => t.id === s?.tableId), w = this.canvas.width, h = this.canvas.height;
    const current = table && frame.players[table.turn], emote = EMOTES[(s?.emoteId ?? 0) - 1];
    const key = JSON.stringify([w, h, frame.phase, mirrorAvailable, s?.wheelOpen, s?.wheelChoice, s?.emoteId, s?.seatIndex,
      s?.selectedCard, s?.selectedColor, s?.hand, table?.phase, table?.topCard, table?.currentColor, table?.turn,
      table?.prompt, table?.message, table?.playerOrder.map(i => [frame.players[i]?.name, frame.players[i]?.state.hand?.length])]);
    if (key === this.key) return; this.key = key;
    const c = this.context; c.clearRect(0, 0, w, h);
    if (!me || frame.phase === 'menu' || frame.phase === 'ended') { this.texture.needsUpdate = true; return; }
    const small = w < 850, unit = Math.max(.85, Math.min(1.25, w / 1100));
    if (s?.wheelOpen) {
      const radius = Math.min(w * .30, h * .30, 218 * unit), cx = w / 2, cy = h * .47;
      c.fillStyle = '#090e1888'; c.fillRect(0, 0, w, h);
      this.text('EXPRESS YOURSELF', cx, cy - radius - 46 * unit, 24 * unit, '#edd5b3');
      for (let i = 0; i < 6; i++) {
        const angle = i * Math.PI / 3 - Math.PI / 2, selected = i === s.wheelChoice;
        c.beginPath(); c.arc(cx, cy, radius, angle - Math.PI / 6 + .025, angle + Math.PI / 6 - .025);
        c.arc(cx, cy, radius * .4, angle + Math.PI / 6 - .025, angle - Math.PI / 6 + .025, true); c.closePath();
        c.fillStyle = selected ? '#73638feb' : '#1c2636ed'; c.fill(); c.strokeStyle = selected ? '#f1ce9d' : '#ffffff18'; c.lineWidth = 2; c.stroke();
        const x = cx + Math.cos(angle) * radius * .72, y = cy + Math.sin(angle) * radius * .72;
        this.person(i + 1, x, y - 8 * unit, .78 * unit); this.text(EMOTES[i].label, x, y + 35 * unit, 16 * unit);
      }
      this.text(EMOTES[s.wheelChoice]?.label ?? 'Wave', cx, cy - 10 * unit, 22 * unit);
      this.text('CONFIRM TO PERFORM', cx, cy + 18 * unit, 12 * unit, '#d6bd9f');
      this.text(small ? 'Previous / Next to choose · Leave cancels' : 'Previous / Next to choose  ·  Leave cancels', cx, cy + radius + 38 * unit, 14 * unit, '#d4cddc');
    } else if (table) {
      const pw = Math.min(w - 32 * unit, table.kind === 'cards' ? 890 * unit : 730 * unit), ph = table.kind === 'cards' ? 260 * unit : 205 * unit;
      const x = (w - pw) / 2, y = Math.max(25, h - ph - (small ? 145 : 88) * unit);
      this.panelBox(x, y, pw, ph);
      this.text(`${TABLES[table.id]?.label ?? 'Table'}  /  ${table.id + 1}`, x + 22 * unit, y + 26 * unit, (small ? 18 : 22) * unit, '#f1ce9d', 'left');
      const localTurn = frame.players.indexOf(me) === table.turn;
      const status = table.phase === 'playing' ? localTurn ? 'YOUR TURN' : `${current?.name ?? 'Guest'}’s turn` : table.phase === 'finished'
        ? `${frame.players[table.winner]?.name ?? 'Guest'} WINS` : 'TAKE A SEAT TO JOIN';
      this.text(small && status.length > 19 ? status.slice(0, 18) + '…' : status, x + pw - 22 * unit, y + 27 * unit, (small ? 11 : 14) * unit, localTurn ? '#a3e5d4' : '#c5becf', 'right');
      if (table.kind === 'truth') {
        this.wrap(table.prompt || 'A good conversation starts with a little curiosity.', w / 2, y + 72 * unit, pw - 40 * unit, (small ? 18 : 23) * unit);
        this.text(small ? 'Always optional. Pass any time.' : table.promptKind ? `${table.promptKind.toUpperCase()}  ·  Always optional — pass any time` : 'Friendly prompts. No pressure. Everyone is welcome.', w / 2, y + 140 * unit, 13 * unit, '#c1bacb');
        this.text(small ? 'Truth · Dare · Pass · Leave' : table.prompt ? 'Confirm when done or to pass   ·   Ask for a truth or a dare   ·   Leave any time' : 'Ask for a truth or a dare   ·   Confirm to pass   ·   Leave any time', w / 2, y + ph - 25 * unit, (small ? 14 : 15) * unit, '#e8c49d');
      } else {
        const top = table.topCard >= 0 ? cardLabel(table.topCard) : 'Waiting for 2–4 guests';
        this.text(top, x + 22 * unit, y + 61 * unit, 17 * unit, table.topCard >= 0 ? CARD_COLORS[table.currentColor]?.hex : '#d4cddc', 'left');
        this.text(`Wild color: ${CARD_COLORS[s!.selectedColor ?? 0].name}`, x + pw - 22 * unit, y + 61 * unit, 13 * unit, CARD_COLORS[s!.selectedColor ?? 0].hex, 'right');
        const hand = s!.hand ?? [], selected = Math.min(s!.selectedCard ?? 0, hand.length - 1), maxVisible = small ? 7 : 11;
        const start = Math.max(0, Math.min(hand.length - maxVisible, selected - Math.floor(maxVisible / 2)));
        const visible = hand.slice(start, start + maxVisible), cw = Math.min(60 * unit, (pw - 55 * unit) / Math.max(1, visible.length)), gap = 6 * unit;
        const sx = w / 2 - (visible.length * cw + Math.max(0, visible.length - 1) * gap) / 2;
        visible.forEach((card, n) => {
          const chosen = start + n === selected, playable = canPlayCard(card, table), color = cardColor(card);
          const cx = sx + n * (cw + gap), cy = y + 91 * unit - (chosen ? 8 * unit : 0);
          this.panelBox(cx, cy, cw, 72 * unit, color < 0 ? '#5b4c75' : CARD_COLORS[color].hex, chosen ? '#fff9dd' : '#ffffff44', 7 * unit);
          this.text(cardValue(card) < 10 ? String(cardValue(card)) : ['SKIP', 'REV', '+2', 'WILD'][cardValue(card) - 10], cx + cw / 2, cy + 31 * unit, (cardValue(card) < 10 ? 26 : 12) * unit, '#121c2b');
          if (playable && table.turn === frame.players.indexOf(me)) this.text('•', cx + cw / 2, cy + 56 * unit, 22 * unit, '#fff9df');
        });
        if (!hand.length) this.text(table.message || 'Invite a friend to take the opposite seat.', w / 2, y + 117 * unit, 18 * unit, '#ddd3e6');
        const roster = table.playerOrder.map(index => `${(frame.players[index]?.name ?? 'Guest').slice(0, small ? 7 : 13)} ${frame.players[index]?.state.hand?.length ?? 0}`).join('   ·   ');
        this.text(roster || 'Two to four players. Invite a friend to join.', w / 2, y + ph - 74 * unit, (small ? 11 : 13) * unit, '#a5d6c9');
        const selectedCannotPlay = hand[selected] !== undefined && localTurn && !canPlayCard(hand[selected], table);
        const message = hand.length ? `${selected + 1} / ${hand.length} cards · ${selectedCannotPlay ? 'Match the top color or symbol, or draw.' : table.message}` : 'Match color or symbol. First empty hand wins.';
        this.text(small && message.length > 43 ? message.slice(0, 42) + '…' : message, w / 2, y + ph - 50 * unit, 12 * unit, '#c5becf');
        this.text(table.phase === 'playing' ? small ? 'Choose · Play · Draw · Wild color · Leave' : 'Previous / Next to choose   ·   Confirm plays   ·   Draw & pass   ·   Wild color   ·   Leave' : 'Start the round when everyone is seated   ·   Leave any time', w / 2, y + ph - 23 * unit, (small ? 12 : 14) * unit, '#e8c49d');
      }
    } else if (mirrorAvailable) {
      const pw = Math.min(w - 30, 440 * unit), y = h * .78;
      this.panelBox((w - pw) / 2, y, pw, 66 * unit);
      this.text('YOUR NEXT LOOK STARTS HERE', w / 2, y + 22 * unit, 16 * unit, '#edd1ab');
      this.text('Change your avatar  ·  Try an emote', w / 2, y + 46 * unit, 14 * unit, '#d5cedf');
    } else if (emote) {
      this.panelBox(w / 2 - 150 * unit, h * .79, 300 * unit, 48 * unit);
      this.text(`${emote.name}  ·  Move or leave to stop`, w / 2, h * .79 + 24 * unit, 15 * unit);
    }
    this.texture.needsUpdate = true;
  }
  render(renderer: THREE.WebGLRenderer) {
    const autoClear = renderer.autoClear, tone = renderer.toneMapping;
    try { renderer.autoClear = false; renderer.toneMapping = THREE.NoToneMapping; renderer.clearDepth(); renderer.render(this.scene, this.camera); }
    finally { renderer.autoClear = autoClear; renderer.toneMapping = tone; }
  }
  dispose() { this.texture.dispose(); this.material.dispose(); this.geometry.dispose(); this.scene.clear(); }
}
