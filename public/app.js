import { Mesh } from './rtc.js';

const socket = io();
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const SUIT = { S: '♠', H: '♥', C: '♣', D: '♦' };
const SUIT_NAME = { S: 'Spades', H: 'Hearts', C: 'Clubs', D: 'Diamonds' };
const SUIT_HINT = { S: '', H: '', C: '', D: '' };
const POS = ['bottom', 'left', 'top', 'right'];
const FACE = new Set(['J', 'Q', 'K']);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Animation timings (ms).
const T = { shuffle: 1150, dealGap: 34, dealFly: 420, play: 380, collect: 560, reveal: 1300 };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let playerId = store.get('cp.playerId');
if (!playerId) { playerId = crypto.randomUUID(); store.set('cp.playerId', playerId); }

let state = null;        // last state applied to the screen
let roomCode = null;
let localStream = null;
let micOn = true;
let camOn = true;
const streams = new Map(); // publicId -> MediaStream

const mesh = new Mesh(socket, {
  onStream: (id, stream) => { streams.set(id, stream); renderVideos(); },
  onLeave: (id) => { streams.delete(id); renderVideos(); },
});

// ---------- helpers ----------
const posOf = (seat) => POS[(seat - state.you.seat + 4) % 4];
const seatAt = (pos) => (state.you.seat + POS.indexOf(pos)) % 4;
const isUs = (seat) => seat % 2 === state.you.seat % 2;
const myTeam = () => state.you.seat % 2;
const isRed = (cardOrSuit) => /[HD]$/.test(cardOrSuit);
function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}

function cardEl(card, extra = '') {
  const rank = card.slice(0, -1);
  const sym = SUIT[card.slice(-1)];
  const corner = () => el('div', { className: 'c-corner' }, el('b', { textContent: rank }), el('i', { textContent: sym }));
  const mid = FACE.has(rank)
    ? el('div', { className: 'c-mid face' }, el('b', { textContent: rank }), el('i', { textContent: sym }))
    : el('div', { className: 'c-mid', textContent: sym });
  const node = el('div', { className: `card ${isRed(card) ? 'red' : ''} ${rank === 'A' ? 'ace' : ''} ${extra}` }, corner(), mid, corner());
  node.dataset.card = card;
  return node;
}
const backEl = () => el('div', { className: 'card back' });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function emit(event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, (res) => {
    if (res?.error) toast(res.error);
    resolve(res || {});
  }));
}

function nameOf(seat) {
  const s = state.seats[seat];
  if (!s) return 'Open seat';
  return seat === state.you.seat ? 'You' : s.name;
}

const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const centerOf = (node) => center(node.getBoundingClientRect());
const tileOf = (seat) => $(`.seat[data-pos="${posOf(seat)}"] .tile`);

// ---------- landing ----------
for (const box of $$('[data-cards]')) {
  const cards = box.dataset.cards.split(' ');
  cards.forEach((c, i) => {
    const node = cardEl(c);
    const mid = (cards.length - 1) / 2;
    node.style.setProperty('--r', `${(i - mid) * 11}deg`);
    node.style.setProperty('--d', `${i * (box.classList.contains('demo-trick') ? 700 : 110)}ms`);
    box.append(node);
  });
}

$('#name').value = store.get('cp.name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) $('#code').value = params.get('room').toUpperCase();

function myName() {
  const n = $('#name').value.trim();
  if (!n) {
    $('#play').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#name').focus();
    toast('Enter your name first');
    return null;
  }
  store.set('cp.name', n);
  return n;
}

$('#create').onclick = async () => {
  const name = myName();
  if (!name) return;
  const res = await emit('room:create', { name, playerId });
  if (res.ok) enterRoom(res.code);
};
$('#join').onclick = join;
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('#code').value ? join() : $('#create').click()); });
$('#play').addEventListener('submit', (e) => e.preventDefault());
$$('a[href="#play"]').forEach((a) => a.addEventListener('click', () => setTimeout(() => $('#name').focus(), 400)));

async function join() {
  const name = myName();
  const code = $('#code').value.trim().toUpperCase();
  if (!name) return;
  if (!code) { $('#code').focus(); toast('Enter a table code'); return; }
  const res = await emit('room:join', { name, playerId, code });
  if (res.ok) enterRoom(res.code);
}

async function enterRoom(code) {
  roomCode = code;
  history.replaceState(null, '', `?room=${code}`);
  document.body.classList.add('in-room');
  $('#home').classList.add('hidden');
  $('#room').classList.remove('hidden');
  $('#room-code').textContent = code;
  await startMedia();
}

async function startMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Video needs HTTPS (or localhost)');
  } else if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 20 } },
      });
    } catch {
      toast('Camera/mic blocked. You can still play and see others.');
    }
  }
  mesh.setEnabled('audio', micOn);
  mesh.setEnabled('video', camOn);
  mesh.join(localStream);
  renderControls();
  renderVideos();
}

// Rejoin automatically after a network drop.
socket.on('connect', async () => {
  if (!roomCode) return;
  const res = await emit('room:join', { name: store.get('cp.name') || 'Player', playerId, code: roomCode });
  if (res.ok) {
    [...mesh.peers.keys()].forEach((id) => mesh.drop(id));
    mesh.join(localStream);
  } else {
    goHome();
  }
});

if (params.get('room') && store.get('cp.name')) join();

function goHome() {
  roomCode = null;
  state = null;
  queue.length = 0;
  history.replaceState(null, '', location.pathname);
  document.body.classList.remove('in-room');
  $('#room').classList.add('hidden');
  $('#home').classList.remove('hidden');
  $('#modal').classList.add('hidden');
}

// ---------- controls ----------
$('#copy').onclick = copyInvite;
async function copyInvite() {
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Court Piece', text: 'Join my Court Piece table', url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  } catch { /* share cancelled */ }
}
$('#mic').onclick = () => { micOn = !micOn; mesh.setEnabled('audio', micOn); renderControls(); };
$('#cam').onclick = () => { camOn = !camOn; mesh.setEnabled('video', camOn); renderControls(); renderVideos(); };
$('#leave').onclick = async () => {
  if (!confirm('Leave this table? A bot will take your seat if a game is running.')) return;
  mesh.leave();
  await emit('room:leave');
  goHome();
};

function renderControls() {
  $('#mic').classList.toggle('is-off', !micOn || !localStream?.getAudioTracks().length);
  $('#cam').classList.toggle('is-off', !camOn || !localStream?.getVideoTracks().length);
}

// ---------- speaking indicator ----------
const meters = new Map(); // MediaStream -> { analyser, data }
let audioCtx = null;
function meterFor(stream) {
  if (!stream?.getAudioTracks().length) return null;
  if (!meters.has(stream)) {
    try {
      audioCtx ??= new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      meters.set(stream, { analyser, data: new Uint8Array(analyser.frequencyBinCount) });
    } catch { return null; }
  }
  return meters.get(stream);
}
setInterval(() => {
  if (!state) return;
  audioCtx?.state === 'suspended' && audioCtx.resume().catch(() => {});
  for (const pos of POS) {
    const seat = seatAt(pos);
    const s = state.seats[seat];
    const stream = !s ? null : seat === state.you.seat ? (micOn ? localStream : null) : streams.get(s.publicId);
    const m = meterFor(stream);
    let level = 0;
    if (m) {
      m.analyser.getByteFrequencyData(m.data);
      level = m.data.reduce((a, b) => a + b, 0) / m.data.length;
    }
    $(`.seat[data-pos="${pos}"]`).classList.toggle('speaking', level > 18);
  }
}, 180);

// ---------- seats ----------
$$('.seat').forEach((s) => s.append($('#seat-tpl').content.cloneNode(true)));

function renderVideos() {
  if (!state) return;
  for (const pos of POS) {
    const seat = seatAt(pos);
    const s = state.seats[seat];
    const box = $(`.seat[data-pos="${pos}"]`);
    const video = $('video', box);
    let stream = null;
    if (s && seat === state.you.seat) stream = camOn ? localStream : null;
    else if (s) stream = streams.get(s.publicId) || null;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = seat === state.you.seat;
    const live = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
    box.classList.toggle('has-video', live);
    box.classList.toggle('mirror', seat === state.you.seat);
  }
}

function renderSeats() {
  const g = state.game;
  for (const pos of POS) {
    const seat = seatAt(pos);
    const s = state.seats[seat];
    const box = $(`.seat[data-pos="${pos}"]`);
    box.classList.toggle('empty', !s);
    box.classList.toggle('team-us', !!s && isUs(seat));
    box.classList.toggle('team-them', !!s && !isUs(seat));
    box.classList.toggle('turn', !!g && (g.turn === seat || (g.phase === 'choosingTrump' && g.caller === seat)));
    box.classList.toggle('away', !!s && !s.connected);

    $('.avatar', box).textContent = s ? (s.isBot ? '🤖' : s.name[0].toUpperCase()) : '+';
    $('.name', box).textContent = nameOf(seat);
    const meta = [];
    if (g?.trump) meta.push(`${g.tricksBySeat[seat]} ${g.tricksBySeat[seat] === 1 ? 'trick' : 'tricks'}`);
    if (s && !s.connected) meta.push('reconnecting…');
    $('.meta', box).textContent = meta.join(' · ');

    const badges = $('.badges', box);
    badges.replaceChildren();
    if (s && s.publicId === state.hostPublicId) badges.append(el('span', { className: 'badge', textContent: '👑', title: 'Host' }));
    if (g && g.dealer === seat && g.caller != null) badges.append(el('span', { className: 'badge', textContent: 'D', title: 'Dealer' }));
    if (g && g.caller === seat) {
      badges.append(el('span', {
        className: `badge rang ${g.trump && isRed(g.trump) ? 'red' : ''}`,
        textContent: g.trump ? SUIT[g.trump] : '★', title: 'Picks the rang',
      }));
    }

    const backs = $('.backs', box);
    const count = g && pos !== 'bottom' ? g.handCounts[seat] : 0;
    if (backs.childElementCount !== count) backs.replaceChildren(...Array.from({ length: count }, backEl));

    const actions = $('.seat-actions', box);
    actions.replaceChildren();
    if (!g) {
      if (!s) {
        actions.append(el('button', { className: 'btn btn-sm', textContent: 'Sit here', onclick: () => emit('seat:move', { seat }) }));
        if (state.you.isHost) actions.append(el('button', { className: 'btn btn-sm', textContent: '+ Bot', onclick: () => emit('bot:add', { seat }) }));
      } else if (s.isBot && state.you.isHost) {
        actions.append(el('button', { className: 'btn btn-sm', textContent: 'Remove', onclick: () => emit('bot:remove', { seat }) }));
      }
    }
  }
}

// ---------- table ----------
function renderTrick() {
  const g = state.game;
  $$('.slot').forEach((s) => s.replaceChildren());
  if (!g) return;
  for (const { seat, card } of g.trick) {
    const win = g.phase === 'trickEnd' && g.pendingWinner === seat;
    $(`.slot[data-pos="${posOf(seat)}"]`).append(cardEl(card, win ? 'winner' : ''));
  }
}

function renderHand() {
  const g = state.game;
  const hand = $('#hand');
  hand.replaceChildren();
  hand.classList.toggle('empty-hand', !g);
  if (!g) return;
  const myTurn = g.phase === 'playing' && g.turn === state.you.seat;
  hand.classList.toggle('my-turn', myTurn);
  const n = g.hand.length;
  g.hand.forEach((card, i) => {
    const legal = g.legal.includes(card);
    const c = cardEl(card, myTurn ? (legal ? 'playable' : 'disabled') : '');
    const o = i - (n - 1) / 2;
    c.style.setProperty('--o', o);
    c.style.setProperty('--o2', o * o);
    if (myTurn && legal) {
      c.tabIndex = 0;
      c.onclick = () => emit('game:play', { card });
      c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') emit('game:play', { card }); };
    }
    hand.append(c);
  });
}

function renderHud(prev) {
  const g = state.game;
  const us = myTeam();
  const setScore = (id, v) => {
    const node = $(id);
    if (node.textContent !== String(v)) {
      node.textContent = v;
      node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump');
    }
  };
  setScore('#score-us', g ? g.scores[us] : 0);
  setScore('#score-them', g ? g.scores[1 - us] : 0);
  for (const [id, team] of [['#pips-us', us], ['#pips-them', 1 - us]]) {
    const won = g?.trump ? g.tricksWon[team] : 0;
    $(id).replaceChildren(...Array.from({ length: 7 }, (_, i) => el('i', { className: i < won ? 'on' : '' })));
  }
  const chip = $('#rang');
  const trump = g?.trump;
  chip.classList.toggle('empty', !trump);
  chip.classList.toggle('red', !!trump && isRed(trump));
  $('.rang-sym', chip).textContent = trump ? SUIT[trump] : '?';
  chip.title = trump ? `Rang (trump): ${SUIT_NAME[trump]}` : 'Rang not chosen yet';
  if (trump && prev?.game?.trump !== trump) {
    chip.classList.remove('pop'); void chip.offsetWidth; chip.classList.add('pop');
  }
}

function renderStatus() {
  const g = state.game;
  const st = $('#status');
  st.classList.remove('mine');
  if (!g) { st.textContent = ''; return; }
  const me = state.you.seat;
  let text = '';
  if (g.phase === 'choosingCaller') text = state.you.isHost ? 'Choose who picks the rang' : 'Host is choosing who picks the rang…';
  else if (g.phase === 'choosingTrump') text = g.caller === me ? 'Pick the rang' : `${nameOf(g.caller)} is picking the rang…`;
  else if (g.phase === 'playing') text = g.turn === me ? 'Your turn: play a card' : `${nameOf(g.turn)} is playing…`;
  else if (g.phase === 'trickEnd') text = `${nameOf(g.pendingWinner)} ${g.pendingWinner === me ? 'take' : 'takes'} the trick`;
  st.textContent = text;
  st.classList.toggle('mine', (g.phase === 'playing' && g.turn === me) || (g.phase === 'choosingTrump' && g.caller === me));
}

function renderLobby() {
  const lobby = $('#lobby');
  const inLobby = !state.game;
  $('#stage').classList.toggle('lobby-mode', inLobby);
  $('#room-main').classList.toggle('with-lobby', inLobby);
  lobby.classList.toggle('hidden', !inLobby);
  if (!inLobby) return;

  const filled = state.seats.filter(Boolean).length;
  const previous = Object.fromEntries($$('select', lobby).map((x) => [x.id, x.value]));
  const teamNames = (team) => [team, team + 2].map((s) => (state.seats[s] ? nameOf(s) : 'Open seat')).join(' & ');

  lobby.replaceChildren(
    el('div', {},
      el('h2', { textContent: 'Table setup' }),
      el('p', { className: 'sub', textContent: `${filled} of 4 seats filled. Partners sit opposite each other.` })),
    el('div', { className: 'invite' },
      el('div', { className: 'muted', textContent: 'Invite friends with this code' }),
      el('div', { className: 'big-code', textContent: state.code }),
      el('button', { className: 'btn btn-ghost', textContent: 'Copy invite link', onclick: copyInvite })),
    el('div', { className: 'teams' },
      el('div', { className: 'team-box us' }, el('h4', { textContent: 'Your team' }), el('p', { textContent: teamNames(myTeam()) })),
      el('div', { className: 'team-box them' }, el('h4', { textContent: 'Opponents' }), el('p', { textContent: teamNames(1 - myTeam()) }))),
  );

  if (state.you.isHost) {
    const select = (id, label, options, fallback) => {
      const value = previous[id] ?? fallback;
      return el('label', { className: 'field' }, label, el('select', { id },
        ...options.map(([v, t]) => el('option', { value: v, textContent: t, selected: String(v) === String(value) }))));
    };
    lobby.append(
      select('first-caller', 'First to pick the rang', [['', 'Random'],
        ...state.seats.map((s, i) => s && [i, nameOf(i)]).filter(Boolean)], ''),
      select('caller-mode', 'Each new hand', [['rules', 'Follow the rules (losing team passes)'],
        ['host', 'Host chooses who picks']], 'rules'),
      select('target', 'Game length', [3, 5, 7, 11, 15].map((n) => [n, `First to ${n} points`]), 7),
      el('button', {
        className: 'btn btn-gold btn-lg', textContent: filled < 4 ? `Waiting for ${4 - filled} more…` : 'Shuffle & deal', disabled: filled < 4,
        onclick: () => emit('game:start', {
          target: Number($('#target').value),
          callerMode: $('#caller-mode').value,
          firstCaller: $('#first-caller').value,
        }),
      }),
    );
    if (filled < 4) lobby.append(el('p', { className: 'muted', textContent: 'Tip: use "+ Bot" on an empty seat to practise.' }));
  } else {
    lobby.append(el('div', { className: 'waiting' },
      el('span', { className: 'dots' }, el('i'), el('i'), el('i')), 'Waiting for the host to deal'));
  }
}

let modalKey = null;
function renderModal(delay = 0) {
  const g = state.game;
  const modal = $('#modal');
  const body = $('.modal-body', modal);
  let key = null;

  if (g?.phase === 'choosingCaller' && state.you.isHost) {
    key = `caller-${g.handNumber}`;
    if (modalKey !== key) {
      body.replaceChildren(
        el('h2', { textContent: 'Who picks the rang?' }),
        el('p', { className: 'muted', textContent: 'They get 5 cards first and choose the trump suit.' }),
        el('div', { className: 'caller-grid' }, ...state.seats.map((s, seat) => el('button', {
          className: isUs(seat) ? 'team-us' : 'team-them',
          onclick: () => emit('game:caller', { seat }),
        }, el('b', { textContent: nameOf(seat) }),
          el('small', { textContent: seat === g.suggestedCaller ? 'next by the rules' : (isUs(seat) ? 'your team' : 'opponents') })))),
      );
    }
  } else if (g?.phase === 'choosingTrump' && g.caller === state.you.seat) {
    key = `trump-${g.handNumber}`;
    if (modalKey !== key) {
      const counts = Object.fromEntries(Object.keys(SUIT).map((s) => [s, g.hand.filter((c) => c.endsWith(s)).length]));
      const most = Math.max(...Object.values(counts));
      body.replaceChildren(
        el('h2', { textContent: 'Pick the rang' }),
        el('p', { className: 'muted', textContent: 'These are your first 5 cards. Any suit you choose becomes trump for this hand.' }),
        el('div', { className: 'mini-hand' }, ...g.hand.map((c, i) => {
          const node = cardEl(c);
          node.style.setProperty('--i', i);
          return node;
        })),
        el('div', { className: 'suit-grid' }, ...Object.keys(SUIT).map((s) => el('button', {
          className: `suit-btn ${isRed(s) ? 'red' : ''} ${counts[s] === most ? 'best' : ''}`,
          onclick: () => emit('game:trump', { suit: s }),
        }, el('span', { className: 'big', textContent: SUIT[s] }),
          el('span', { className: 'nm', textContent: SUIT_NAME[s] + (SUIT_HINT[s] ? ` (${SUIT_HINT[s]})` : '') }),
          el('small', { textContent: `You hold ${counts[s]}` })))),
      );
    }
  } else if (g && (g.phase === 'handOver' || g.phase === 'gameOver') && g.result) {
    const r = g.result;
    const us = myTeam();
    const won = r.winTeam === us;
    key = `result-${g.handNumber}-${g.phase}`;
    if (modalKey !== key) {
      const over = g.phase === 'gameOver';
      const icon = over ? (won ? '🏆' : '🥈') : r.court ? '🔥' : won ? '🎉' : '😤';
      const title = over
        ? (won ? 'Your team wins the game!' : 'The other team wins the game')
        : r.court ? (won ? 'COURT! 7 tricks straight' : 'Court against you!') : (won ? 'Your team takes the hand' : 'They take the hand');
      const total = r.tricksWon[0] + r.tricksWon[1];
      body.replaceChildren(
        el('div', { className: 'result-icon', textContent: icon }),
        el('h2', { textContent: title }),
        el('div', { className: 'trick-bar' },
          el('div', { className: 'us', style: `width:${(r.tricksWon[us] / total) * 100}%` }),
          el('div', { className: 'them', style: `width:${(r.tricksWon[1 - us] / total) * 100}%` })),
        el('p', { className: 'muted', textContent: `Tricks ${r.tricksWon[us]}–${r.tricksWon[1 - us]} · +${r.points} point${r.points > 1 ? 's' : ''} to ${won ? 'your team' : 'them'}` }),
        el('div', { className: 'big-score' },
          el('span', { className: 'us', textContent: g.scores[us] }), el('small', { textContent: over ? 'final' : `to ${g.target}` }),
          el('span', { className: 'them', textContent: g.scores[1 - us] })),
      );
      if (!over) body.append(el('button', { className: 'btn btn-gold btn-lg', textContent: 'Deal next hand', onclick: () => emit('game:next') }));
      else if (state.you.isHost) body.append(el('button', { className: 'btn btn-gold btn-lg', textContent: 'Back to lobby', onclick: () => emit('game:lobby') }));
      else body.append(el('p', { className: 'muted', textContent: 'Waiting for the host…' }));
    }
  }

  if (key && modalKey !== key) modal.style.setProperty('--delay', `${Math.round(delay)}ms`);
  modalKey = key;
  modal.classList.toggle('hidden', !key);
}

// =========================================================
// Animations. States are applied one at a time; each may schedule
// animations, and the next state waits until they have played out.
// =========================================================
const fx = $('#fx');
let animUntil = 0;

function flyNode(node, from, to, { delay = 0, duration = 400, rotate = 0, scale = [1, 1], fade = false } = {}) {
  node.classList.add('fly');
  node.style.left = `${from.x}px`;
  node.style.top = `${from.y}px`;
  fx.append(node);
  const a = node.animate([
    { transform: `translate(-50%, -50%) scale(${scale[0]})`, opacity: 1 },
    { transform: `translate(calc(-50% + ${to.x - from.x}px), calc(-50% + ${to.y - from.y}px)) rotate(${rotate}deg) scale(${scale[1]})`, opacity: fade ? 0 : 1 },
  ], { duration, delay, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'both' });
  a.onfinish = () => node.remove();
  a.oncancel = () => node.remove();
}

// Animate a node already in its final place, starting from another screen point.
function flyIn(node, from, { delay = 0, duration = 400, rotate = 0, scale = 1 } = {}) {
  const to = centerOf(node);
  node.animate([
    { translate: `${from.x - to.x}px ${from.y - to.y}px`, scale, rotate: `${rotate}deg`, opacity: 0.4 },
    { translate: '0 0', scale: 1, rotate: '0deg', opacity: 1 },
  ], { duration, delay, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
}

const deck = $('#deck');
let deckHide;
function showDeck(from, until) {
  setTimeout(() => {
    if (!deck.childElementCount) deck.replaceChildren(...Array.from({ length: 8 }, (_, i) => {
      const b = backEl();
      b.style.translate = `${-i * 0.6}px ${-i * 0.6}px`;
      return b;
    }));
    deck.classList.add('show');
  }, from);
  clearTimeout(deckHide);
  deckHide = setTimeout(() => deck.classList.remove('show'), until);
}

function shuffleAnim(t0) {
  showDeck(t0, t0 + T.shuffle + 4000);
  setTimeout(() => {
    $$('.card', deck).forEach((c, i) => {
      const side = i % 2 ? 1 : -1;
      c.animate([
        { transform: 'none' },
        { transform: `translateX(${side * 70}px) rotate(${side * 14}deg)`, offset: 0.22 },
        { transform: `translateY(${-i}px)`, offset: 0.45 },
        { transform: `translateX(${side * 55}px) rotate(${side * 10}deg)`, offset: 0.68 },
        { transform: 'none' },
      ], { duration: T.shuffle, delay: i * 18, easing: 'ease-in-out' });
    });
  }, t0);
  return T.shuffle + 150;
}

function revealAnim(t0, suit) {
  setTimeout(() => {
    const c = centerOf($('.felt'));
    const node = el('div', { className: 'reveal' },
      el('div', { className: `orb ${isRed(suit) ? 'red' : ''}`, textContent: SUIT[suit] }),
      el('div', { className: 'caption', textContent: `${SUIT_NAME[suit]} is the rang` }));
    node.style.left = `${c.x}px`;
    node.style.top = `${c.y}px`;
    fx.append(node);
    node.animate([
      { opacity: 0, transform: 'scale(.3) rotate(-20deg)' },
      { opacity: 1, transform: 'scale(1.08)', offset: 0.25 },
      { opacity: 1, transform: 'scale(1)', offset: 0.7 },
      { opacity: 0, transform: 'scale(.6) translateY(-40px)' },
    ], { duration: T.reveal, easing: 'ease-out' }).onfinish = () => node.remove();
  }, t0);
  return T.reveal * 0.75;
}

// inc[seat] = cards gained; my new cards fly into their real place in the hand.
function dealAnim(t0, inc, firstSeat, myNewCards) {
  const order = [];
  const left = inc.slice();
  for (let seat = firstSeat; left.some((n) => n > 0); seat = (seat + 1) % 4) {
    if (left[seat] > 0) { order.push(seat); left[seat]--; }
  }
  const total = order.length * T.dealGap + T.dealFly;
  showDeck(t0, t0 + total);
  const origin = centerOf(deck);
  const mine = $$('#hand .card').filter((c) => myNewCards.includes(c.dataset.card));
  let m = 0;
  order.forEach((seat, j) => {
    const delay = t0 + j * T.dealGap;
    if (seat === state.you.seat && mine[m]) {
      flyIn(mine[m++], origin, { delay, duration: T.dealFly, rotate: -20, scale: 0.7 });
    } else {
      const tile = tileOf(seat);
      if (tile) flyNode(backEl(), origin, centerOf(tile), { delay, duration: T.dealFly, rotate: 160 + j * 7, scale: [1, 0.45], fade: true });
    }
  });
  return total;
}

function collectAnim(t0, cards, winner) {
  const to = centerOf(tileOf(winner));
  cards.forEach(({ node, rect }, i) => {
    const clone = node.cloneNode(true);
    clone.classList.remove('winner');
    clone.style.width = `${rect.width}px`;
    flyNode(clone, center(rect), to, { delay: t0 + i * 45, duration: T.collect, rotate: (i - 1.5) * 25, scale: [1, 0.35], fade: true });
  });
  return T.collect * 0.6;
}

function apply(next, animate) {
  const prev = state && state.code === next.code ? state : null;
  const pg = prev?.game;
  // Capture positions from the outgoing screen before re-rendering.
  const oldTrick = $$('.slot .card').map((node) => ({ node, rect: node.getBoundingClientRect() }));
  const oldHand = new Map($$('#hand .card').map((c) => [c.dataset.card, centerOf(c)]));

  state = next;
  renderHud(prev);
  renderSeats();
  renderVideos();
  renderTrick();
  renderHand();
  renderStatus();
  renderLobby();

  const g = next.game;
  let t = 0;
  if (animate && !reduceMotion && prev && g) {
    // 1. Previous trick sweeps to its winner.
    if (pg?.phase === 'trickEnd' && g.trick.length === 0 && oldTrick.length) t += collectAnim(t, oldTrick, pg.pendingWinner);

    // 2. New hand: shuffle.
    const newHand = !pg || pg.handNumber !== g.handNumber;
    if (newHand) t += shuffleAnim(t);

    // 3. Rang reveal.
    if (g.trump && (newHand || !pg.trump)) t += revealAnim(t, g.trump);

    // 4. Deal any new cards.
    const before = newHand ? [0, 0, 0, 0] : pg.handCounts;
    const inc = g.handCounts.map((n, i) => Math.max(0, n - before[i]));
    if (inc.some(Boolean)) {
      const known = new Set(newHand ? [] : pg.hand);
      t += dealAnim(t, inc, g.caller ?? 0, g.hand.filter((c) => !known.has(c)));
    }

    // 5. Newly played cards fly from their player to the table.
    const prevCards = new Set(pg && pg.handNumber === g.handNumber ? pg.trick.map((p) => p.card) : []);
    for (const { seat, card } of g.trick) {
      if (prevCards.has(card)) continue;
      const node = $(`.slot .card[data-card="${card}"]`);
      const from = seat === next.you.seat && oldHand.get(card) ? oldHand.get(card) : centerOf(tileOf(seat));
      flyIn(node, from, { delay: t, duration: T.play, rotate: seat === next.you.seat ? 0 : 90, scale: seat === next.you.seat ? 1 : 0.5 });
      t += T.play * 0.7;
    }
  }
  renderModal(t);
  animUntil = performance.now() + t;
}

const queue = [];
let pumpTimer = null;
function pump() {
  clearTimeout(pumpTimer);
  while (queue.length) {
    const remaining = animUntil - performance.now();
    if (remaining > 0) { pumpTimer = setTimeout(pump, remaining); return; }
    // If we're far behind (background tab, slow device), skip animations to catch up.
    const animate = queue.length < 4 && !document.hidden;
    apply(queue.shift(), animate);
  }
}

socket.on('state', (s) => {
  queue.push(s);
  pump();
});

window.addEventListener('resize', () => { if (state) renderHand(); });
