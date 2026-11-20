/* eslint-disable no-use-before-define, import/no-unresolved */
// Stacker: a falling-block puzzle game for the Experience Workspace panel.
// Runs as a library plugin (narrow panel) or a fullscreen app.

const COLS = 10;
const ROWS = 20;
const HIDDEN = 2; // spawn rows above the visible well

const COLORS = {
  I: '#35c6e8',
  O: '#f5c83b',
  T: '#a45cf0',
  S: '#4fcf6a',
  Z: '#f0525a',
  J: '#4d7cf5',
  L: '#f59a3b',
};

const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

const LINE_SCORES = [0, 100, 300, 500, 800];
const KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0], [-1, -1], [1, -1]];
const LOCK_DELAY = 500;
const MAX_LOCK_RESETS = 15;
const DAS = 160;
const ARR = 45;
const SOFT_DROP_MS = 35;
const BEST_KEY = 'ew-stacker-best';

const $ = (id) => document.getElementById(id);
const boardCanvas = $('board');
const holdCanvas = $('hold');
const nextCanvas = $('next');
const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlayText = $('overlay-text');
const startBtn = $('start');
const root = document.querySelector('.stacker');

let sdkActions = null;
let last = performance.now();

// ---------- storage (may be blocked inside iframes) ----------
function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function writeBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* ignore */ }
}

// ---------- piece helpers ----------
function rotate(matrix, dir) {
  const n = matrix.length;
  const out = Array.from({ length: n }, () => Array(n).fill(0));
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (dir > 0) out[x][n - 1 - y] = matrix[y][x];
      else out[n - 1 - x][y] = matrix[y][x];
    }
  }
  return out;
}

function makeBag() {
  const bag = Object.keys(SHAPES);
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

// ---------- game state ----------
const state = {};

function reset() {
  state.grid = Array.from({ length: ROWS + HIDDEN }, () => Array(COLS).fill(null));
  state.queue = [...makeBag(), ...makeBag()];
  state.hold = null;
  state.canHold = true;
  state.score = 0;
  state.lines = 0;
  state.level = 1;
  state.best = readBest();
  state.running = false;
  state.paused = false;
  state.over = false;
  state.dropAcc = 0;
  state.lockTimer = 0;
  state.lockResets = 0;
  state.flash = null; // { rows, t }
  spawn();
  updateHud();
}

function nextType() {
  const t = state.queue.shift();
  if (state.queue.length < 7) state.queue.push(...makeBag());
  return t;
}

function spawn(type = nextType()) {
  const matrix = SHAPES[type].map((r) => [...r]);
  state.piece = {
    type,
    matrix,
    x: Math.floor((COLS - matrix.length) / 2),
    y: type === 'I' ? HIDDEN - 2 : HIDDEN - 1,
  };
  state.lockTimer = 0;
  state.lockResets = 0;
  if (collides(state.piece.matrix, state.piece.x, state.piece.y)) gameOver();
}

function collides(matrix, px, py) {
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (matrix[y][x]) {
        const gx = px + x;
        const gy = py + y;
        if (gx < 0 || gx >= COLS || gy >= ROWS + HIDDEN) return true;
        if (gy >= 0 && state.grid[gy][gx]) return true;
      }
    }
  }
  return false;
}

function onGround() {
  const p = state.piece;
  return collides(p.matrix, p.x, p.y + 1);
}

function touchLock() {
  if (onGround() && state.lockResets < MAX_LOCK_RESETS) {
    state.lockTimer = 0;
    state.lockResets += 1;
  }
}

function move(dx) {
  const p = state.piece;
  if (!collides(p.matrix, p.x + dx, p.y)) {
    p.x += dx;
    touchLock();
    return true;
  }
  return false;
}

function turn(dir) {
  const p = state.piece;
  if (p.type === 'O') return;
  const rotated = rotate(p.matrix, dir);
  const kicks = p.type === 'I'
    ? [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [0, -2]]
    : KICKS;
  const kick = kicks.find(([kx, ky]) => !collides(rotated, p.x + kx, p.y + ky));
  if (kick) {
    p.matrix = rotated;
    p.x += kick[0];
    p.y += kick[1];
    touchLock();
  }
}

function softDrop() {
  const p = state.piece;
  if (!collides(p.matrix, p.x, p.y + 1)) {
    p.y += 1;
    state.score += 1;
    state.dropAcc = 0;
    return true;
  }
  return false;
}

function ghostY() {
  const p = state.piece;
  let { y } = p;
  while (!collides(p.matrix, p.x, y + 1)) y += 1;
  return y;
}

function hardDrop() {
  const y = ghostY();
  state.score += (y - state.piece.y) * 2;
  state.piece.y = y;
  lock();
}

function holdPiece() {
  if (!state.canHold) return;
  const current = state.piece.type;
  if (state.hold) spawn(state.hold);
  else spawn();
  state.hold = current;
  state.canHold = false;
  updateHud();
}

function lock() {
  const p = state.piece;
  let toppedOut = true;
  p.matrix.forEach((row, y) => row.forEach((v, x) => {
    if (!v) return;
    const gy = p.y + y;
    if (gy >= 0) state.grid[gy][p.x + x] = p.type;
    if (gy >= HIDDEN) toppedOut = false;
  }));
  if (toppedOut) { gameOver(); return; }

  const full = [];
  state.grid.forEach((row, y) => { if (row.every(Boolean)) full.push(y); });
  if (full.length) {
    state.flash = { rows: full.map((y) => y - HIDDEN), t: 0 };
    full.forEach((y) => {
      state.grid.splice(y, 1);
      state.grid.unshift(Array(COLS).fill(null));
    });
    state.lines += full.length;
    state.score += LINE_SCORES[full.length] * state.level;
    state.level = Math.floor(state.lines / 10) + 1;
  }
  state.canHold = true;
  spawn();
  updateHud();
}

function gravityMs() {
  return Math.max(40, 800 * (0.83 ** (state.level - 1)));
}

function gameOver() {
  state.over = true;
  state.running = false;
  if (state.score > state.best) {
    state.best = state.score;
    writeBest(state.best);
  }
  updateHud();
  showOverlay('Game over', `Score ${state.score.toLocaleString()} · Lines ${state.lines}`, 'Play again');
}

// ---------- HUD & overlay ----------
function updateHud() {
  $('score').textContent = state.score.toLocaleString();
  $('level').textContent = state.level;
  $('lines').textContent = state.lines;
  $('best').textContent = Math.max(state.best, state.score).toLocaleString();
  drawMini(holdCanvas, state.hold, !state.canHold);
  drawMini(nextCanvas, state.queue[0]);
}

function showOverlay(title, text, btn) {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  startBtn.textContent = btn;
  overlay.hidden = false;
  let send = overlay.querySelector('.send');
  if (state.over && sdkActions?.sendText) {
    if (!send) {
      send = document.createElement('button');
      send.type = 'button';
      send.className = 'send';
      send.addEventListener('click', () => {
        sdkActions.sendText(`I scored ${state.score.toLocaleString()} points (${state.lines} lines) in Stacker!`);
      });
      startBtn.after(send);
    }
    send.textContent = 'Insert score into document';
  } else if (send) send.remove();
}

function start() {
  if (state.over || !state.running) {
    if (state.over || state.score === 0) reset();
  }
  state.running = true;
  state.paused = false;
  overlay.hidden = true;
  root.focus();
  last = performance.now();
}

function togglePause() {
  if (state.over || (!state.running && !state.paused)) return;
  state.paused = !state.paused;
  state.running = !state.paused;
  if (state.paused) showOverlay('Paused', 'Press P or Resume to continue.', 'Resume');
  else { overlay.hidden = true; root.focus(); last = performance.now(); }
}

// ---------- rendering ----------
let dpr = 1;
const ctx = boardCanvas.getContext('2d');

function resize() {
  dpr = window.devicePixelRatio || 1;
  const rect = boardCanvas.getBoundingClientRect();
  boardCanvas.width = Math.round(rect.width * dpr);
  boardCanvas.height = Math.round(rect.height * dpr);
  [holdCanvas, nextCanvas].forEach((c) => {
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * dpr);
    c.height = Math.round(r.height * dpr);
  });
  if (state.grid) updateHud();
}

function drawBlock(c, x, y, size, color, alpha = 1) {
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.fillRect(x + 1, y + 1, size - 2, size - 2);
  c.fillStyle = 'rgba(255,255,255,0.28)';
  c.fillRect(x + 1, y + 1, size - 2, Math.max(2, size * 0.18));
  c.fillStyle = 'rgba(0,0,0,0.22)';
  c.fillRect(x + 1, y + size - 1 - Math.max(2, size * 0.14), size - 2, Math.max(2, size * 0.14));
  c.globalAlpha = 1;
}

function draw(dt) {
  const w = boardCanvas.width / dpr;
  const h = boardCanvas.height / dpr;
  const cw = w / COLS;
  const ch = h / ROWS;
  const size = Math.min(cw, ch);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const styles = getComputedStyle(document.documentElement);
  ctx.strokeStyle = styles.getPropertyValue('--grid').trim() || '#20232c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < COLS; x += 1) {
    ctx.moveTo(x * size + 0.5, 0);
    ctx.lineTo(x * size + 0.5, h);
  }
  for (let y = 1; y < ROWS; y += 1) {
    ctx.moveTo(0, y * size + 0.5);
    ctx.lineTo(w, y * size + 0.5);
  }
  ctx.stroke();

  for (let y = HIDDEN; y < ROWS + HIDDEN; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const t = state.grid[y][x];
      if (t) drawBlock(ctx, x * size, (y - HIDDEN) * size, size, COLORS[t]);
    }
  }

  if (!state.over) {
    const p = state.piece;
    const gy = ghostY();
    p.matrix.forEach((row, y) => row.forEach((v, x) => {
      if (!v) return;
      const vy = gy + y - HIDDEN;
      if (vy >= 0) {
        ctx.strokeStyle = COLORS[p.type];
        ctx.globalAlpha = 0.55;
        ctx.strokeRect((p.x + x) * size + 2, vy * size + 2, size - 4, size - 4);
        ctx.globalAlpha = 1;
      }
    }));
    p.matrix.forEach((row, y) => row.forEach((v, x) => {
      const vy = p.y + y - HIDDEN;
      if (v && vy >= 0) drawBlock(ctx, (p.x + x) * size, vy * size, size, COLORS[p.type]);
    }));
  }

  if (state.flash) {
    state.flash.t += dt;
    const a = 1 - state.flash.t / 220;
    if (a <= 0) state.flash = null;
    else {
      ctx.fillStyle = `rgba(255,255,255,${a * 0.6})`;
      state.flash.rows.forEach((r) => ctx.fillRect(0, r * size, COLS * size, size));
    }
  }
}

function drawMini(canvas, type, dim = false) {
  const c = canvas.getContext('2d');
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (!type) return;
  const m = SHAPES[type];
  const cells = [];
  m.forEach((row, y) => row.forEach((v, x) => { if (v) cells.push([x, y]); }));
  const minX = Math.min(...cells.map((p) => p[0]));
  const maxX = Math.max(...cells.map((p) => p[0]));
  const minY = Math.min(...cells.map((p) => p[1]));
  const maxY = Math.max(...cells.map((p) => p[1]));
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const size = Math.floor(Math.min(w / 4.5, h / 2.8));
  const ox = (w - bw * size) / 2;
  const oy = (h - bh * size) / 2;
  const alpha = dim ? 0.35 : 1;
  cells.forEach(([x, y]) => {
    drawBlock(c, ox + (x - minX) * size, oy + (y - minY) * size, size, COLORS[type], alpha);
  });
}

// ---------- input ----------
const held = { left: false, right: false, soft: false };
let dasDir = 0;
let dasTimer = 0;
let arrTimer = 0;
let softTimer = 0;

function press(act) {
  if (!state.running) {
    if (act === 'pause') togglePause();
    return;
  }
  switch (act) {
    case 'left': move(-1); dasDir = -1; dasTimer = 0; arrTimer = 0; break;
    case 'right': move(1); dasDir = 1; dasTimer = 0; arrTimer = 0; break;
    case 'rotate': turn(1); break;
    case 'ccw': turn(-1); break;
    case 'soft': softDrop(); softTimer = 0; break;
    case 'hard': hardDrop(); break;
    case 'hold': holdPiece(); break;
    case 'pause': togglePause(); break;
    default:
  }
  updateHud();
}

const KEYMAP = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowDown: 'soft',
  ArrowUp: 'rotate',
  KeyX: 'rotate',
  KeyZ: 'ccw',
  Space: 'hard',
  KeyC: 'hold',
  ShiftLeft: 'hold',
  KeyP: 'pause',
  Escape: 'pause',
  KeyA: 'left',
  KeyD: 'right',
  KeyS: 'soft',
  KeyW: 'rotate',
};

document.addEventListener('keydown', (e) => {
  if ((e.code === 'Enter' || e.code === 'Space') && !overlay.hidden) {
    e.preventDefault();
    if (state.paused) togglePause(); else start();
    return;
  }
  const act = KEYMAP[e.code];
  if (!act) return;
  e.preventDefault();
  if (e.repeat) return; // we handle auto-repeat ourselves
  if (act === 'left') held.left = true;
  if (act === 'right') held.right = true;
  if (act === 'soft') held.soft = true;
  press(act);
});

document.addEventListener('keyup', (e) => {
  const act = KEYMAP[e.code];
  if (act === 'left') { held.left = false; if (dasDir === -1) dasDir = held.right ? 1 : 0; }
  if (act === 'right') { held.right = false; if (dasDir === 1) dasDir = held.left ? -1 : 0; }
  if (act === 'soft') held.soft = false;
});

// Touch / mouse buttons with hold-to-repeat
document.querySelectorAll('.pad button').forEach((btn) => {
  const { act } = btn.dataset;
  let timer = null;
  const stop = () => {
    clearTimeout(timer); clearInterval(timer); timer = null;
    if (act === 'left' || act === 'right') { held[act] = false; dasDir = 0; }
    if (act === 'soft') held.soft = false;
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    if (act === 'left' || act === 'right' || act === 'soft') held[act] = true;
    press(act);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', stop);
});

startBtn.addEventListener('click', () => {
  if (state.paused) togglePause(); else start();
});

// Auto-pause when the panel loses focus
window.addEventListener('blur', () => { if (state.running) togglePause(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.running) togglePause();
});

// ---------- main loop ----------

function update(dt) {
  // horizontal auto-repeat
  if (dasDir !== 0 && (dasDir === -1 ? held.left : held.right)) {
    dasTimer += dt;
    if (dasTimer >= DAS) {
      arrTimer += dt;
      while (arrTimer >= ARR) { arrTimer -= ARR; if (!move(dasDir)) break; }
    }
  }
  // soft drop repeat
  if (held.soft) {
    softTimer += dt;
    while (softTimer >= SOFT_DROP_MS) { softTimer -= SOFT_DROP_MS; softDrop(); }
  }
  // gravity
  if (onGround()) {
    state.lockTimer += dt;
    if (state.lockTimer >= LOCK_DELAY) lock();
  } else {
    state.dropAcc += dt;
    const g = gravityMs();
    while (state.dropAcc >= g) {
      state.dropAcc -= g;
      if (collides(state.piece.matrix, state.piece.x, state.piece.y + 1)) break;
      state.piece.y += 1;
    }
  }
  updateHud();
}

function frame(now) {
  const dt = Math.min(100, now - last);
  last = now;
  if (state.running && !state.paused) update(dt);
  draw(dt);
  requestAnimationFrame(frame);
}

// ---------- boot ----------
async function connectSdk() {
  try {
    // DA_SDK is a promise exposed by https://da.live/nx/utils/sdk.js
    const { default: DA_SDK } = await import('https://da.live/nx/utils/sdk.js');
    const timeout = new Promise((r) => { setTimeout(() => r(null), 2000); });
    const sdk = await Promise.race([DA_SDK, timeout]);
    sdkActions = sdk?.actions || null;
  } catch {
    sdkActions = null; // running outside Experience Workspace
  }
}

reset();
resize();
new ResizeObserver(resize).observe(document.querySelector('.board-wrap'));
requestAnimationFrame(frame);
connectSdk();
