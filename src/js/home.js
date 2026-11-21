/* =========================================================
   SLICE - src/js/home.js
   Modes: Daily (one word per date) and Zen (endless random words).
   Archive is still a placeholder.
   The file is laid out in sections; boot() is at the very bottom.
   ========================================================= */

const DATA_DIR = 'src/data/';
const MAX_GUESSES = 4;
const LAUNCH_DAY = Date.UTC(2026, 10, 21) / 86400000; // daily #1 = Nov 21, 2026

// Clue button: 0 -> letter counts, 1 -> hint, 2 -> reveal the word
const CLUE_LABELS = ['CLUE 1/3', 'HINT 2/3', 'REVEAL 3/3'];
const CLUE_TITLES = [
  'Show how many letters each part has',
  'Show the extra hint',
  'Give up and reveal the word',
];

const state = {
  mode: 'daily',   // 'daily' | 'zen'
  word: '',
  parts: [],
  clues: [],
  entry: null,
  guesses: [],
  slotState: [],   // 'green' | 'yellow' | null per part (best result so far)
  clueLevel: 0,
  revealed: false,
  armed: false,    // the reveal needs a confirming second click
  armTimer: null,
  over: false,
  won: false,
  busy: false,
  storageKey: null, // null = nothing saved (zen)
  recent: [],
  zenCount: 0,
};

const data = { games: {}, parts: {}, dict: new Set() };
let els = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------
   Deterministic clue selection (same word -> same clues)
   --------------------------------------------------------- */

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickClues(word, parts, partsDb) {
  return parts.map((part, i) => {
    const options = Array.isArray(partsDb[part]) && partsDb[part].length ? partsDb[part] : [part];
    let hashed = fnv1a(`${word}#${i}`);
    if (state.mode == "zen") {
      hashed += Math.floor(Date.now() / 1000);
    }
    return options[hashed % options.length];
  });
}

/* ---------------------------------------------------------
   Guess evaluation
   Green  = subword sits at the same distance from the left OR
            right end of the guess as in the hidden word.
   Yellow = subword is in the guess, but elsewhere.
   `cuts` = interior letter boundaries where the slash lands
            (the edges of every highlighted subword).
   --------------------------------------------------------- */

function partStarts(word, parts) {
  let cursor = 0;
  return parts.map((p) => {
    let s = word.indexOf(p, cursor);
    if (s === -1) s = word.indexOf(p);
    if (s !== -1) cursor = s + p.length;
    return s;
  });
}

function evaluate(guess, word, parts) {
  const starts = partStarts(word, parts);
  const letters = new Array(guess.length).fill(null);
  const partResults = parts.map(() => null);
  const cutSet = new Set();

  parts.forEach((part, i) => {
    const s = starts[i];
    if (s < 0) return;
    const rightHidden = word.length - (s + part.length);

    const occurrences = [];
    for (let from = 0, p; (p = guess.indexOf(part, from)) !== -1; from = p + 1) occurrences.push(p);
    if (!occurrences.length) return;

    const greens = occurrences.filter(
      (p) => p === s || guess.length - (p + part.length) === rightHidden
    );
    const status = greens.length ? 'green' : 'yellow';
    (greens.length ? greens : occurrences).forEach((p) => {
      for (let k = p; k < p + part.length; k++) {
        if (letters[k] !== 'green') letters[k] = status;
      }
      if (p > 0) cutSet.add(p);
      if (p + part.length < guess.length) cutSet.add(p + part.length);
    });
    partResults[i] = status;
  });

  return { letters, partResults, cuts: [...cutSet].sort((a, b) => a - b) };
}

/* ---------------------------------------------------------
   Word selection
   --------------------------------------------------------- */

function todaysPuzzle() {
  const d = new Date();
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  const n = day - LAUNCH_DAY;
  const keys = Object.keys(data.games).sort();
  const index = ((n % keys.length) + keys.length) % keys.length;
  return { word: keys[index], number: n + 1 };
}

// Random word not yet served this session; the pool resets once it is used up.
function randomWord() {
  const keys = Object.keys(data.games);
  let pool = keys.filter((k) => !state.recent.includes(k));
  if (!pool.length) {
    const last = state.recent[state.recent.length - 1];
    state.recent = last ? [last] : [];
    pool = keys.filter((k) => !state.recent.includes(k));
    if (!pool.length) pool = keys;
  }
  const word = pool[Math.floor(Math.random() * pool.length)];
  state.recent.push(word);
  return word;
}

function isValidWord(w) {
  if (w === state.word || data.games[w]) return true;
  if (data.dict.size === 0) return true; // dictionary not populated yet -> accept anything
  return data.dict.has(w);
}

/* ---------------------------------------------------------
   Rendering: guess list
   --------------------------------------------------------- */

function buildGrid() {
  els.grid.replaceChildren();
  for (let i = 0; i < MAX_GUESSES; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);
    const word = document.createElement('div');
    word.className = 'word';
    row.append(idx, word);
    els.grid.appendChild(row);
    paintRow(i, '');
  }
  updateActiveRow();
}

// Draw a row statically (typing preview, restore). `states` = per-letter state or null.
function paintRow(i, word, states = null, cuts = []) {
  const row = els.grid.children[i];
  const box = row.querySelector('.word');
  box.replaceChildren();
  row.classList.toggle('done', Boolean(states));
  if (!word) {
    const ph = document.createElement('span');
    ph.className = 'ph';
    ph.textContent = '- - - - -';
    box.appendChild(ph);
    return;
  }
  [...word].forEach((ch, k) => {
    const l = document.createElement('span');
    l.className = 'ltr';
    l.textContent = ch;
    if (states) l.dataset.state = states[k] || 'miss';
    if (cuts.includes(k + 1)) l.classList.add('cut-after');
    box.appendChild(l);
  });
}

function updateActiveRow() {
  [...els.grid.children].forEach((r, i) =>
    r.classList.toggle('is-active', !state.over && i === state.guesses.length)
  );
}

function previewTyping() {
  if (state.over || state.busy) return;
  const typed = els.input.value.toLowerCase().replace(/[^a-z]/g, '');
  paintRow(state.guesses.length, typed);
}

/* ---------------------------------------------------------
   Rendering: clue chips, hint, buttons, messages
   --------------------------------------------------------- */

function buildSlots() {
  els.slots.replaceChildren();
  state.parts.forEach((part, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const top = document.createElement('span');
    top.className = 'slot-top';
    top.textContent = `${part.length} LETTERS`;
    const clue = document.createElement('span');
    clue.className = 'slot-clue';
    clue.textContent = state.clues[i];
    slot.append(top, clue);
    els.slots.appendChild(slot);
  });
  updateSlots();
}

// In place, so the CSS fades run instead of the chips being rebuilt.
function updateSlots() {
  [...els.slots.children].forEach((slot, i) => {
    const st = state.won ? 'green' : state.slotState[i];
    if (st) slot.dataset.state = st; else delete slot.dataset.state;
    const top = slot.querySelector('.slot-top');
    if (state.over) {
      top.textContent = state.parts[i].toUpperCase();
      top.classList.add('show');
    } else {
      top.textContent = `${state.parts[i].length} LETTERS`;
      top.classList.toggle('show', state.clueLevel >= 1);
    }
  });
}

function popSlots(partResults) {
  [...els.slots.children].forEach((el, i) => {
    if (partResults[i]) {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
  });
}

function setMessage(text, kind = '') {
  els.msg.textContent = text;
  els.msg.className = 'msg' + (kind ? ` msg-${kind}` : '');
}

// The hint's space is always reserved in the layout; only its opacity changes.
function updateHint() {
  const show = state.clueLevel >= 2 && Boolean(state.entry?.clue);
  els.hint.textContent = show ? state.entry.clue : '';
  els.hint.classList.toggle('show', show);
}

function updateClueButton() {
  const b = els.clue;
  b.disabled = state.over;
  b.textContent = state.armed ? 'SURE?' : CLUE_LABELS[Math.min(state.clueLevel, 2)];
  b.title = state.over ? '' : CLUE_TITLES[state.clueLevel];
}

function applyEndState() {
  els.input.disabled = state.over;
  els.submit.disabled = state.over;
  els.next.classList.toggle('hidden', !(state.over && state.mode === 'zen'));
  updateSlots();
  updateHint();
  updateClueButton();
  updateActiveRow();
}

function setActiveMode() {
  [['daily', els.btnDaily], ['zen', els.btnZen]].forEach(([m, btn]) =>
    btn.setAttribute('aria-pressed', String(state.mode === m))
  );
}

/* ---------------------------------------------------------
   Slash flipbook: a curved, pixel-art blade swept across a
   small canvas, drawn frame by frame (8 frames).
   --------------------------------------------------------- */

const SLASH = { size: 28, frames: 8, frameMs: 42 };

function drawSlashFrame(ctx, f) {
  const N = SLASH.size;
  ctx.clearRect(0, 0, N, N);

  // blade path: quadratic curve, top-right -> bottom-left, bulging left
  const P0 = [21, 1], P1 = [4, 9], P2 = [9, 27];
  const at = (t) => {
    const u = 1 - t;
    return [u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
            u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1]];
  };

  const grow = Math.min(1, (f + 1) / 4);          // head travels in frames 0-3
  const tail = f < 4 ? 0 : (f - 3) / 5;          // tail catches up in frames 4-7
  const fade = f < 5 ? 1 : 1 - (f - 4) / 4;      // thins out at the end
  if (tail >= grow) return;

  const layers = [
    { grow: 2.2, color: 'rgba(217,115,154,.45)' }, // outer glow
    { grow: 1.0, color: '#f4c4d6' },               // mid
    { grow: 0,   color: '#ffffff' },               // core
  ];
  layers.forEach(({ grow: extra, color }) => {
    ctx.fillStyle = color;
    for (let t = tail; t <= grow; t += 0.01) {
      const [x, y] = at(t);
      const taper = Math.sin(Math.PI * Math.min(1, Math.max(0.08, t))); // thin at both ends
      const w = Math.max(1, Math.round((taper * 2.6 + extra) * fade));
      ctx.fillRect(Math.round(x - w / 2), Math.round(y - w / 2), w, w);
    }
  });

  // sparkle pixels trailing the blade
  if (f >= 2 && f <= 6) {
    ctx.fillStyle = '#fff';
    [[0.3, 3, -2], [0.55, -3, 2], [0.8, 2, 3]].forEach(([t, dx, dy], k) => {
      if (t <= grow && t >= tail && (f + k) % 2 === 0) {
        const [x, y] = at(t);
        ctx.fillRect(Math.round(x + dx), Math.round(y + dy), 1, 1);
      }
    });
  }
}

// Plays the flipbook on a canvas centred at `x` (px, relative to the row).
function playSlash(rowEl, x) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.className = 'slash';
    canvas.width = SLASH.size;
    canvas.height = SLASH.size;
    canvas.style.left = `${x}px`;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    rowEl.appendChild(canvas);

    let f = 0;
    drawSlashFrame(ctx, f);
    const timer = setInterval(() => {
      f += 1;
      if (f >= SLASH.frames) {
        clearInterval(timer);
        canvas.remove();
        resolve();
        return;
      }
      drawSlashFrame(ctx, f);
    }, SLASH.frameMs);
  });
}

/* ---------------------------------------------------------
   Reveal: no subword -> no animation. Subword -> slash the
   boundaries around it, split the word, then colour it.
   --------------------------------------------------------- */

async function revealRow(i, guess, result, win) {
  const rowEl = els.grid.children[i];
  paintRow(i, guess);
  rowEl.classList.add('done');
  const letters = [...rowEl.querySelectorAll('.ltr')];
  const states = win ? guess.split('').map(() => 'green') : result.letters;

  if (!states.some(Boolean)) {                 // nothing found: just mark it, no animation
    letters.forEach((l) => { l.dataset.state = 'miss'; });
    return;
  }

  const cuts = result.cuts;
  const colorAll = (stagger) => {
    letters.forEach((l, k) => setTimeout(() => { l.dataset.state = states[k] || 'miss'; }, k * stagger));
  };

  if (!cuts.length || reducedMotion()) {       // e.g. guess is exactly one part
    colorAll(reducedMotion() ? 0 : 50);
    await sleep(reducedMotion() ? 0 : letters.length * 50 + 250);
    return;
  }

  // measure cut positions before the split moves anything
  const rowBox = rowEl.getBoundingClientRect();
  const xs = cuts.map((c) => {
    const a = letters[c - 1].getBoundingClientRect();
    const b = letters[c].getBoundingClientRect();
    return (a.right + b.left) / 2 - rowBox.left;
  });

  const slashes = xs.map((x, n) => sleep(n * 150).then(() => playSlash(rowEl, x)));
  await sleep(150 * (cuts.length - 1) + 170); // blade lands

  cuts.forEach((c) => {
    letters[c - 1].classList.add('cut-after');
    letters.forEach((l, k) => l.classList.add(k < c ? 'jolt-l' : 'jolt-r'));
  });
  colorAll(55);
  await Promise.all(slashes);
  await sleep(letters.length * 55 + 120);
  letters.forEach((l) => l.classList.remove('jolt-l', 'jolt-r'));
}

/* ---------------------------------------------------------
   Game flow
   --------------------------------------------------------- */

function applyResult(result) {
  result.partResults.forEach((r, i) => {
    if (r === 'green' || (r === 'yellow' && state.slotState[i] !== 'green')) state.slotState[i] = r;
  });
}

function checkEnd(guess) {
  if (guess === state.word) {
    state.won = true;
    state.over = true;
    setMessage(`SLICED IT IN ${state.guesses.length}/${MAX_GUESSES}!`, 'win');
  } else if (state.guesses.length >= MAX_GUESSES) {
    state.over = true;
    setMessage(`THE WORD WAS ${state.word.toUpperCase()}`, 'lose');
  }
  applyEndState();
}

function flash(text) {
  setMessage(text, 'warn');
  const row = els.grid.children[state.guesses.length];
  if (row) {
    row.classList.remove('shake');
    void row.offsetWidth;
    row.classList.add('shake');
  }
}

async function submitGuess() {
  if (state.busy || state.over) return;
  const guess = els.input.value.trim().toLowerCase();

  if (guess.length < 2) return flash('TOO SHORT');
  if (!/^[a-z]+$/.test(guess)) return flash('LETTERS ONLY');
  if (state.guesses.includes(guess)) return flash('ALREADY TRIED THAT');
  if (!isValidWord(guess)) return flash('NOT IN THE DICTIONARY');

  state.busy = true;
  setMessage('');
  const idx = state.guesses.length;
  state.guesses.push(guess);
  els.input.value = '';

  const result = evaluate(guess, state.word, state.parts);
  const win = guess === state.word;
  await revealRow(idx, guess, result, win);

  applyResult(result);
  checkEnd(guess);
  popSlots(win ? state.parts.map(() => 'green') : result.partResults);
  save();

  state.busy = false;
  if (!state.over) els.input.focus();
}

/* ---------------------------------------------------------
   Clue button: counts -> hint -> reveal (second click to confirm)
   --------------------------------------------------------- */

function disarm() {
  clearTimeout(state.armTimer);
  state.armed = false;
}

function pressClue() {
  if (state.over || state.busy) return;

  if (state.clueLevel === 0) {
    state.clueLevel = 1;
    updateSlots();
  } else if (state.clueLevel === 1) {
    state.clueLevel = 2;
    updateHint();
  } else {
    if (!state.armed) {
      state.armed = true;
      state.armTimer = setTimeout(() => { state.armed = false; updateClueButton(); }, 2500);
      updateClueButton();
      return;
    }
    disarm();
    state.revealed = true;
    state.over = true;
    setMessage(`THE WORD WAS ${state.word.toUpperCase()}`, 'lose');
    applyEndState();
    save();
    return;
  }
  updateClueButton();
  save();
}

/* ---------------------------------------------------------
   Persistence (daily only)
   --------------------------------------------------------- */

function save() {
  if (!state.storageKey) return;
  try {
    localStorage.setItem(state.storageKey, JSON.stringify({
      guesses: state.guesses,
      clueLevel: state.clueLevel,
      revealed: state.revealed,
    }));
  } catch (_) {}
}

function restore() {
  if (!state.storageKey) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(state.storageKey)); } catch (_) {}
  if (!saved?.guesses) return;

  state.clueLevel = Math.max(0, Math.min(2, saved.clueLevel | 0));
  saved.guesses.forEach((g) => {
    const idx = state.guesses.length;
    state.guesses.push(g);
    const result = evaluate(g, state.word, state.parts);
    const win = g === state.word;
    paintRow(idx, g, win ? g.split('').map(() => 'green') : result.letters.map((l) => l || 'miss'),
      result.letters.some(Boolean) || win ? result.cuts : []);
    applyResult(result);
    if (win || state.guesses.length >= MAX_GUESSES) checkEnd(g);
  });
  if (saved.revealed && !state.over) {
    state.revealed = true;
    state.over = true;
    setMessage(`THE WORD WAS ${state.word.toUpperCase()}`, 'lose');
  }
  applyEndState();
}

/* ---------------------------------------------------------
   Starting rounds
   --------------------------------------------------------- */

function startGame(word, storageKey) {
  disarm();
  const entry = data.games[word];
  Object.assign(state, {
    word,
    entry,
    parts: entry.parts,
    clues: pickClues(word, entry.parts, data.parts),
    guesses: [],
    slotState: entry.parts.map(() => null),
    clueLevel: 0,
    revealed: false,
    over: false,
    won: false,
    busy: false,
    storageKey,
  });
  els.input.value = '';
  buildGrid();
  buildSlots();
  setMessage('');
  applyEndState();
  restore();
  setActiveMode();
  if (!state.over) els.input.focus();
}

function startDaily() {
  state.mode = 'daily';
  const { word, number } = todaysPuzzle();
  els.puzzle.textContent = `DAILY #${number}`;
  startGame(word, `slice:daily:${number}`);
}

function startZen() {
  state.mode = 'zen';
  state.zenCount += 1;
  els.puzzle.textContent = `ZEN #${state.zenCount}`;
  startGame(randomWord(), null);
}

/* ---------------------------------------------------------
   Data loading: every JSON file lives under src/data/
   --------------------------------------------------------- */

async function loadJSON(file, optional = false) {
  try {
    const res = await fetch(DATA_DIR + file);
    if (!res.ok) throw new Error(`${DATA_DIR}${file}: ${res.status}`);
    return await res.json();
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

/* =========================================================
   Scenery: pixel-sprite helpers
   Every sprite is painted on a small grid (Pix), then turned
   into an inline SVG of merged 1-cell-tall rects.
   ========================================================= */

function rng(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class Pix {
  constructor(w, h) { this.w = w; this.h = h; this.c = new Array(w * h).fill(null); }
  set(x, y, col) {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.c[y * this.w + x] = col;
  }
  rect(x, y, w, h, col) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, col);
  }
  line(x0, y0, x1, y1, th, col) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 || 1;
    for (let s = 0; s <= n; s++) {
      const t = s / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (let a = 0; a < th; a++) for (let b = 0; b < th; b++) this.set(x - th / 2 + a, y - th / 2 + b, col);
    }
  }
  svg(scale, style = '') {
    let out = '';
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const col = this.c[y * this.w + x];
        if (!col) { x++; continue; }
        let e = x + 1;
        while (e < this.w && this.c[y * this.w + e] === col) e++;
        out += `<rect x="${x}" y="${y}" width="${e - x}" height="1" fill="${col}"/>`;
        x = e;
      }
    }
    return `<svg viewBox="0 0 ${this.w} ${this.h}" width="${this.w * scale}" height="${this.h * scale}" ` +
      `style="${style}" shape-rendering="crispEdges">${out}</svg>`;
  }
}

/* ---------- Cherry tree: curved bark trunk, branches, lit blossom clusters ---------- */
function cherryTree(seed) {
  const W = 76, H = 92, r = rng(seed), p = new Pix(W, H);
  const bark = { l: '#80594a', m: '#5c3d31', d: '#37221b' };
  const cx = 38, trunkTop = 48;
  let topX = cx;

  for (let y = H - 1; y >= trunkTop; y--) {
    const t = (H - 1 - y) / (H - 1 - trunkTop);
    const x = cx + Math.sin(t * 2.4 + seed) * 4 * t;
    const flare = y > H - 8 ? (y - (H - 8)) : 0;
    const th = Math.max(3, Math.round(8 - 4 * t)) + flare;
    const x0 = Math.round(x - th / 2);
    p.rect(x0, y, th, 1, bark.m);
    p.set(x0, y, bark.l); p.set(x0 + 1, y, th > 5 ? bark.l : bark.m);
    p.set(x0 + th - 1, y, bark.d);
    if (r() < 0.12) p.set(x0 + 2 + Math.floor(r() * Math.max(1, th - 4)), y, bark.d);
    topX = x;
  }

  const clusters = [
    [-26, 46, 12], [26, 44, 12], [-31, 31, 10], [31, 29, 10], [-15, 32, 15],
    [16, 28, 15], [-4, 40, 13], [0, 14, 15], [-14, 17, 11], [14, 10, 10],
  ];
  clusters.forEach(([dx, cy]) => {
    p.line(topX, trunkTop + 6, cx + dx, cy + 5, 2, bark.m);
    p.line(topX + 1, trunkTop + 6, cx + dx + 1, cy + 5, 1, bark.d);
  });

  const tones = ['#9a3d64', '#bf5a82', '#df7ca2', '#f2a3c1', '#fbcfe0', '#fff0f6'];
  clusters.slice().sort((a, b) => b[1] - a[1]).forEach(([dx, cy, rad]) => {
    const ccx = cx + dx;
    for (let y = cy - rad - 2; y <= cy + rad + 2; y++) {
      for (let x = ccx - rad - 2; x <= ccx + rad + 2; x++) {
        const ddx = x - ccx, ddy = (y - cy) * 1.1, d = Math.hypot(ddx, ddy);
        if (d >= rad * (0.72 + 0.3 * r())) continue;
        if (d > rad * 0.62 && r() < 0.06) continue;               // gaps showing branch / sky
        const light = (-ddx * 0.5 - ddy * 0.8) / rad;              // light from the top-left
        let i = Math.round(2.3 + light * 2.2 + (r() - 0.5) * 1.6);
        if (d > rad * 0.7 && ddy > 0) i -= 1;                      // darker underside
        p.set(x, y, tones[clamp(i, 0, 5)]);
      }
    }
  });
  for (let n = 0; n < 40; n++) {                                  // blossom sparkles
    const x = Math.floor(8 + r() * 60), y = Math.floor(2 + r() * 54), i = p.c[y * W + x];
    if (i === tones[3] || i === tones[4]) p.set(x, y, tones[5]);
  }
  return p;
}

/* ---------- Five-tier pagoda ---------- */
function pagoda(tiers = 5) {
  const W = 68, tierH = 13, baseH = 5, topH = 20;
  const H = baseH + tiers * tierH + topH, p = new Pix(W, H), cx = W / 2;
  const C = { roof: '#34445c', hi: '#5f7391', dk: '#1f2a3c', wall: '#cdb99a', wallDk: '#a89577',
    wood: '#7a3a2e', woodDk: '#4b2620', shadow: '#241a22', gold: '#cfa94a', stone: '#6a6578', stoneHi: '#8a849a' };

  p.rect(2, H - baseH, W - 4, baseH, C.stone);
  p.rect(2, H - baseH, W - 4, 1, C.stoneHi);

  for (let i = 0; i < tiers; i++) {
    const bw = 40 - i * 5, x0 = Math.round(cx - bw / 2);
    const yb = H - baseH - i * tierH;            // bottom row (exclusive) of this tier's body
    const bodyTop = yb - 8, roofTop = yb - 13;

    p.rect(x0, bodyTop, bw, 8, C.wall);          // plaster + shoji lattice
    for (let x = x0 + 3; x < x0 + bw - 3; x += 3) p.rect(x, bodyTop + 1, 1, 6, C.wallDk);
    p.rect(x0, yb - 1, bw, 1, C.wallDk);
    p.rect(x0, bodyTop, bw, 1, C.woodDk);        // rails
    p.rect(x0, bodyTop + 7, bw, 1, C.woodDk);
    [x0, x0 + bw - 2, Math.round(cx) - 1].forEach((x) => p.rect(x, bodyTop, 2, 8, C.wood));
    p.rect(Math.round(cx) - 2, bodyTop + 2, 4, 4, C.shadow);           // doorway
    p.rect(Math.round(cx) - 1, bodyTop + 3, 2, 2, '#e8b25a');          // lit window

    const widths = [bw + 2, bw + 7, bw + 11, bw + 15, bw + 15];
    widths.forEach((w, k) => {
      const rx = Math.round(cx - w / 2), y = roofTop + k;
      const col = k === 0 ? C.hi : k < 3 ? C.roof : k === 3 ? C.dk : C.shadow;
      p.rect(rx, y, w, 1, col);
      if (k === 1 || k === 2) for (let x = rx + 2; x < rx + w - 2; x += 4) p.set(x, y, C.dk);
      if (k === 4) { p.set(rx - 1, y - 1, C.roof); p.set(rx - 2, y - 2, C.hi); p.set(rx + w, y - 1, C.roof); p.set(rx + w + 1, y - 2, C.hi); }
    });
    p.rect(Math.round(cx - (bw + 15) / 2), roofTop + 3, bw + 15, 1, '#8c3b36'); // red fascia
  }

  const topY = H - baseH - tiers * tierH - 8;
  p.rect(Math.round(cx), topY - 14, 1, 14, '#9aa0ad');
  [2, 5, 8, 11].forEach((o) => p.rect(Math.round(cx) - 1, topY - 14 + o, 3, 1, C.gold));
  p.rect(Math.round(cx) - 1, topY - 17, 3, 3, C.gold);
  return p;
}

/* ---------- Torii gate ---------- */
function torii() {
  const W = 58, H = 52, p = new Pix(W, H);
  const red = '#a23d37', redHi = '#c4584d', redDk = '#6f2822', blk = '#2a2227';
  [9, 44].forEach((x) => {
    p.rect(x, 12, 5, H - 12, red); p.rect(x, 12, 1, H - 12, redHi); p.rect(x + 4, 12, 1, H - 12, redDk);
    p.rect(x - 1, H - 5, 7, 5, blk);
  });
  p.rect(5, 20, 48, 3, red); p.rect(5, 20, 48, 1, redHi); p.rect(5, 22, 48, 1, redDk);   // nuki
  p.rect(26, 23, 6, 8, blk); p.rect(27, 24, 4, 6, '#caa24a');                               // plaque
  p.rect(3, 11, 52, 3, red); p.rect(3, 13, 52, 1, redDk);                                   // shimaki
  p.rect(2, 7, 54, 4, blk);                                                                 // kasagi
  p.rect(0, 5, 6, 3, blk); p.rect(52, 5, 6, 3, blk); p.rect(0, 3, 3, 3, blk); p.rect(55, 3, 3, 3, blk);
  p.rect(6, 7, 46, 1, '#4a4047');
  return p;
}

/* ---------- Shrine hall with hip roof, red pillars, lit doorway ---------- */
function shrine() {
  const W = 94, H = 70, p = new Pix(W, H);
  const C = { red: '#a23d37', redDk: '#6f2822', wall: '#d2c4aa', wallDk: '#a8967a', wood: '#5a3a2e',
    roof: '#34445c', hi: '#5f7391', dk: '#1f2a3c', patina: '#4d7a6c', stone: '#6a6578', stoneHi: '#8a849a' };

  [[34, 6, 26], [37, 9, 20], [40, 12, 14]].forEach(([x, dy, w]) => {            // steps
    p.rect(x, H - dy, w, 3, C.stone); p.rect(x, H - dy, w, 1, C.stoneHi);
  });
  p.rect(6, H - 17, 82, 4, C.wood); p.rect(6, H - 17, 82, 1, '#7d553f');          // veranda
  p.rect(10, H - 36, 74, 19, C.wall);                                             // plaster walls
  for (let x = 14; x < 82; x += 4) p.rect(x, H - 34, 1, 15, C.wallDk);            // shoji lattice
  for (let y = H - 31; y < H - 19; y += 4) p.rect(11, y, 72, 1, C.wallDk);
  p.rect(37, H - 34, 20, 17, '#241a22');                                          // doorway
  p.rect(39, H - 32, 16, 13, '#3a2a28');
  p.rect(45, H - 30, 4, 5, '#e8b25a');                                            // shrine lamp
  [10, 27, 44, 61, 80].forEach((x) => { p.rect(x, H - 36, 3, 19, C.red); p.rect(x + 2, H - 36, 1, 19, C.redDk); });

  const rows = 15;
  for (let k = 0; k < rows; k++) {                                               // hip roof
    const y = H - 37 - k, inset = Math.round(k * 1.75), x = inset, w = W - inset * 2;
    const col = k < 2 ? C.dk : k > rows - 3 ? C.hi : (k % 5 === 4 ? C.dk : C.roof);
    p.rect(x, y, w, 1, col);
    if (k > 1 && k < rows - 2) for (let t = x + 3; t < x + w - 2; t += 5) p.set(t, y, C.dk);
  }
  p.rect(0, H - 38, 94, 1, C.dk); p.rect(0, H - 37, 94, 1, '#241a22');
  p.set(-0, H - 40, C.hi); p.set(1, H - 39, C.roof); p.set(W - 1, H - 40, C.hi); p.set(W - 2, H - 39, C.roof); // upturned eaves
  p.rect(26, H - 53, 42, 1, C.patina);                                            // patina ridge
  p.line(25, H - 60, 29, H - 53, 1, '#c9bfae'); p.line(29, H - 60, 25, H - 53, 1, '#c9bfae');   // chigi
  p.line(65, H - 60, 69, H - 53, 1, '#c9bfae'); p.line(69, H - 60, 65, H - 53, 1, '#c9bfae');
  return p;
}

/* ---------- Stone lantern (toro) ---------- */
function stoneLantern() {
  const p = new Pix(14, 28);
  const s = '#7b768a', hi = '#9e99ae', dk = '#4f4a5e';
  p.rect(3, 23, 8, 5, s); p.rect(3, 23, 8, 1, hi); p.rect(10, 23, 1, 5, dk);
  p.rect(6, 15, 2, 8, s); p.rect(6, 15, 1, 8, hi);
  p.rect(3, 9, 8, 6, s); p.rect(3, 9, 8, 1, hi); p.rect(10, 9, 1, 6, dk);
  p.rect(5, 10, 4, 4, '#f0b45a'); p.rect(6, 11, 2, 2, '#fff0c0');
  p.rect(0, 6, 14, 3, s); p.rect(0, 6, 14, 1, hi); p.rect(13, 6, 1, 3, dk);
  p.rect(3, 3, 8, 3, s); p.rect(6, 0, 2, 3, hi);
  return p;
}

/* ---------- Grass tufts, ferns and boulders ---------- */
function tuft(seed, tones) {
  const r = rng(seed), p = new Pix(16, 14);
  for (let b = 0; b < 7; b++) {
    const bx = 2 + b * 2 + Math.floor(r() * 2), len = 5 + Math.floor(r() * 8), lean = (r() - 0.5) * 7;
    p.line(bx, 13, bx + lean, 13 - len, 1, tones[b % tones.length]);
  }
  return p;
}

function boulder(seed, w, h) {
  const r = rng(seed), p = new Pix(w, h);
  const tones = ['#2a2736', '#3a3648', '#4b4660', '#5f5a76'];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2 + 0.5) / (w / 2), dy = (y - h + 1) / h;
      if (dx * dx + dy * dy * 1.0 > 1) continue;
      const light = -dx * 0.5 - (y / h) * 0.2 + 0.5;
      p.set(x, y, tones[clamp(Math.round(light * 2.6 + (r() - 0.5) * 0.8), 0, 3)]);
    }
  }
  for (let x = 2; x < w - 2; x++) if (r() < 0.8) p.set(x, Math.round(h * 0.28 + Math.sin(x) * 0.7), '#3f7a4e'); // moss cap
  return p;
}

/* ---------- Mountains (Fuji-like cone + ridgeline) and rolling hills ---------- */
function mountains(seed, W = 430, H = 62) {
  const r = rng(seed), p = new Pix(W, H), fx = Math.round(W * 0.62);
  const ph = [r() * 6, r() * 6, r() * 6];
  for (let x = 0; x < W; x++) {
    let h = 15 + 6 * Math.sin(x * 0.045 + ph[0]) + 4 * Math.sin(x * 0.11 + ph[1]) + 2 * Math.sin(x * 0.31 + ph[2]);
    const fuji = 46 - Math.abs(x - fx) * 0.6;
    h = Math.max(h, fuji + (r() < 0.3 ? 1 : 0));
    const top = Math.round(H - h);
    for (let y = top; y < H; y++) p.set(x, y, y < top + 4 ? '#6a65a4' : y < top + 14 ? '#5a5694' : '#4b4880');
    p.set(x, top, '#9a95cf');
    if (fuji > 34) {
      const snow = Math.round((fuji - 34) * 1.1 + Math.sin(x * 0.9) * 1.6 + r() * 1.2);
      for (let y = top; y < top + snow; y++) p.set(x, y, y === top ? '#eef0fb' : y < top + snow - 1 ? '#cdd0ea' : '#9ea2cf');
    }
  }
  return p;
}

function hills(seed, W = 430, H = 40, tones = ['#27494a', '#1f3d3e', '#18302f']) {
  const r = rng(seed), p = new Pix(W, H), ph = [r() * 6, r() * 6];
  for (let x = 0; x < W; x++) {
    const h = 16 + 7 * Math.sin(x * 0.03 + ph[0]) + 4 * Math.sin(x * 0.09 + ph[1]) + (r() < 0.12 ? 1 : 0);
    const top = Math.round(H - h);
    for (let y = top; y < H; y++) p.set(x, y, y < top + 3 ? tones[0] : y < top + 12 ? tones[1] : tones[2]);
    if (r() < 0.05) for (let k = 1; k < 5; k++) p.set(x, top - k, tones[0]);   // pine / bamboo tips
  }
  return p;
}

/* ---------- Cliff with a notch the waterfall spills over ---------- */
function cliff(seed) {
  const W = 64, H = 72, r = rng(seed), p = new Pix(W, H), n0 = 26, n1 = 37, notchTop = 16;
  const tones = ['#383450', '#48435f', '#5b5675', '#746e92'];
  for (let x = 0; x < W; x++) {
    let top = 9 + Math.round(Math.sin(x * 0.35 + seed) * 3 + Math.sin(x * 0.13) * 4);
    if (x >= n0 && x <= n1) top = notchTop;
    const shade = x < W * 0.4 ? 3 : x < W * 0.72 ? 2 : 1;
    for (let y = top; y < H; y++) {
      const strata = (y + (x >> 2)) % 9 === 0 ? 1 : 0;
      p.set(x, y, tones[clamp(shade - strata + (r() < 0.18 ? 1 : 0), 0, 3)]);
    }
    p.set(x, top, '#4a8a58'); if (r() < 0.6) p.set(x, top - 1, '#336b43'); if (r() < 0.25) p.set(x, top - 2, '#2a5a38');
  }
  return { p, n0, n1, notchTop };
}

/* =========================================================
   Scenery: scene assembly
   Layers (back -> front): stars, mountains, far temples + hills,
   far bamboo, waterfalls, mid bamboo, cherry trees, shrine /
   pagoda / torii, near bamboo, ground details, particles.
   ========================================================= */

const GROUND = 36; // px height of the ground strip

function buildScenery() {
  const r = rng(20261121);
  const between = (a, b) => a + r() * (b - a);
  const host = (id) => document.getElementById(id);
  const add = (id, html) => host(id).insertAdjacentHTML('beforeend', html);
  const sprite = (id, pix, scale, pos, extra = '') => add(id, pix.svg(scale, `${pos};${extra}`));

  /* ----- sky ----- */
  let stars = '';
  for (let i = 0; i < 46; i++) {
    stars += `<div class="star" style="left:${between(0, 100).toFixed(1)}%;top:${between(1, 42).toFixed(1)}%;` +
      `width:${r() > 0.8 ? 3 : 2}px;height:${r() > 0.8 ? 3 : 2}px;--dur:${between(2, 5).toFixed(1)}s;--delay:-${between(0, 5).toFixed(1)}s"></div>`;
  }
  add('stars', stars);

  /* ----- distant mountains (Fuji-like cone, snow cap) ----- */
  sprite('L-mount', mountains(11), 6, `left:50%;margin-left:-1290px;bottom:calc(${GROUND}px + 14vh)`);

  /* ----- far temples on hazy hills ----- */
  const faded = 'filter:brightness(.5) saturate(.6);opacity:.8';
  sprite('L-far', pagoda(5), 2, `left:30%;bottom:${GROUND + 70}px`, faded);
  sprite('L-far', pagoda(3), 2, `left:70%;bottom:${GROUND + 66}px`, faded);
  sprite('L-far', shrine(), 2, `left:52%;bottom:${GROUND + 58}px`, faded);
  add('L-far', `<div class="haze" style="bottom:${GROUND + 40}px"></div>`);
  sprite('L-far', hills(21), 6, `left:50%;margin-left:-1290px;bottom:${GROUND - 6}px`);
  sprite('L-far', hills(22, 430, 30, ['#2c5a4a', '#224a3c', '#183a2f']), 6, `left:50%;margin-left:-1290px;bottom:${GROUND - 14}px`);

  /* ----- bamboo + leaves ----- */
  const stalks = (id, count, cls, wRange, hRange, seg, leaves) => {
    let html = '';
    for (let i = 0; i < count; i++) {
      const w = Math.round(between(...wRange) / 2) * 2;
      let kids = '';
      for (let k = 0; k < leaves; k++) {
        const side = r() > 0.5;
        kids += `<div class="leaf${side ? '' : ' l'}" style="top:${(8 + r() * 70).toFixed(0)}%;${side ? 'left:100%' : 'right:100%'}"></div>`;
      }
      html += `<div class="stalk ${cls}" style="left:${(((i + r() * 0.9) / count) * 100).toFixed(2)}%;width:${w}px;` +
        `height:${between(...hRange).toFixed(1)}vh;--seg:${seg + Math.round(r() * 3) * 8}px;` +
        `--dur:${between(4, 8).toFixed(1)}s;--delay:-${between(0, 6).toFixed(1)}s">${kids}</div>`;
    }
    add(id, html);
  };
  stalks('bamboo-far', 52, 'stalk-far', [8, 14], [24, 46], 40, 1);
  stalks('bamboo-mid', 30, 'stalk-mid', [14, 22], [40, 72], 56, 2);
  stalks('bamboo-near', 11, 'stalk-near', [22, 34], [84, 120], 80, 3);
  stalks('bamboo-mid', 16, 'stalk-mid', [10, 16], [12, 28], 36, 2);   // young shoots low in the grove

  /* ----- waterfalls (cliff + animated falling water + mist + pool) ----- */
  const waterfall = (leftCss, S, seed, extra = '') => {
    const c = cliff(seed), w = c.p.w * S, h = c.p.h * S;
    const fx = (c.n0 + 1) * S, fw = (c.n1 - c.n0 - 1) * S, ft = c.notchTop * S;
    add('L-water',
      `<div class="prop" style="left:${leftCss};bottom:${GROUND - 4}px;width:${w}px;height:${h}px;${extra}">` +
        c.p.svg(S, 'position:absolute;left:0;top:0') +
        `<div class="fall" style="left:${fx}px;top:${ft}px;width:${fw}px;height:${h - ft - 4 * S}px"></div>` +
        `<div class="pool" style="left:${fx - 10 * S}px;bottom:0;width:${fw + 20 * S}px"></div>` +
        `<div class="fall-mist" style="left:${fx - 6 * S}px;bottom:${3 * S}px;width:${fw + 12 * S}px"></div>` +
      `</div>`);
  };
  waterfall('17%', 3, 5);
  waterfall('71%', 2, 9, 'filter:brightness(.75)');

  /* ----- cherry trees ----- */
  sprite('L-trees', cherryTree(3), 2, `left:36%;bottom:${GROUND}px`, 'filter:brightness(.75)');
  sprite('L-trees', cherryTree(8), 2, `left:30%;bottom:${GROUND}px`, 'filter:brightness(.85)');
  sprite('L-trees', cherryTree(14), 4, `left:-3%;bottom:${GROUND}px`);
  sprite('L-trees', cherryTree(19), 3, `right:30%;bottom:${GROUND}px`);
  sprite('L-trees', cherryTree(27), 4, `right:-5%;bottom:${GROUND}px`);

  /* ----- shrine, pagoda, torii, lanterns ----- */
  const glow = (css) => add('L-front',
    `<div class="lantern-glow" style="position:absolute;${css};width:70px;height:70px;border-radius:50%;` +
    `background:radial-gradient(circle, rgba(246,184,92,.55), transparent 68%)"></div>`);
  sprite('L-front', shrine(), 3, `left:1%;bottom:${GROUND - 4}px`);
  sprite('L-front', stoneLantern(), 3, `left:31%;bottom:${GROUND - 2}px`);
  glow(`left:calc(31% - 12px);bottom:${GROUND + 40}px`);
  sprite('L-front', torii(), 3, `right:22%;bottom:${GROUND - 3}px`);
  sprite('L-front', stoneLantern(), 3, `right:21%;bottom:${GROUND - 2}px`);
  sprite('L-front', stoneLantern(), 3, `right:42%;bottom:${GROUND - 2}px`);
  glow(`right:calc(42% - 14px);bottom:${GROUND + 40}px`);
  sprite('L-front', pagoda(5), 3, `right:4%;bottom:${GROUND - 4}px`);

  /* ----- ground: strip, stepping stones, boulders, tufts ----- */
  add('L-ground',
    `<div style="position:absolute;left:0;right:0;bottom:0;height:${GROUND}px;` +
    `background:linear-gradient(180deg,#26513a 0 6px,#1c3d2c 6px 14px,#142e22 14px);` +
    `border-top:3px solid #3a7a4c"></div>`);
  for (let i = 0; i < 9; i++) {                                    // path stones toward the torii
    add('L-ground', `<div style="position:absolute;right:${(22 + i * 2.2 + r()).toFixed(1)}%;bottom:${6 + Math.round(r() * 10)}px;` +
      `width:${16 + Math.round(r() * 10)}px;height:6px;background:#6a6578;border-top:2px solid #8a849a"></div>`);
  }
  [[12, 4], [47, 3], [78, 4], [93, 3]].forEach(([left, s], i) =>
    sprite('L-ground', boulder(40 + i, 14 + (i % 3) * 4, 10 + (i % 2) * 4), s, `left:${left}%;bottom:${GROUND - 8}px`));
  const tones = [['#2e7a46', '#3d9a5a', '#245f38'], ['#4a8a3a', '#62a84c', '#386b2e'], ['#2a6a50', '#3a8a68', '#1f523e']];
  for (let i = 0; i < 40; i++) {
    sprite('L-ground', tuft(100 + i, tones[i % 3]), r() > 0.5 ? 3 : 2,
      `left:${between(0, 98).toFixed(1)}%;bottom:${GROUND - 12 + Math.round(r() * 10)}px`);
  }

  /* ----- sakura petals + floating white pixels ----- */
  let petals = '';
  for (let i = 0; i < 28; i++) {
    const size = r() > 0.5 ? 6 : 4;
    petals += `<div class="petal" style="left:${between(0, 100).toFixed(1)}%;width:${size}px;height:${size - 2}px;` +
      `--dur:${between(10, 20).toFixed(1)}s;--delay:-${between(0, 20).toFixed(1)}s;--drift:${-Math.round(between(10, 40))}vw"></div>`;
  }
  add('petals', petals);
  let motes = '';
  for (let i = 0; i < 45; i++) {
    const size = r() > 0.7 ? 3 : 2;
    motes += `<div class="mote" style="left:${between(0, 100).toFixed(1)}%;top:${between(8, 95).toFixed(1)}%;` +
      `width:${size}px;height:${size}px;--dur:${between(6, 14).toFixed(1)}s;--delay:-${between(0, 14).toFixed(1)}s;` +
      `--dx:${Math.round(between(-40, 40))}px;--dy:${-Math.round(between(60, 160))}px"></div>`;
  }
  add('motes', motes);
}

/* =========================================================
   Boot
   ========================================================= */

async function boot() {
  els = {
    grid: document.getElementById('grid'),
    slots: document.getElementById('slots'),
    input: document.getElementById('guess'),
    submit: document.getElementById('submit'),
    msg: document.getElementById('message'),
    hint: document.getElementById('hint'),
    puzzle: document.getElementById('puzzle-no'),
    form: document.getElementById('guess-form'),
    clue: document.getElementById('btn-clue'),
    next: document.getElementById('btn-next'),
    btnDaily: document.getElementById('btn-daily'),
    btnZen: document.getElementById('btn-zen'),
    btnArchive: document.getElementById('btn-archive'),
  };

  buildScenery();

  try {
    [data.games, data.parts] = await Promise.all([loadJSON('games.json'), loadJSON('parts.json')]);
    const dict = await loadJSON('dictionary.json', true);
    data.dict = new Set((Array.isArray(dict) ? dict : []).map((w) => String(w).toLowerCase()));
  } catch (err) {
    console.error(err);
    buildGrid();
    setMessage('COULD NOT LOAD GAME DATA (serve over http)', 'lose');
    els.input.disabled = true;
    els.submit.disabled = true;
    els.clue.disabled = true;
    return;
  }

  els.form.addEventListener('submit', (e) => { e.preventDefault(); submitGuess(); });
  els.input.addEventListener('input', previewTyping);
  els.clue.addEventListener('click', pressClue);
  els.next.addEventListener('click', () => { if (!state.busy) startZen(); });

  els.btnDaily.addEventListener('click', () => {
    if (state.busy || state.mode === 'daily') return;
    startDaily();
  });
  els.btnZen.addEventListener('click', () => {
    if (state.busy) return;
    if (state.mode === 'zen' && !state.over) return setMessage('FINISH THIS WORD FIRST', 'warn');
    startZen();
  });
  els.btnArchive.addEventListener('click', () => setMessage('ARCHIVE COMING SOON', 'warn'));

  startDaily();
}

if (typeof document !== 'undefined') boot();