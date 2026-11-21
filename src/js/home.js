/* =========================================================
   SLICE - home.js
   Modes: Daily (one word per date) and Unlimited (random words).
   Archive is still a placeholder.
   ========================================================= */

const MAX_GUESSES = 4;
const MIN_TILES = 6;            // placeholder tiles per empty row
const LAUNCH_DAY = Date.UTC(2026, 10, 21) / 86400000; // daily #1 = Nov 21, 2026

// Clue button stages: 0 -> press shows letter counts, 1 -> press shows hint, 2 -> press reveals word
const CLUE_LABELS = ['CLUE 1/3', 'HINT 2/3', 'REVEAL 3/3'];
const CLUE_TITLES = [
  'Show how many letters each part has',
  'Show the extra hint',
  'Give up and reveal the word',
];
const STATUS_LABEL = { green: 'IN POSITION', yellow: 'WRONG SPOT' };

const state = {
  mode: 'daily',   // 'daily' | 'unlimited'
  word: '',
  parts: [],
  starts: [],
  clues: [],
  entry: null,
  guesses: [],
  slotState: [],   // 'green' | 'yellow' | null per part (best result so far)
  clueLevel: 0,    // how many clue presses have been used (0-2)
  revealed: false, // word was revealed with the clue button
  armed: false,    // final clue press needs a confirming second click
  armTimer: null,
  over: false,
  won: false,
  busy: false,
  storageKey: null, // null = nothing is saved (unlimited)
  recent: [],       // unlimited words already served
  unlimitedCount: 0,
};

const data = { games: {}, parts: {}, dict: new Set() };
let els = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------
   Deterministic clue selection
   --------------------------------------------------------- */

// FNV-1a 32-bit string hash
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The same full word always yields the same clue for each part.
function pickClues(word, parts, partsDb) {
  return parts.map((part, i) => {
    const options = Array.isArray(partsDb[part]) && partsDb[part].length ? partsDb[part] : [part];
    let hashed = fnv1a(`${word}#${i}`);
    if (state.mode == "unlimited") {
      hashed += Math.floor(Date.now() / 1000); // add rng
    }
    return options[hashed % options.length];
  });
}

/* ---------------------------------------------------------
   Core guess evaluation
   Green  = subword in guess sits at the same distance from the
            left OR right end as in the hidden word.
   Yellow = subword is in the guess, but elsewhere.
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
  const letters = new Array(guess.length).fill(null); // per-letter: 'green' | 'yellow' | null
  const partResults = parts.map(() => null);

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
    });
    partResults[i] = status;
  });

  return { letters, partResults };
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

// Random word that hasn't been served yet this session; resets once the pool is used up.
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
  if (data.dict.size === 0) return true; // dictionary not populated yet -> accept any word
  return data.dict.has(w);
}

/* ---------------------------------------------------------
   Rendering
   --------------------------------------------------------- */

function buildRow(i, word = '', states = null, tileCount = null) {
  const row = els.grid.children[i];
  row.replaceChildren();
  const count = tileCount ?? Math.max(MIN_TILES, word.length);
  for (let k = 0; k < count; k++) {
    const t = document.createElement('div');
    t.className = 'tile';
    if (k < word.length) {
      t.textContent = word[k];
      t.classList.add('filled');
      if (states) t.dataset.state = states[k] || 'miss';
    } else {
      t.classList.add('empty');
    }
    row.appendChild(t);
  }
}

function buildGrid() {
  els.grid.replaceChildren();
  for (let i = 0; i < MAX_GUESSES; i++) {
    const row = document.createElement('div');
    row.className = 'guess-row';
    els.grid.appendChild(row);
    buildRow(i);
  }
}

// Slots never show letters while playing. Top line = letter count (after the first
// clue press), bottom line = match status. Once the round ends the part is shown.
function renderSlots() {
  els.slots.replaceChildren();
  state.parts.forEach((part, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const st = state.won ? 'green' : state.slotState[i];
    if (st) slot.dataset.state = st;

    const count = document.createElement('span');
    count.className = 'slot-count';
    count.textContent = `${part.length} LETTERS`;
    if (state.clueLevel < 1) count.classList.add('is-hidden');

    const clue = document.createElement('span');
    clue.className = 'slot-clue';
    clue.textContent = state.clues[i];

    const foot = document.createElement('span');
    foot.className = 'slot-foot';
    foot.textContent = state.over ? part.toUpperCase() : st ? STATUS_LABEL[st] : '';

    slot.append(count, clue, foot);
    els.slots.appendChild(slot);
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
  els.msg.className = 'mb-2 min-h-6 text-center text-xl tracking-wide' + (kind ? ` msg-${kind}` : '');
}

function updateHint() {
  const show = state.clueLevel >= 2 && state.entry?.clue;
  els.hint.classList.toggle('hidden', !show);
  if (show) els.hint.textContent = `HINT: ${state.entry.clue}`;
}

function updateClueButton() {
  const b = els.clue;
  b.disabled = state.over;
  if (state.over) {
    b.textContent = CLUE_LABELS[Math.min(state.clueLevel, 2)];
    b.title = '';
    return;
  }
  b.textContent = state.armed ? 'SURE?' : CLUE_LABELS[state.clueLevel];
  b.title = CLUE_TITLES[state.clueLevel];
}

// Everything that depends on the round being over or in progress.
function applyEndState() {
  els.input.disabled = state.over;
  els.submit.disabled = state.over;
  els.next.classList.toggle('hidden', !(state.over && state.mode === 'unlimited'));
  renderSlots();
  updateHint();
  updateClueButton();
}

function setActiveMode() {
  [['daily', els.btnDaily], ['unlimited', els.btnUnlimited]].forEach(([m, btn]) =>
    btn.setAttribute('aria-pressed', String(state.mode === m))
  );
}

function previewTyping() {
  if (state.over || state.busy) return;
  const row = state.guesses.length;
  const typed = els.input.value.toLowerCase().replace(/[^a-z]/g, '');
  buildRow(row, typed);
}

/* ---------------------------------------------------------
   Reveal animation: slash first (if there is a hit), then the
   tiles get cut and colored left-to-right.
   --------------------------------------------------------- */

async function revealRow(i, guess, result, win) {
  const row = els.grid.children[i];
  buildRow(i, guess, null, guess.length);
  const tiles = [...row.children];
  const states = win ? guess.split('').map(() => 'green') : result.letters;
  const hasHit = states.some(Boolean);

  if (hasHit) {
    const slash = document.createElement('div');
    slash.className = 'slash-line';
    row.appendChild(slash);
    await sleep(380);
    slash.remove();
  }

  tiles.forEach((t, k) => {
    setTimeout(() => {
      t.dataset.state = states[k] || 'miss';
      if (states[k]) t.classList.add('cut');
    }, k * 70);
  });
  await sleep(tiles.length * 70 + 380);
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
   Clue button: counts -> hint -> reveal (with a confirm)
   --------------------------------------------------------- */

function disarm() {
  clearTimeout(state.armTimer);
  state.armed = false;
}

function pressClue() {
  if (state.over || state.busy) return;

  if (state.clueLevel === 0) {
    state.clueLevel = 1;
    renderSlots();
  } else if (state.clueLevel === 1) {
    state.clueLevel = 2;
    updateHint();
  } else {
    // Final stage gives up the round, so ask for a second click.
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
   Persistence (daily only, so a refresh doesn't reset the puzzle)
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
    buildRow(idx, g, win ? g.split('').map(() => 'green') : result.letters.map((l) => l || 'miss'), g.length);
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
    starts: partStarts(word, entry.parts),
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

function startUnlimited() {
  state.mode = 'unlimited';
  state.unlimitedCount += 1;
  els.puzzle.textContent = `UNLIMITED #${state.unlimitedCount}`;
  startGame(randomWord(), null);
}

/* ---------------------------------------------------------
   Scenery: dense bamboo, falling petals, floating pixels
   (seeded -> stable layout between reloads)
   --------------------------------------------------------- */

function rng(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function buildScenery() {
  const rand = rng(20261121);
  const between = (a, b) => a + rand() * (b - a);
  const even = (n) => Math.round(n / 2) * 2;

  const stalks = (host, count, cls, wRange, hRange, seg) => {
    for (let i = 0; i < count; i++) {
      const s = document.createElement('div');
      s.className = `stalk ${cls}${rand() > 0.5 ? ' leafy' : ''}`;
      s.style.left = `${((i + rand() * 0.9) / count) * 100}%`;
      s.style.width = `${even(between(...wRange))}px`;
      s.style.height = `${between(...hRange)}vh`;
      s.style.setProperty('--seg', `${seg + Math.round(rand() * 3) * 8}px`);
      s.style.setProperty('--dur', `${between(4, 8).toFixed(1)}s`);
      s.style.setProperty('--delay', `-${between(0, 6).toFixed(1)}s`);
      host.appendChild(s);
    }
  };
  stalks(document.getElementById('bamboo-far'), 44, 'stalk-far', [8, 14], [50, 85], 40);
  stalks(document.getElementById('bamboo-mid'), 28, 'stalk-mid', [14, 22], [65, 100], 56);
  stalks(document.getElementById('bamboo-near'), 14, 'stalk-near', [22, 34], [80, 120], 80);

  const petals = document.getElementById('petals');
  for (let i = 0; i < 26; i++) {
    const p = document.createElement('div');
    const size = rand() > 0.5 ? 6 : 4;
    p.className = 'petal';
    p.style.left = `${between(0, 100)}%`;
    p.style.width = `${size}px`;
    p.style.height = `${size - 2}px`;
    p.style.setProperty('--dur', `${between(10, 20).toFixed(1)}s`);
    p.style.setProperty('--delay', `-${between(0, 20).toFixed(1)}s`);
    p.style.setProperty('--drift', `${-Math.round(between(10, 40))}vw`);
    petals.appendChild(p);
  }

  const motes = document.getElementById('motes');
  for (let i = 0; i < 45; i++) {
    const m = document.createElement('div');
    const size = rand() > 0.7 ? 3 : 2;
    m.className = 'mote';
    m.style.left = `${between(0, 100)}%`;
    m.style.top = `${between(8, 95)}%`;
    m.style.width = `${size}px`;
    m.style.height = `${size}px`;
    m.style.setProperty('--dur', `${between(6, 14).toFixed(1)}s`);
    m.style.setProperty('--delay', `-${between(0, 14).toFixed(1)}s`);
    m.style.setProperty('--dx', `${Math.round(between(-40, 40))}px`);
    m.style.setProperty('--dy', `${-Math.round(between(60, 160))}px`);
    motes.appendChild(m);
  }
}

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

async function loadJSON(file, optional = false) {
  try {
    const res = await fetch("src/data/" + file);
    if (!res.ok) throw new Error(`${file}: ${res.status}`);
    return await res.json();
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

async function init() {
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
    btnUnlimited: document.getElementById('btn-unlimited'),
    btnArchive: document.getElementById('btn-archive'),
  };

  buildScenery();
  buildGrid();

  try {
    [data.games, data.parts] = await Promise.all([loadJSON('games.json'), loadJSON('parts.json')]);
    const dict = await loadJSON('dictionary.json', true);
    data.dict = new Set((Array.isArray(dict) ? dict : []).map((w) => String(w).toLowerCase()));
  } catch (err) {
    console.error(err);
    setMessage('COULD NOT LOAD GAME DATA (serve over http)', 'lose');
    els.input.disabled = true;
    els.submit.disabled = true;
    els.clue.disabled = true;
    return;
  }

  els.form.addEventListener('submit', (e) => { e.preventDefault(); submitGuess(); });
  els.input.addEventListener('input', previewTyping);
  els.clue.addEventListener('click', pressClue);
  els.next.addEventListener('click', () => { if (!state.busy) startUnlimited(); });

  els.btnDaily.addEventListener('click', () => {
    if (state.busy || state.mode === 'daily') return;
    startDaily();
  });
  els.btnUnlimited.addEventListener('click', () => {
    if (state.busy) return;
    if (state.mode === 'unlimited' && !state.over) return setMessage('FINISH THIS WORD FIRST', 'warn');
    startUnlimited();
  });
  els.btnArchive.addEventListener('click', () => setMessage('ARCHIVE COMING SOON', 'warn'));

  startDaily();
}

if (typeof document !== 'undefined') init();