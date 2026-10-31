'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3999;
const call = (s, ev, p = {}) => new Promise((r) => s.emit(ev, p, r));

test('host + 1 friend + 2 bots can start and play over sockets', async (t) => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT }, stdio: 'pipe' });
  t.after(() => srv.kill());
  await new Promise((r) => srv.stdout.once('data', r));

  const a = io(`http://localhost:${PORT}`);
  const b = io(`http://localhost:${PORT}`);
  t.after(() => { a.close(); b.close(); });
  let stateA, stateB;
  a.on('state', (s) => { stateA = s; });
  b.on('state', (s) => { stateB = s; });

  const { code } = await call(a, 'room:create', { name: 'Ahmad', playerId: 'player-aaaaaaaa' });
  assert.match(code, /^[A-Z0-9]{5}$/);
  assert.ok((await call(b, 'room:join', { name: 'Bilal', playerId: 'player-bbbbbbbb', code })).ok);
  assert.ok((await call(b, 'bot:add', { seat: 2 })).error, 'non-host cannot add bots');
  assert.ok((await call(a, 'bot:add', { seat: 2 })).ok);
  assert.ok((await call(a, 'game:start')).error, 'needs 4');
  assert.ok((await call(a, 'bot:add', { seat: 3 })).ok);
  assert.ok((await call(a, 'game:start')).ok);
  await new Promise((r) => setTimeout(r, 100));

  // Opponents' cards must never leak.
  assert.ok(!stateB.game.hand.some((c) => stateA.game.hand.includes(c)));
  assert.ok(!('hands' in stateB.game));

  // Drive the two humans until the first trick has been collected.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const [s, st] of [[a, stateA], [b, stateB]]) {
      const g = st.game;
      if (g.phase === 'choosingTrump' && g.caller === st.you.seat) await call(s, 'game:trump', { suit: 'H' });
      if (g.phase === 'playing' && g.turn === st.you.seat) await call(s, 'game:play', { card: g.legal[0] });
    }
    if (stateA.game.lastTrick) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(stateA.game.lastTrick, 'a trick was completed');
  assert.strictEqual(stateA.game.tricksWon[0] + stateA.game.tricksWon[1], 1);
});
