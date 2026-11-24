/* =========================================================
   SLICE - src/js/home.js
   Modes:  Daily   one word per date (builds your streak)
           Archive replay any past day (no streak)
           Zen     endless random words
   Layout: core logic -> sound -> sage quotes -> UI -> slash ->
           game flow -> views (results / archive) -> persistence
           -> scenery sprites -> scene + sage sprite -> boot()
   ========================================================= */

const DATA_DIR = 'src/data/';
const MAX_GUESSES = 4;
const FIRST_DAY = Date.UTC(2026, 10, 20) / 86400000;   // puzzle #1 = Nov 20, 2026
const KEY = {
  stats: 'slice:v2:stats',
  puzzle: (n) => `slice:v2:p:${n}`,
  sfx: 'slice:v2:sfx',
};

// Clue button: 0 -> letter counts, 1 -> hint, 2 -> reveal the word
const CLUE_LABELS = ['CLUE 1/3', 'HINT 2/3', 'REVEAL 3/3'];
const CLUE_TITLES = [
  'Show how many letters each part has',
  'Show the extra hint',
  'Give up and reveal the word',
];

const state = {
  mode: 'daily',    // 'daily' | 'archive' | 'zen'
  view: 'game',     // 'game' | 'results' | 'archive'
  puzzle: 1,        // puzzle number (daily / archive)
  round: 0,         // bumps on every new round (guards delayed callbacks)
  word: '',
  parts: [],
  clues: [],
  entry: null,
  guesses: [],
  slotState: [],    // 'green' | 'yellow' | null per part (best result so far)
  clueLevel: 0,
  revealed: false,
  armed: false,     // the reveal needs a confirming second click
  armTimer: null,
  over: false,
  won: false,
  busy: false,
  counted: false,   // daily result already added to the stats
  storageKey: null, // null = nothing saved (zen)
  recent: [],
  zenCount: 0,
};

const data = { games: {}, parts: {}, dict: new Set() };
let els = {};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} },
};

/* ---------------------------------------------------------
   Days, puzzles and stats
   --------------------------------------------------------- */

const dayNumber = (d = new Date()) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
const todayNum = () => Math.max(1, dayNumber() - FIRST_DAY + 1);
const fmtDate = (n) =>
  new Date((FIRST_DAY + n - 1) * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase();

// Day N is the Nth entry of games.json, so new words go at the END of the file.
function wordFor(n) {
  const keys = Object.keys(data.games);
  return keys[(n - 1) % keys.length];
}

const defaultStats = () => ({ played: 0, wins: 0, streak: 0, best: 0, lastWin: 0, dist: [0, 0, 0, 0] });
const loadStats = () => Object.assign(defaultStats(), store.get(KEY.stats, {}));

// A streak survives until a whole day is missed.
function currentStreak() {
  const s = loadStats();
  return s.lastWin >= todayNum() - 1 ? s.streak : 0;
}

function recordDaily() {
  const s = loadStats(), n = state.puzzle;
  s.played += 1;
  if (state.won) {
    s.wins += 1;
    s.streak = s.lastWin === n - 1 ? s.streak + 1 : 1;
    s.lastWin = n;
    s.best = Math.max(s.best, s.streak);
    s.dist[Math.min(3, state.guesses.length - 1)] += 1;
  } else {
    s.streak = 0;
  }
  store.set(KEY.stats, s);
}

function puzzleStatus(n) {
  const s = store.get(KEY.puzzle(n));
  if (!s || s.word !== wordFor(n) || !Array.isArray(s.guesses)) return 'new';
  if (s.guesses.includes(s.word)) return 'won';
  if (s.revealed || s.guesses.length >= MAX_GUESSES) return 'lost';
  return s.guesses.length || s.clueLevel ? 'part' : 'new';
}

// Spoiler-free: one line per guess, one square per part, a scissors mark when it sliced.
function shareText() {
  const label = state.mode === 'archive' ? `SLICE ARCHIVE #${state.puzzle}` : `SLICE #${state.puzzle}`;
  const score = state.won ? `${state.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
  const streak = state.mode === 'daily' && currentStreak() > 1 ? ` 🔥${currentStreak()}` : '';
  const lines = state.guesses.map((g) => {
    const r = evaluate(g, state.word, state.parts);
    const sq = r.partResults.map((p) => (p === 'green' ? '🟩' : p === 'yellow' ? '🟨' : '⬛')).join('');
    return sq + (r.cuts.length ? ' ✂️' : '');
  });
  const url = typeof location !== 'undefined' && /^https?:/.test(location.protocol) ? `\n${location.origin}${location.pathname}` : '';
  return `${label} ${score}${streak}\n${lines.join('\n')}${url}`;
}

/* ---------------------------------------------------------
   Deterministic clue selection (same word -> same clues).
   Zen mode mixes in the clock so the clues vary every round.
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
    if (state.mode === 'zen') {
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
   Sound effects (WebAudio, no files). Toggle in the header.
   --------------------------------------------------------- */

const sfx = (() => {
  let ctx = null;
  let on = store.get(KEY.sfx, true) !== false;

  const audio = () => {
    if (!on || typeof window === 'undefined') return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  const tone = (c, f0, f1, dur, type, vol, delay = 0) => {
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  };
  const noise = (c, dur, vol, f0, f1) => {
    const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime;
    f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(f).connect(g).connect(c.destination);
    src.start(t);
  };

  return {
    get on() { return on; },
    toggle() { on = !on; store.set(KEY.sfx, on); return on; },
    // a soft, quick whoosh, a little ring off the steel, then a low thunk as the halves settle
    slash() { const c = audio(); if (!c) return; noise(c, 0.13, 0.28, 6000, 1400); tone(c, 2400, 1500, 0.09, 'sine', 0.022, 0.02); tone(c, 190, 120, 0.1, 'triangle', 0.045, 0.07); },
    miss()  { const c = audio(); if (!c) return; tone(c, 180, 90, 0.09, 'triangle', 0.06); },
    bad()   { const c = audio(); if (!c) return; tone(c, 150, 110, 0.12, 'square', 0.035); },
    tick()  { const c = audio(); if (!c) return; tone(c, 880, 880, 0.04, 'square', 0.025); },
    win()   { const c = audio(); if (!c) return; [523, 659, 784, 1047].forEach((f, i) => tone(c, f, f, 0.18, 'triangle', 0.06, i * 0.09)); },
    lose()  { const c = audio(); if (!c) return; tone(c, 262, 131, 0.5, 'triangle', 0.06); },
    mega()  { const c = audio(); if (!c) return; noise(c, 0.6, 0.8, 9000, 260); tone(c, 240, 40, 0.5, 'sawtooth', 0.07); },
    sheathe() { const c = audio(); if (!c) return; tone(c, 1700, 950, 0.05, 'square', 0.03); tone(c, 760, 760, 0.05, 'square', 0.03, 0.08); },
  };
})();

/* ---------------------------------------------------------
   The sage: says short quotes above his head. The quote fades
   in, holds, then slides away and fades out (see .q in CSS).
   --------------------------------------------------------- */

const QUOTES = {
  start:   ['Welcome, student. Sit. Sip.', 'The bamboo is listening.', 'A word is two seeds in one husk.'],
  hit:     ['Ah. A clean cut.', 'The blade finds the seam.', 'You hear that? A word breaking.', 'Two halves, one truth.', 'Swift. Quiet. Nearly right.'],
  miss:    ['Hm. The blade met only air.', 'Even a miss teaches the wrist.', 'Silence is also an answer.', 'Breathe. Then cut again.', 'The word hides in plain sight.'],
  invalid: ['That is not a word, young one.', 'The scrolls do not know it.', 'Too short. Breathe in.', 'Only letters, please.', 'You have tried that one.'],
  win:     ['Well sliced, student.', 'The bamboo bows to you.', 'A clean cut. I am almost impressed.', 'Sip. You have earned it.'],
  win1:    ['One cut? Were you listening to the wind?', 'First try... the tea spilled itself.'],
  streak:  ['Day after day, the river carves stone.', 'A streak is a habit with a flame.', 'Consistency. The truest blade.'],
  lose:    ['Defeat is only tea gone cold.', 'The word wins today. Tomorrow, you.', 'Even masters misjudge the bamboo.'],
  clue:    ['A hint? There is no shame in it.', 'Seek, and the parts reveal themselves.', 'Counting letters is a fine start.'],
  reveal:  ['Mercy is also a lesson.', 'Now you know. Do not forget.'],
  daily:   ['The daily path. One word, one cut.', 'Each dawn, new bamboo.'],
  zen:     ['Zen. No clock. No rush.', 'Breathe. There is no end here.', 'Cut for as long as you like.'],
  archive: ['The scrolls of days gone by.', 'Old words keep their edge.'],
  next:    ['A new word rises like steam.', 'Again. The blade remembers.'],
  share:   ['Share wisely. Spoilers dull the blade.', 'Let others find their own cuts.'],
  idle:    ['Mm. Good tea.', 'The river never hurries.', 'Sip... ahh.', 'A leaf falls. A word waits.', 'Do not rush the blade.'],
};
let lastQuote = '';

function say(kind) {
  const pool = QUOTES[kind];
  const box = $('sage-quote');
  if (!pool || !box) return;
  let q;
  do { q = pool[Math.floor(Math.random() * pool.length)]; } while (pool.length > 1 && q === lastQuote);
  lastQuote = q;
  box.replaceChildren();
  const node = document.createElement('div');
  node.className = 'q';
  node.textContent = q;
  node.addEventListener('animationend', () => node.remove());
  setTimeout(() => node.remove(), 7000);   // fallback when animations are off
  box.appendChild(node);
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
   Rendering: clue boxes, hint, buttons, messages
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

// In place, so the CSS fades run instead of the boxes being rebuilt.
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

// A quick white pulse on the clue boxes that were just matched (.pulse, not .flash: .flash is the win overlay)
function pulseSlots(partResults) {
  [...els.slots.children].forEach((el, i) => {
    if (partResults[i]) {
      el.classList.remove('pulse');
      void el.offsetWidth;
      el.classList.add('pulse');
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
  els.btnResults.classList.toggle('hidden', !(state.over && state.mode !== 'zen'));
  updateSlots();
  updateHint();
  updateClueButton();
  updateActiveRow();
}

function updateChips() {
  els.streak.textContent = `STREAK ${currentStreak()}`;
  els.puzzle.textContent =
    state.mode === 'daily' ? `DAILY #${state.puzzle}` :
    state.mode === 'archive' ? `ARCHIVE #${state.puzzle}` : `ZEN #${state.zenCount}`;
  els.sfx.textContent = sfx.on ? 'SFX ON' : 'SFX OFF';
  els.sfx.setAttribute('aria-pressed', String(sfx.on));
}

function setActiveMode() {
  const inArchive = state.view === 'archive';
  els.btnDaily.setAttribute('aria-pressed', String(state.mode === 'daily' && !inArchive));
  els.btnZen.setAttribute('aria-pressed', String(state.mode === 'zen' && !inArchive));
  els.btnArchive.setAttribute('aria-pressed', String(inArchive || state.mode === 'archive'));
}

/* ---------------------------------------------------------
   Reveal + the slash.
   No subword in the guess -> no animation at all.
   Subword -> the word is cut along the edges of every part:
     1. a white blade draws down each seam, left to right (CSS, on the
        letter's ::after, so it always sits exactly in the gap)
     2. the word springs open along the seams (margin overshoot + settle)
        while a few sparks leave each seam
     3. the lit letters colour in as a quick ripple outward from the
        nearest seam, each hopping up for a beat
   Nothing leaves the row: no shake, no full-row flash, no layout jump.
   Returns true when the guess contained a subword.
   --------------------------------------------------------- */

const SLASH_MS = 400;        // how long the board is held while the cut plays
const SLASH_STAGGER = 45;    // ms between one seam and the next
const RIPPLE_START = 70;     // ms before the first letter lights up
const RIPPLE_STEP = 22;      // ms per letter of distance from the seam

async function revealRow(i, guess, result, win) {
  const rowEl = els.grid.children[i];
  paintRow(i, guess);
  rowEl.classList.add('done');
  const letters = [...rowEl.querySelectorAll('.ltr')];
  const states = win ? guess.split('').map(() => 'green') : result.letters;
  const paint = (k) => { letters[k].dataset.state = states[k] || 'miss'; };

  if (!states.some(Boolean)) { letters.forEach((_, k) => paint(k)); return false; }   // nothing found: no animation
  const cuts = result.cuts;
  if (!cuts.length || reducedMotion()) {                                              // e.g. the guess is exactly one part
    cuts.forEach((c) => letters[c - 1].classList.add('cut-after'));
    letters.forEach((_, k) => paint(k));
    return true;
  }

  sfx.slash();
  letters.forEach((_, k) => { if (!states[k]) paint(k); });          // unlit letters settle straight away

  cuts.forEach((c, n) => {                                            // seams: blade + gap spring + sparks
    const l = letters[c - 1];
    l.style.setProperty('--cd', `${n * SLASH_STAGGER}ms`);
    l.classList.add('cut-after', 'open');
  });

  letters.forEach((l, k) => {                                         // colour ripples out from the nearest seam
    if (!states[k]) return;
    const dist = Math.min(...cuts.map((c) => (k < c ? c - 1 - k : k - c)));
    const delay = RIPPLE_START + Math.min(dist, 5) * RIPPLE_STEP;
    setTimeout(() => {
      paint(k);
      l.classList.add('pop');
      setTimeout(() => l.classList.remove('pop'), 90);
    }, delay);
  });

  await sleep(SLASH_MS);
  return true;
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

// Called once when a round ends (silent = restoring a saved, finished round).
function finishRound(silent = false) {
  if (!state.over) return;
  if (state.mode === 'daily' && !state.counted) {
    recordDaily();
    state.counted = true;
  }
  updateChips();
  save();
  if (silent) return;

  if (state.won) {
    sfx.win();
    strike();
    const streak = state.mode === 'daily' && currentStreak() >= 3 && Math.random() < 0.6;
    say(state.guesses.length === 1 ? 'win1' : streak ? 'streak' : 'win');
  } else {
    sfx.lose();
    say(state.revealed ? 'reveal' : 'lose');
  }
  if (state.mode !== 'zen') {
    const round = state.round;
    setTimeout(() => { if (state.round === round && state.over && state.view === 'game') showView('results'); }, state.won ? 1900 : 900);
  }
}

function flash(text) {
  setMessage(text, 'warn');
  sfx.bad();
  say('invalid');
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
  const hit = await revealRow(idx, guess, result, win);
  if (!hit) sfx.miss();

  applyResult(result);
  checkEnd(guess);
  pulseSlots(win ? state.parts.map(() => 'green') : result.partResults);
  save();
  state.busy = false;

  if (state.over) finishRound();
  else { say(hit ? 'hit' : 'miss'); els.input.focus(); }
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
  sfx.tick();

  if (state.clueLevel === 0) {
    state.clueLevel = 1;
    updateSlots();
    say('clue');
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
    finishRound();
    return;
  }
  updateClueButton();
  save();
}

/* ---------------------------------------------------------
   Views: game / results / archive
   --------------------------------------------------------- */

function showView(v) {
  state.view = v;
  els.vGame.classList.toggle('hidden', v !== 'game');
  els.vResults.classList.toggle('hidden', v !== 'results');
  els.vArchive.classList.toggle('hidden', v !== 'archive');
  setActiveMode();
  if (v === 'results') renderResults();
  if (v === 'archive') renderArchive();
  if (v === 'game' && !state.over) els.input.focus();
}

const backView = () => (state.mode !== 'zen' && state.over ? 'results' : 'game');

function renderResults() {
  const stats = loadStats();
  els.resKicker.textContent =
    `${state.mode === 'archive' ? 'ARCHIVE' : 'DAILY'} #${state.puzzle} · ${fmtDate(state.puzzle)}`;
  els.resTitle.textContent = state.won ? 'SLICED!' : state.revealed ? 'REVEALED' : 'NOT QUITE';
  els.resTitle.classList.toggle('lose', !state.won);
  els.resWord.textContent = `${state.parts.join(' + ')} = ${state.word}`.toUpperCase();

  els.statPlayed.textContent = String(stats.played);
  els.statWin.textContent = String(stats.played ? Math.round((stats.wins / stats.played) * 100) : 0);
  els.statStreak.textContent = String(currentStreak());
  els.statBest.textContent = String(stats.best);

  const max = Math.max(1, ...stats.dist);
  els.dist.replaceChildren();
  stats.dist.forEach((count, i) => {
    const row = document.createElement('div');
    row.className = 'dist-row' + (state.won && state.mode === 'daily' && state.guesses.length === i + 1 ? ' hl' : '');
    const label = document.createElement('i');
    label.textContent = String(i + 1);
    const bar = document.createElement('div');
    bar.textContent = String(count);
    bar.style.width = `${Math.max(8, Math.round((count / max) * 100))}%`;
    row.append(label, bar);
    els.dist.appendChild(row);
  });

  els.sharePreview.textContent = shareText();
  els.btnShare.classList.toggle('hidden', typeof navigator === 'undefined' || !navigator.share);
  tickCountdown();
}

function tickCountdown() {
  if (state.view !== 'results' || state.mode !== 'daily') { els.nextIn.textContent = ''; return; }
  const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const s = Math.max(0, Math.floor((next - now) / 1000));
  const p = (n) => String(n).padStart(2, '0');
  els.nextIn.textContent = `NEXT SLICE IN ${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// If the page was left open past midnight, move on to the new daily.
function refreshDay() {
  tickCountdown();
  if (state.mode === 'daily' && todayNum() !== state.puzzle) startDaily();
}

async function copyResult() {
  const text = shareText();
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (__) {}
  }
  els.btnCopy.textContent = ok ? 'COPIED!' : 'PRESS CTRL+C';
  setTimeout(() => { els.btnCopy.textContent = 'COPY RESULT'; }, 1800);
  sfx.tick();
  say('share');
}

function shareResult() {
  if (navigator.share) navigator.share({ text: shareText() }).catch(() => {});
}

function renderArchive() {
  const today = todayNum();
  let solved = 0;
  els.archList.replaceChildren();
  for (let n = today; n >= 1; n--) {
    const st = puzzleStatus(n);
    if (st === 'won') solved += 1;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `day day-${st}${n === today ? ' today' : ''}`;
    b.dataset.n = String(n);
    const mk = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    b.append(
      mk('day-n', `#${n}`),
      mk('day-d', n === today ? `${fmtDate(n)} · TODAY` : fmtDate(n)),
      mk('day-m', { won: 'SOLVED', lost: 'MISSED', part: 'IN PROGRESS', new: 'NEW' }[st]),
    );
    els.archList.appendChild(b);
  }
  els.archCount.textContent = `${solved}/${today} SOLVED`;
}

/* ---------------------------------------------------------
   Persistence (daily + archive; zen is never saved)
   --------------------------------------------------------- */

function save() {
  if (!state.storageKey) return;
  store.set(state.storageKey, {
    word: state.word,
    guesses: state.guesses,
    clueLevel: state.clueLevel,
    revealed: state.revealed,
    counted: state.counted,
  });
}

function restore() {
  if (!state.storageKey) return;
  const saved = store.get(state.storageKey);
  if (!saved || saved.word !== state.word || !Array.isArray(saved.guesses)) return;

  state.clueLevel = Math.max(0, Math.min(2, saved.clueLevel | 0));
  state.counted = Boolean(saved.counted);
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
  if (state.over) finishRound(true);
}

/* ---------------------------------------------------------
   Starting rounds
   --------------------------------------------------------- */

function startGame(word, storageKey) {
  disarm();
  const entry = data.games[word];
  state.round += 1;
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
    counted: false,
    storageKey,
  });
  els.input.value = '';
  buildGrid();
  buildSlots();
  setMessage('');
  applyEndState();
  restore();
  updateChips();
  showView(backView());
}

function startDaily() {
  state.mode = 'daily';
  state.puzzle = todayNum();
  startGame(wordFor(state.puzzle), KEY.puzzle(state.puzzle));
}

function startArchive(n) {
  state.mode = 'archive';
  state.puzzle = n;
  startGame(wordFor(n), KEY.puzzle(n));
}

function startZen() {
  state.mode = 'zen';
  state.zenCount += 1;
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
    p.rect(Math.round(cx) - 1, bodyTop + 3, 2, 2, '#4a3a38');          // window

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
  p.rect(45, H - 30, 4, 5, '#5a4640');                                            // offering box
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
  p.rect(5, 10, 4, 4, '#ffcf70'); p.rect(6, 11, 2, 2, '#fff3c4');
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

/* ---------- Cliff with a notch the waterfall spills over ---------- */
function cliff(seed) {
  const W = 64, H = 72, r = rng(seed), p = new Pix(W, H), n0 = 24, n1 = 40, notchTop = 16;
  const tones = ['#2f3d3c', '#3e4f4c', '#506560', '#6a8078'];
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

/* ---------- Canopy: hanging bamboo-leaf blades (tiles seamlessly sideways) ---------- */
function canopyTile(seed, W = 96, H = 50) {
  const r = rng(seed), p = new Pix(W, H);
  const tones = ['#0e2a19', '#16422a', '#235a36', '#347843', '#4f9c53'];
  const put = (x, y, c) => p.set(((Math.round(x) % W) + W) % W, y, c);
  for (let x = 0; x < W; x++) {                                    // dense dark mass along the top edge
    const d = 6 + Math.round(r() * 5 + Math.sin(x * 0.4) * 2);
    for (let y = 0; y < d; y++) p.set(x, y, tones[y < 3 ? 0 : 1]);
  }
  for (let n = 0; n < 74; n++) {                                   // hanging blades
    const ax = r() * W, ay = r() * 9, len = 7 + r() * 22, ang = (r() - 0.5) * 2.1, ti = 1 + Math.floor(r() * 4);
    for (let s = 0; s <= len; s++) {
      const t = s / len, x = ax + Math.sin(ang) * s + Math.sin(t * 3) * 0.8, y = ay + Math.cos(ang) * s * 0.92;
      const th = Math.max(1, Math.round(Math.sin(Math.PI * t) * 2.2));
      for (let k = 0; k < th; k++) put(x + k, y, tones[ti]);
      if (th > 1 && t > 0.15 && t < 0.6) put(x, y, tones[Math.min(4, ti + 1)]);   // lit vein
    }
  }
  return p;
}

/* ---------- Water ripples (a tile that repeats and scrolls) ---------- */
function riverTile(seed, hi, lo) {
  const r = rng(seed), p = new Pix(32, 12);
  for (let n = 0; n < 15; n++) {
    const len = 3 + Math.floor(r() * 5);
    p.rect(Math.floor(r() * (32 - len - 1)), Math.floor(r() * 12), len, 1, r() > 0.35 ? hi : lo);
  }
  return p;
}

/* ---------- Stone steps climbing the mountain ---------- */
function stairs() {
  const W = 46, H = 36, r = rng(7), p = new Pix(W, H);
  const stone = '#7d788c', hi = '#a29db3', dk = '#4f4a5e', moss = '#4a8a58';
  for (let i = 0; i < 9; i++) {                                    // i = 0 is the top step: narrower with distance
    const w = 20 + i * 3, x0 = Math.round((W - w) / 2), y = i * 4;
    p.rect(x0, y, w, 4, stone);
    p.rect(x0, y, w, 1, hi);
    p.rect(x0, y + 3, w, 1, dk);
    for (let k = 0; k < w; k += 6) p.set(x0 + k + (i % 3), y + 2, dk);
    if (r() < 0.6) p.rect(x0 + Math.floor(r() * (w - 3)), y, 3, 1, moss);
  }
  return p;
}

/* ---------- Solid ground: a tile whose top edge repeats seamlessly ---------- */
function groundTile(seed) {
  const W = 32, H = 16, r = rng(seed), p = new Pix(W, H);
  const dirt = '#4a3a28', dirtHi = '#6a5438', dirtDk = '#33281a', grass = '#5aa04c', grass2 = '#3d7a3a';
  p.rect(0, 0, W, H, dirt);
  for (let x = 0; x < W; x++) {
    const h = 2 + Math.round(Math.sin((x / W) * Math.PI * 4 + seed) * 1.4);
    p.rect(x, 0, 1, h, null);
    p.set(x, h, grass); p.set(x, h + 1, grass); p.set(x, h + 2, grass2);
    if (r() < 0.35) p.set(x, h + 3, grass2);
  }
  for (let n = 0; n < 26; n++) p.set(Math.floor(r() * W), 6 + Math.floor(r() * 10), r() > 0.5 ? dirtHi : dirtDk);
  for (let n = 0; n < 4; n++) p.rect(Math.floor(r() * (W - 3)), 8 + Math.floor(r() * 7), 3, 2, '#7d788c');   // buried pebbles
  return p;
}

/* ---------- Rocks (dome, lit from the top left, mossy on top) ---------- */
function rock(seed, w, h) {
  const r = rng(seed), p = new Pix(w, h);
  const base = '#6c677a', hi = '#9a95ab', dk = '#47435a', dk2 = '#38344a', moss = '#4a8a58', moss2 = '#62a86c';
  const hw = (y) => Math.max(2, Math.round((w / 2) * Math.sqrt(1 - Math.pow((h - 1 - y) / h, 2)) * 1.02 + (r() - 0.5) * 0.6));
  for (let y = 0; y < h; y++) {
    const half = hw(y), x0 = Math.round(w / 2 - half), x1 = Math.round(w / 2 + half) - 1;
    for (let x = x0; x <= x1; x++) {
      let c = base;
      if (y <= 1 || x - x0 <= 1) c = hi;
      if (x1 - x <= 1 || y >= h - 2) c = dk;
      if (y >= h - 1) c = dk2;
      p.set(x, y, c);
    }
  }
  for (let n = 0; n < Math.floor(w / 4); n++) {                     // cracks
    const x = 2 + Math.floor(r() * (w - 4)), y = 2 + Math.floor(r() * (h - 4));
    p.rect(x, y, 1, 2, dk);
  }
  for (let x = 2; x < w - 2; x++) if (r() < 0.5) { p.set(x, 1, moss); if (r() < 0.4) p.set(x, 2, moss2); }
  return p;
}

/* ---------- Fern ---------- */
function fern(seed, tones) {
  const r = rng(seed), p = new Pix(22, 13), n = 6;
  for (let i = 0; i < n; i++) {
    const ang = -1.3 + (i / (n - 1)) * 2.6, len = 7 + r() * 5;
    for (let s = 0; s <= len; s++) {
      const t = s / len, x = 11 + Math.sin(ang) * s * 1.1, y = 12 - Math.cos(ang) * s * 0.85 + t * t * 3 * Math.abs(Math.sin(ang));
      p.set(x, y, tones[t > 0.65 ? 1 : i % 2 ? 0 : 2]);
      if (s > 2 && s % 2 === 0) { p.set(x + (ang < 0 ? -1 : 1), y + 1, tones[2]); p.set(x, y - 1, tones[1]); }
    }
  }
  return p;
}

/* ---------- Stone fox (kitsune) guardian ---------- */
function kitsune() {
  const p = new Pix(16, 22);
  const s = '#a9a4b8', hi = '#c7c2d6', dk = '#807b93', base = '#6b6678', red = '#c4413a', redHi = '#e05a50', dark = '#2a2630';
  p.rect(1, 19, 14, 3, base); p.rect(1, 19, 14, 1, hi); p.rect(13, 19, 2, 3, dk);
  p.rect(4, 9, 8, 10, s); p.rect(4, 9, 1, 10, hi); p.rect(10, 9, 2, 10, dk);
  p.rect(12, 13, 3, 6, s); p.rect(13, 10, 2, 4, s); p.rect(14, 9, 1, 2, hi);            // tail
  p.rect(4, 3, 8, 7, hi); p.rect(10, 3, 2, 7, s);                                       // head
  p.rect(4, 0, 2, 4, hi); p.rect(10, 0, 2, 4, s); p.set(5, 1, dk); p.set(10, 1, dk);   // ears
  p.rect(6, 6, 1, 1, dark); p.rect(9, 6, 1, 1, dark); p.rect(7, 8, 2, 1, dk);          // eyes + nose
  p.rect(5, 10, 6, 3, red); p.rect(5, 10, 6, 1, redHi); p.set(8, 13, red);              // red bib
  return p;
}

/* ---------- Hanging paper lantern (chochin) ---------- */
function chochin() {
  const p = new Pix(12, 18);
  const cap = '#2a2230', red = '#e8584a', hi = '#ff9a6a', dk = '#b03030', rib = '#8a2222';
  p.rect(3, 0, 6, 2, cap);
  for (let y = 2; y <= 13; y++) {
    const half = Math.round(5 - Math.pow((y - 7.5) / 6, 2) * 2.2), x0 = 6 - half, w = half * 2;
    p.rect(x0, y, w, 1, red);
    p.set(x0, y, hi); p.set(x0 + 1, y, hi); p.set(x0 + w - 1, y, dk);
    if (y === 4 || y === 7 || y === 10) p.rect(x0, y, w, 1, rib);
  }
  p.rect(5, 5, 2, 2, '#ffd88a'); p.rect(5, 8, 2, 2, '#ffd88a');
  p.rect(3, 14, 6, 2, cap); p.rect(5, 16, 2, 2, '#e8c46a');
  return p;
}

/* ---------- The old sage. Modes: idle, sip, then the katana strike: s0 ready, s1 draw, s2 slash, s3 follow-through, s4 sheathing, s5 sheathed ---------- */
function sageFrame(mode) {
  const p = new Pix(46, 36);
  const skin = '#e2b48a', skinDk = '#c08a62', skinHi = '#f1cfae';
  const robe = '#b8703a', robeHi = '#d38d4a', robeDk = '#8a4f26', sash = '#7a3b2c', under = '#ecdcb8';
  const white = '#f4f2ec', whiteDk = '#cfcbc2', dark = '#2e2119';
  const wood = '#6b4a32', woodDk = '#4a3222', woodHi = '#8a6347';
  const cupC = '#efe6d6', cupDk = '#b9ae9a', tea = '#8a5a2a';
  const steel = '#f6f8ff', steelDk = '#aeb6cf', saya = '#2a2230', sayaHi = '#4a3f58', tsuka = '#d9d2c0', gold = '#e8c46a';
  const awake = mode !== 'idle' && mode !== 'sip' && mode !== 's5';

  p.rect(2, 31, 28, 5, woodDk); p.rect(3, 30, 26, 2, wood); p.rect(3, 30, 26, 1, woodHi);          // stone seat
  p.rect(3, 26, 26, 5, robe); p.rect(3, 26, 26, 1, robeHi); p.rect(3, 30, 26, 1, robeDk);          // crossed legs
  p.rect(5, 28, 8, 2, robeDk); p.rect(19, 28, 8, 2, robeDk);
  p.rect(9, 14, 14, 13, robe); p.rect(9, 14, 2, 13, robeHi); p.rect(21, 14, 2, 13, robeDk);        // torso
  p.rect(14, 14, 4, 5, under); p.rect(9, 22, 14, 2, sash);

  p.rect(12, 2, 8, 1, skin); p.rect(11, 3, 10, 9, skin);                                            // head
  p.rect(10, 7, 1, 3, skin); p.rect(21, 7, 1, 3, skin);
  p.set(14, 3, skinHi); p.set(15, 3, skinHi);
  p.rect(14, 0, 4, 2, white); p.rect(10, 4, 1, 3, white); p.rect(21, 4, 1, 3, white);              // topknot + side hair
  p.rect(12, 5, 3, 1, white); p.rect(17, 5, 3, 1, white);                                           // bushy brows
  if (awake) { p.rect(12, 7, 3, 2, white); p.rect(17, 7, 3, 2, white); p.set(13, 7, dark); p.set(13, 8, dark); p.set(18, 7, dark); p.set(18, 8, dark); }
  else { p.rect(12, 7, 3, 1, dark); p.rect(17, 7, 3, 1, dark); }                                    // closed eyes
  p.rect(15, 8, 2, 2, skinDk);                                                                      // nose
  p.rect(12, 10, 8, 1, white); p.rect(11, 11, 10, 3, white); p.rect(12, 14, 8, 3, white);           // moustache + long beard
  p.rect(13, 17, 6, 3, white); p.rect(14, 20, 4, 2, white);
  p.rect(20, 11, 1, 3, whiteDk); p.rect(19, 14, 1, 3, whiteDk); p.rect(18, 17, 1, 3, whiteDk); p.rect(17, 20, 1, 2, whiteDk);

  const scabbard = (x0, y0, x1, y1) => { p.line(x0, y0, x1, y1, 2, saya); p.line(x0, y0 - 1, x1, y1 - 1, 1, sayaHi); p.set(x1, y1, gold); };
  const hand = (x, y) => p.rect(x, y, 3, 3, skin);

  if (mode === 'idle') {                                                                            // cup resting in both hands
    p.rect(8, 20, 16, 4, robe); p.rect(8, 20, 16, 1, robeHi); p.rect(8, 23, 16, 1, robeDk);
    p.rect(13, 20, 6, 3, skin);
    p.rect(14, 17, 5, 4, cupC); p.rect(14, 20, 5, 1, cupDk); p.rect(15, 17, 3, 1, tea);
  } else if (mode === 'sip') {                                                                      // cup raised to the lips
    p.rect(8, 15, 3, 7, robe); p.rect(21, 15, 3, 7, robe);
    p.rect(11, 13, 3, 3, skin); p.rect(18, 13, 3, 3, skin);
    p.rect(13, 11, 6, 4, cupC); p.rect(13, 14, 6, 1, cupDk); p.rect(14, 11, 4, 1, tea);
  } else if (mode === 's0' || mode === 's5') {                                                      // katana across the lap, hand on the grip
    p.rect(8, 20, 16, 4, robe); p.rect(8, 20, 16, 1, robeHi); p.rect(8, 23, 16, 1, robeDk);
    scabbard(4, 25, 25, 23); p.rect(24, 21, 6, 2, tsuka); p.rect(24, 21, 1, 2, gold); hand(21, 20);
  } else if (mode === 's1') {                                                                       // draw: blade sweeping up and out
    p.rect(8, 20, 16, 4, robe); scabbard(4, 26, 20, 25);
    p.rect(21, 15, 3, 7, robe); hand(22, 14);
    p.line(24, 14, 45, 0, 2, steel); p.line(24, 15, 45, 1, 1, steelDk); p.rect(22, 15, 3, 2, tsuka);
  } else if (mode === 's2') {                                                                       // the cut: blade straight out
    p.rect(8, 20, 16, 4, robe); scabbard(4, 26, 20, 25);
    p.rect(21, 18, 4, 3, robe); hand(24, 18);
    p.line(26, 19, 45, 19, 2, steel); p.line(26, 20, 45, 20, 1, steelDk); p.rect(25, 18, 2, 3, tsuka);
  } else if (mode === 's3') {                                                                       // follow-through, blade low
    p.rect(8, 20, 16, 4, robe); scabbard(4, 26, 20, 25);
    p.rect(21, 20, 4, 3, robe); hand(24, 21);
    p.line(26, 23, 45, 33, 2, steel); p.line(26, 24, 45, 34, 1, steelDk); p.rect(25, 22, 2, 3, tsuka);
  } else if (mode === 's4') {                                                                       // sheathing: blade slides home
    p.rect(8, 20, 16, 4, robe); scabbard(4, 25, 25, 23);
    p.line(24, 22, 33, 22, 2, steel); p.rect(26, 21, 5, 3, tsuka); hand(22, 20);
  }
  return p;
}

function buildSage() {
  const steam = (l, b, d, sx) => `<i class="steam" style="left:${l}px;bottom:${b}px;--d:${d}s;--sx:${sx}px"></i>`;
  const strike = ['s0', 's1', 's2', 's3', 's4', 's5'].map((m) => `<div class="sage-frame f-s f-${m}">${sageFrame(m).svg(3)}</div>`).join('');
  $('sage-body').innerHTML =
    `<div class="sage-frame f-idle">${sageFrame('idle').svg(3)}${steam(46, 58, 0, 3)}${steam(52, 58, 1.2, -3)}${steam(49, 58, 0.6, 2)}</div>` +
    `<div class="sage-frame f-sip">${sageFrame('sip').svg(3)}${steam(60, 74, 0, 4)}${steam(55, 74, 1.2, -2)}</div>` + strike;
}

/* =========================================================
   The strike: on a win the sage draws, cuts the whole screen, sheathes.
   Slash flipbook + white flash + quake + a gust that bends the bamboo.
   ========================================================= */

let striking = false;

function setStrike(n) {
  const el = $('sage');
  if (n == null) { el.classList.remove('striking'); delete el.dataset.s; return; }
  el.classList.add('striking');
  el.dataset.s = n;
}

function restartClass(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (ms) setTimeout(() => el.classList.remove(cls), ms);
}

function megaSlash() {
  const CELL = 6, F = 9;
  const cw = Math.ceil(innerWidth / CELL), ch = Math.ceil((innerHeight * 0.7) / CELL);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch; cv.className = 'mega';
  cv.style.height = ch * CELL + 'px';
  $('fx').appendChild(cv);
  const ctx = cv.getContext('2d');
  const curve = (s) => ch * (0.9 - 0.62 * s) + Math.sin(s * Math.PI) * ch * 0.16;           // low left, sweeping up and right
  const draw = (f) => {
    ctx.clearRect(0, 0, cw, ch);
    const head = Math.min(1, (f + 1) / (F - 3)), tail = Math.max(0, head - 0.6), fade = f >= F - 3 ? (F - f) / 3 : 1;
    for (let c = Math.floor(tail * cw); c <= Math.floor(head * cw); c++) {
      const s = c / cw, u = (s - tail) / Math.max(0.001, head - tail);
      const th = Math.max(1, Math.round(Math.sin(Math.PI * Math.min(1, Math.max(0, u))) * 9 * fade));
      const y = Math.round(curve(s));
      ctx.fillStyle = '#fff';
      ctx.fillRect(c, y - Math.floor(th / 2), 1, th);
      ctx.fillStyle = 'rgba(255,214,232,.8)';
      ctx.fillRect(c, y - Math.floor(th / 2) - 1, 1, 1);
      ctx.fillRect(c, y + Math.ceil(th / 2), 1, 1);
    }
  };
  let f = 0;
  draw(0);
  const iv = setInterval(() => { f++; if (f >= F) { clearInterval(iv); cv.remove(); return; } draw(f); }, 45);
}

function windBurst() {
  const fx = $('fx'), cols = ['#4f9c53', '#347843', '#6bb86a', '#d9739a', '#f2a3c1'];
  for (let i = 0; i < 34; i++) {
    const leaf = i < 24, el = document.createElement('i');
    el.className = leaf ? 'blow' : 'windline';
    const w = leaf ? 6 + Math.round(Math.random() * 4) : 50 + Math.round(Math.random() * 90);
    el.style.cssText = `top:${(18 + Math.random() * 78).toFixed(1)}%;width:${w}px;height:${leaf ? 3 : 2}px;` +
      `--c:${leaf ? cols[i % cols.length] : 'rgba(255,255,255,.7)'};--dur:${(0.8 + Math.random() * 0.8).toFixed(2)}s;` +
      `--dl:${(Math.random() * 0.4).toFixed(2)}s;--dy:${Math.round(-60 + Math.random() * 120)}px`;
    fx.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }
}

function strike() {
  if (reducedMotion() || striking) return;
  striking = true;
  const T = (ms, fn) => setTimeout(fn, ms);
  setStrike(0);
  T(260, () => setStrike(1));
  T(330, () => {
    setStrike(2);
    megaSlash();
    windBurst();
    sfx.mega();
    restartClass($('flash'), 'on', 600);
    restartClass(document.documentElement, 'quake', 700);
    restartClass(document.querySelector('.scenery'), 'gust', 1900);
  });
  T(450, () => setStrike(3));
  T(900, () => { setStrike(4); sfx.sheathe(); });
  T(1150, () => setStrike(5));
  T(1650, () => { setStrike(null); striking = false; });
}

/* =========================================================
   Scenery: scene assembly (a bamboo forest at midday)
   Back -> front: far haze bamboo + distant temples, light shafts,
   stairs / torii path + mid bamboo, solid ground + river + waterfall + rocks,
   cherry trees, near bamboo, foreground bank, canopy + lanterns, particles.
   The tallest bamboo runs off the top and the canopy closes it,
   so no sky (or sun) is ever visible.
   ========================================================= */

const FAR_BANK = 148;                 // top of the far bank (px from the bottom)
const RIVER_Y = 84, RIVER_H = 64;     // the river's band (left part of the scene only)
const NEAR_BANK = 84;                 // foreground bank height
const RIVER_W = 54;                   // % of the width covered by the river; solid ground takes the rest

function buildScenery() {
  const r = rng(20261121);
  const between = (a, b) => a + r() * (b - a);
  const add = (id, html) => $(id).insertAdjacentHTML('beforeend', html);
  const sprite = (id, pix, scale, pos, extra = '') => add(id, pix.svg(scale, `${pos};${extra}`));
  const uri = (pix, scale) =>
    'data:image/svg+xml;utf8,' + encodeURIComponent(pix.svg(scale).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
  const haze = 'filter:brightness(.62) saturate(.6);opacity:.8';
  /* a sprite with a flickering glow centred on (gx, gy) sprite pixels */
  const lit = (id, pix, S, pos, gx, gy, gs, delay, extra = '') =>
    add(id, `<div class="prop" style="${pos};width:${pix.w * S}px;height:${pix.h * S}px;${extra}">` +
      `<div class="glow" style="left:${gx * S}px;top:${gy * S}px;--gs:${gs}px;--d:-${delay}s"></div>` +
      pix.svg(S, 'position:absolute;left:0;top:0') + `</div>`);

  const stalks = (id, count, cls, wRange, hRange, seg, leaves, bottom) => {
    let html = '';
    for (let i = 0; i < count; i++) {
      const w = Math.round(between(...wRange) / 2) * 2, pos = (i + r() * 0.9) / count;
      let kids = '';
      for (let k = 0; k < leaves; k++) {
        const side = r() > 0.5;
        kids += `<div class="leaf${side ? '' : ' l'}" style="top:${(8 + r() * 70).toFixed(0)}%;${side ? 'left:100%' : 'right:100%'}"></div>`;
      }
      html += `<div class="stalk ${cls}" style="left:${(pos * 100).toFixed(2)}%;width:${w}px;` +
        `height:${between(...hRange).toFixed(1)}vh;--b:${bottom}px;--seg:${seg + Math.round(r() * 3) * 8}px;` +
        `--dur:${between(4, 8).toFixed(1)}s;--delay:-${between(0, 6).toFixed(1)}s;--gx:${(pos * 0.7 + r() * 0.12).toFixed(2)}s">${kids}</div>`;
    }
    add(id, html);
  };

  /* ----- far: temples up the mountain slope, behind thin haze bamboo ----- */
  const terrace = (left, bottom, w) => add('L-back',
    `<div style="position:absolute;left:${left};bottom:${bottom}px;width:${w}px;height:10px;background:#3b4a45;box-shadow:inset 0 3px 0 #587265"></div>`);
  terrace('21%', FAR_BANK + 56, 200); sprite('L-back', shrine(), 2, `left:22%;bottom:${FAR_BANK + 64}px`, haze);
  terrace('55%', FAR_BANK + 96, 150); sprite('L-back', pagoda(5), 2, `left:57%;bottom:${FAR_BANK + 104}px`, haze);
  terrace('2%', FAR_BANK + 20, 120); sprite('L-back', stoneLantern(), 2, `left:4%;bottom:${FAR_BANK + 30}px`, haze);
  stalks('L-back', 84, 'stalk-far', [6, 12], [95, 125], 36, 0, FAR_BANK - 26);
  add('L-back', `<div class="mist" style="bottom:${FAR_BANK - 40}px;height:58vh"></div>`);

  /* ----- shafts of midday light ----- */
  [[6, 70], [24, 110], [44, 60], [62, 120], [80, 80], [92, 56]].forEach(([left, w], i) =>
    add('L-shaft', `<div class="shaft" style="left:${left}%;width:${w}px;--delay:-${i * 1.3}s"></div>`));

  /* ----- mid: the stone steps up to the mountain shrine (right), then mid bamboo in front ----- */
  const stack = (rightCss, bottom, w, items) => {
    const inner = items.map(({ pix, S, y, extra }) =>
      pix.svg(S, `position:absolute;left:${Math.round((w - pix.w * S) / 2)}px;bottom:${y}px;${extra || ''}`)).join('');
    add('L-mid', `<div class="prop" style="right:${rightCss};bottom:${bottom}px;width:${w}px;height:1px">${inner}</div>`);
  };
  stalks('L-mid', 58, 'stalk-mid', [14, 22], [60, 100], 56, 2, FAR_BANK - 10);
  stalks('L-mid', 22, 'stalk-mid', [10, 16], [12, 30], 36, 2, FAR_BANK - 10);   // young shoots
  stack('5%', FAR_BANK - 6, 190, [
    { pix: stairs(), S: 4, y: 0 },
    { pix: torii(), S: 3, y: 8 },
    { pix: torii(), S: 2, y: 82, extra: 'filter:brightness(.88)' },
    { pix: torii(), S: 2, y: 138, extra: 'filter:brightness(.76)' },
    { pix: shrine(), S: 2, y: 212, extra: 'filter:brightness(.66)' },
  ]);

  /* ----- solid ground on the right, river on the left ----- */
  const gA = uri(groundTile(3), 4);
  add('L-water',
    `<div class="ground" style="width:${100 - RIVER_W + 2}%;bottom:-60px;height:${FAR_BANK + 60 - 6}px;` +
    `background-image:url('${gA}'),none"></div>`);
  const tileA = uri(riverTile(31, '#78bcc2', '#1f5560'), 4), tileB = uri(riverTile(47, '#a4d6da', '#2a6672'), 4);
  add('L-water',
    `<div class="river" style="bottom:${RIVER_Y}px;height:${RIVER_H}px;width:${RIVER_W}%">` +
      `<div class="flow" style="background-image:url('${tileA}');background-size:128px 48px;--dur:7s;--tw:128px"></div>` +
      `<div class="flow" style="background-image:url('${tileB}');background-size:128px 48px;background-position:40px 20px;--dur:11s;--tw:128px;opacity:.65"></div>` +
    `</div>`);
  [[10, 14], [23, 30], [38, 20], [46, 40]].forEach(([left, off], i) =>                    // ripples
    add('L-water', `<div class="ripple" style="left:${left}%;bottom:${RIVER_Y + off}px;--d:-${i * 0.8}s"></div>`));

  const waterfall = (leftCss, S, seed, extra = '') => {
    const c = cliff(seed), w = c.p.w * S, h = c.p.h * S;
    const fx = (c.n0 + 1) * S, fw = (c.n1 - c.n0 - 1) * S, ft = c.notchTop * S;
    add('L-water',
      `<div class="prop" style="left:${leftCss};bottom:${RIVER_Y + 14}px;width:${w}px;height:${h}px;${extra}">` +
        c.p.svg(S, 'position:absolute;left:0;top:0') +
        `<div class="fall" style="left:${fx}px;top:${ft}px;width:${fw}px;height:${h - ft - 2 * S}px"></div>` +
        `<div class="fall-mist" style="left:${fx - 5 * S}px;bottom:${S}px;width:${fw + 10 * S}px"></div>` +
      `</div>`);
  };
  waterfall('5%', 3, 5);

  [[30, 3, 8], [40, 2, 6], [47, 3, 5]].forEach(([left, S, seed], i) =>                     // stepping stones
    sprite('L-water', rock(60 + i, 12 + (i % 2) * 4, 7 + (i % 3) * 2), S, `left:${left}%;bottom:${RIVER_Y + 12 + (i % 3) * 12}px`));
  [[2, 4], [15, 3], [24, 3]].forEach(([left, S], i) =>                                      // far-bank rocks (left)
    sprite('L-water', rock(70 + i, 14 + (i % 3) * 4, 9 + (i % 2) * 4), S, `left:${left}%;bottom:${RIVER_Y + RIVER_H - 8}px`));
  [[RIVER_W - 3, 4, 90], [RIVER_W + 1, 3, 91], [RIVER_W - 7, 2, 92]].forEach(([left, S, seed], i) =>   // the river's bank
    sprite('L-water', rock(seed, 18 + i * 3, 10 + i * 2), S, `left:${left}%;bottom:${RIVER_Y + 6 + i * 8}px`));
  sprite('L-water', torii(), 3, `left:22%;bottom:${RIVER_Y + 14}px`);                      // torii standing in the river

  /* ground details: rocks, a guardian fox, glowing stone lanterns */
  [[63, 3, 95], [76, 4, 96], [88, 3, 97], [95, 2, 98]].forEach(([left, S, seed], i) =>
    sprite('L-water', rock(seed, 14 + (i % 3) * 4, 9 + (i % 2) * 4), S, `left:${left}%;bottom:${FAR_BANK - 8 - (i % 2) * 14}px`));
  lit('L-water', stoneLantern(), 3, `right:calc(5% + 188px);bottom:${FAR_BANK - 6}px`, 7, 12, 150, 0.4);
  lit('L-water', stoneLantern(), 3, `right:calc(5% - 38px);bottom:${FAR_BANK - 6}px`, 7, 12, 150, 1.7);
  sprite('L-water', kitsune(), 3, `right:calc(5% + 236px);bottom:${FAR_BANK - 6}px`);
  sprite('L-water', kitsune(), 3, `right:calc(5% - 86px);bottom:${FAR_BANK - 6}px`, 'transform:scaleX(-1)');
  const fernTones = [['#2e7a46', '#4aa862', '#245f38'], ['#3a8a4a', '#62b85a', '#2a6a3a']];
  for (let i = 0; i < 14; i++)
    sprite('L-water', fern(200 + i, fernTones[i % 2]), r() > 0.5 ? 3 : 2,
      `left:${between(RIVER_W - 2, 97).toFixed(1)}%;bottom:${FAR_BANK - 14 + Math.round(r() * 22)}px`);

  /* ----- cherry trees (the sakura accent) ----- */
  sprite('L-trees', cherryTree(14), 4, `left:-4%;bottom:${FAR_BANK - 6}px`);
  sprite('L-trees', cherryTree(8), 3, `left:19%;bottom:${FAR_BANK - 6}px`, 'filter:brightness(.85)');
  sprite('L-trees', cherryTree(19), 3, `right:27%;bottom:${FAR_BANK - 4}px`, 'filter:brightness(.8)');

  /* ----- near bamboo ----- */
  stalks('L-near', 17, 'stalk-near', [22, 34], [90, 125], 80, 3, NEAR_BANK - 8);

  /* ----- foreground bank: moss, boulders, ferns ----- */
  add('L-fore',
    `<div style="position:absolute;left:0;right:0;bottom:-60px;height:${NEAR_BANK + 60}px;background:#1d4a30;` +
    `box-shadow:inset 0 3px 0 #3a7a4c, inset 0 6px 0 #2b5f3e"></div>`);
  for (let i = 0; i < 9; i++) {                                                           // path stones
    add('L-fore', `<div style="position:absolute;left:${(34 + i * 3.2 + r()).toFixed(1)}%;bottom:${6 + Math.round(r() * 12)}px;` +
      `width:${16 + Math.round(r() * 10)}px;height:6px;background:#6a6578;box-shadow:inset 0 2px 0 #8a849a"></div>`);
  }
  [[12, 4], [47, 3], [78, 4], [93, 3]].forEach(([left, S], i) =>
    sprite('L-fore', rock(40 + i, 14 + (i % 3) * 4, 10 + (i % 2) * 4), S, `left:${left}%;bottom:${NEAR_BANK - 14}px`));
  const tones = [['#2e7a46', '#3d9a5a', '#245f38'], ['#4a8a3a', '#62a84c', '#386b2e'], ['#2a6a50', '#3a8a68', '#1f523e']];
  for (let i = 0; i < 40; i++)
    sprite('L-fore', tuft(100 + i, tones[i % 3]), r() > 0.5 ? 3 : 2,
      `left:${between(0, 98).toFixed(1)}%;bottom:${NEAR_BANK - 14 + Math.round(r() * 10)}px`);
  for (let i = 0; i < 9; i++)
    sprite('L-fore', fern(300 + i, fernTones[i % 2]), 4, `left:${(4 + i * 11 + r() * 5).toFixed(1)}%;bottom:${NEAR_BANK - 16 + Math.round(r() * 8)}px`);

  /* ----- canopy: closes the top so no sky shows, with glowing paper lanterns hanging under it ----- */
  [41, 42, 43, 41, 42, 43].forEach((seed, i) =>
    sprite('L-canopy', canopyTile(seed), 4, `left:${i * 384}px;top:-10px`, i % 2 ? 'transform:scaleX(-1)' : ''));
  [52, 53, 54, 52, 53, 54].forEach((seed, i) =>
    sprite('L-canopy', canopyTile(seed, 96, 36), 3, `left:${i * 288 - 40}px;top:-14px`, i % 2 ? 'transform:scaleX(-1)' : ''));
  [[9, 70], [27, 38], [52, 90], [73, 52], [91, 78]].forEach(([left, drop], i) => {
    const top = 150 + drop;
    add('L-canopy', `<i class="string" style="left:calc(${left}% + 18px);top:120px;height:${top - 120}px"></i>`);
    lit('L-canopy', chochin(), 3, `left:${left}%;top:${top}px`, 6, 8, 130, i * 0.9);
  });

  /* ----- sakura petals + floating white pixels (pollen in the light) ----- */
  let petals = '';
  for (let i = 0; i < 24; i++) {
    const size = r() > 0.5 ? 6 : 4;
    petals += `<div class="petal" style="left:${between(0, 100).toFixed(1)}%;width:${size}px;height:${size - 2}px;` +
      `--dur:${between(10, 20).toFixed(1)}s;--delay:-${between(0, 20).toFixed(1)}s;--drift:${-Math.round(between(10, 40))}vw"></div>`;
  }
  add('petals', petals);
  let motes = '';
  for (let i = 0; i < 55; i++) {
    const size = r() > 0.7 ? 3 : 2;
    motes += `<div class="mote" style="left:${between(0, 100).toFixed(1)}%;top:${between(8, 95).toFixed(1)}%;` +
      `width:${size}px;height:${size}px;--dur:${between(6, 14).toFixed(1)}s;--delay:-${between(0, 14).toFixed(1)}s;` +
      `--dx:${Math.round(between(-40, 40))}px;--dy:${-Math.round(between(60, 160))}px"></div>`;
  }
  add('motes', motes);
}

/* ---------- Mouse parallax: each layer drifts by its own depth (the sage is the nearest layer of all) ---------- */
const PARALLAX = 0.38;

function initParallax() {
  if (reducedMotion()) return;
  const layers = [...document.querySelectorAll('[data-depth]')].map((el) => ({ el, d: Number(el.dataset.depth) * PARALLAX }));
  let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
  const tick = () => {
    x += (tx - x) * 0.07;
    y += (ty - y) * 0.07;
    layers.forEach(({ el, d }) => { el.style.transform = `translate3d(${(-x * d).toFixed(2)}px, ${(-y * d * 0.55).toFixed(2)}px, 0)`; });
    raf = Math.abs(tx - x) > 0.002 || Math.abs(ty - y) > 0.002 ? requestAnimationFrame(tick) : 0;
  };
  window.addEventListener('pointermove', (e) => {
    tx = (e.clientX / innerWidth - 0.5) * 2;
    ty = (e.clientY / innerHeight - 0.5) * 2;
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
}

/* =========================================================
   Mode switching + boot
   ========================================================= */

function goDaily() {
  if (state.busy) return;
  if (state.mode === 'daily' && todayNum() === state.puzzle) { showView(backView()); return; }
  startDaily();
  say('daily');
}

function goZen() {
  if (state.busy) return;
  if (state.mode === 'zen') {
    if (state.view === 'archive') { showView('game'); return; }
    if (!state.over) { setMessage('FINISH THIS WORD FIRST', 'warn'); return; }
    startZen();
    say('next');
    return;
  }
  startZen();
  say('zen');
}

function goArchive() {
  if (state.busy) return;
  if (state.view === 'archive') { showView(backView()); return; }
  showView('archive');
  say('archive');
}

function pickArchiveDay(n) {
  if (state.busy) return;
  if (n === todayNum()) {
    if (state.mode === 'daily' && state.puzzle === n) showView(backView()); else startDaily();
  } else if (state.mode === 'archive' && state.puzzle === n) showView(backView());
  else startArchive(n);
}

async function boot() {
  els = {
    app: $('app'), grid: $('grid'), slots: $('slots'), input: $('guess'), submit: $('submit'),
    msg: $('message'), hint: $('hint'), puzzle: $('puzzle-no'), streak: $('streak-chip'), sfx: $('btn-sfx'),
    form: $('guess-form'), clue: $('btn-clue'), next: $('btn-next'), btnResults: $('btn-results'),
    btnDaily: $('btn-daily'), btnZen: $('btn-zen'), btnArchive: $('btn-archive'),
    vGame: $('view-game'), vResults: $('view-results'), vArchive: $('view-archive'),
    resKicker: $('res-kicker'), resTitle: $('res-title'), resWord: $('res-word'),
    statPlayed: $('stat-played'), statWin: $('stat-win'), statStreak: $('stat-streak'), statBest: $('stat-best'),
    dist: $('dist'), sharePreview: $('share-preview'), btnCopy: $('btn-copy'), btnShare: $('btn-share'), nextIn: $('next-in'),
    btnBoard: $('btn-board'), btnResZen: $('btn-res-zen'), btnResArchive: $('btn-res-archive'),
    archList: $('arch-list'), archCount: $('arch-count'), archBack: $('arch-back'),
  };

  buildScenery();
  buildSage();
  initParallax();

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
  els.next.addEventListener('click', () => { if (!state.busy) { startZen(); say('next'); } });
  els.btnResults.addEventListener('click', () => showView('results'));
  els.btnBoard.addEventListener('click', () => showView('game'));
  els.btnCopy.addEventListener('click', copyResult);
  els.btnShare.addEventListener('click', shareResult);
  els.btnResZen.addEventListener('click', goZen);
  els.btnResArchive.addEventListener('click', () => { showView('archive'); say('archive'); });
  els.archBack.addEventListener('click', () => showView(backView()));
  els.archList.addEventListener('click', (e) => {
    const b = e.target.closest('.day');
    if (b) pickArchiveDay(Number(b.dataset.n));
  });
  els.btnDaily.addEventListener('click', goDaily);
  els.btnZen.addEventListener('click', goZen);
  els.btnArchive.addEventListener('click', goArchive);
  els.sfx.addEventListener('click', () => { sfx.toggle(); updateChips(); sfx.tick(); });

  startDaily();
  setInterval(refreshDay, 1000);
  setInterval(() => {
    if (!document.hidden && !$('sage-quote').children.length && Math.random() < 0.5) say('idle');
  }, 40000);
  setTimeout(() => say('start'), 700);
}

if (typeof document !== 'undefined') boot();