'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, trickWinner, legalCards, suitOf } = require('../server/game');
const bot = require('../server/bot');

test('highest of led suit wins without trump', () => {
  const t = [{ seat: 0, card: '10H' }, { seat: 1, card: 'KH' }, { seat: 2, card: 'AS' }, { seat: 3, card: '2H' }];
  assert.strictEqual(trickWinner(t, 'D'), 1);
});

test('any trump beats the led suit; higher trump beats lower', () => {
  const t = [{ seat: 0, card: 'AH' }, { seat: 1, card: '2S' }, { seat: 2, card: 'KH' }, { seat: 3, card: '5S' }];
  assert.strictEqual(trickWinner(t, 'S'), 3);
});

test('must follow suit when able, otherwise anything', () => {
  assert.deepStrictEqual(legalCards(['AS', '3H', '4H'], [{ seat: 0, card: 'KH' }]).sort(), ['3H', '4H']);
  assert.deepStrictEqual(legalCards(['AS', '3C'], [{ seat: 0, card: 'KH' }]).sort(), ['3C', 'AS']);
});

test('deal: caller sees 5, then everyone ends with 13 unique cards', () => {
  const g = new Game({ dealer: 3 });
  g.startHand();
  assert.strictEqual(g.caller, 0);
  assert.deepStrictEqual(g.hands.map((h) => h.length), [5, 0, 0, 0]);
  const first5 = g.hands[0].slice();
  assert.throws(() => g.chooseTrump(1, 'H'));
  g.chooseTrump(0, 'H');
  assert.deepStrictEqual(g.hands.map((h) => h.length), [13, 13, 13, 13]);
  assert.ok(first5.every((c) => g.hands[0].includes(c)));
  assert.strictEqual(new Set(g.hands.flat()).size, 52);
  assert.strictEqual(g.turn, 0);
});

test('rejects out-of-turn and illegal plays', () => {
  const g = new Game({ dealer: 3 });
  g.startHand();
  g.chooseTrump(0, 'S');
  assert.throws(() => g.playCard(1, g.hands[1][0]), /turn/);
  const lead = g.hands[0][0];
  g.playCard(0, lead);
  const offSuit = g.hands[1].find((c) => suitOf(c) !== suitOf(lead));
  if (g.hands[1].some((c) => suitOf(c) === suitOf(lead)) && offSuit) {
    assert.throws(() => g.playCard(1, offSuit), /Illegal/);
  }
});

test('bots play many full games without breaking invariants', () => {
  for (let n = 0; n < 300; n++) {
    const g = new Game({ target: 5 });
    g.startHand();
    let guard = 0;
    while (g.phase !== 'gameOver' && guard++ < 10000) {
      if (g.phase === 'choosingTrump') g.chooseTrump(g.caller, bot.chooseTrump(g.hands[g.caller]));
      else if (g.phase === 'playing') g.playCard(g.turn, bot.chooseCard(g, g.turn));
      else if (g.phase === 'trickEnd') g.collectTrick();
      else if (g.phase === 'handOver') {
        const r = g.result;
        assert.ok(r.tricksWon[r.winTeam] === 7 && r.tricksWon[1 - r.winTeam] < 7);
        assert.strictEqual(r.court, r.tricksWon[1 - r.winTeam] === 0);
        g.startHand();
      }
    }
    assert.strictEqual(g.phase, 'gameOver');
    assert.ok(Math.max(...g.scores) >= 5);
  }
});

test('dealer passes on only when the caller team loses', () => {
  const g = new Game({ dealer: 0 });
  g.startHand();
  g.tricksWon = [0, 7];
  g.caller = 1; // team 1 called and won
  g.endHand();
  assert.strictEqual(g.dealer, 0);
  assert.strictEqual(g.result.court, true);
  assert.deepStrictEqual(g.scores, [0, 3]);
  g.phase = 'handOver';
  g.startHand();
  g.tricksWon = [7, 4];
  g.endHand(); // caller seat 1 lost
  assert.strictEqual(g.dealer, 1);
});

test('host mode: hand waits for a caller, then that seat gets 5 cards', () => {
  const g = new Game({ callerMode: 'host' });
  g.startHand();
  assert.strictEqual(g.phase, 'choosingCaller');
  assert.throws(() => g.chooseTrump(0, 'H'));
  g.setCaller(2);
  assert.strictEqual(g.phase, 'choosingTrump');
  assert.strictEqual(g.caller, 2);
  assert.deepStrictEqual(g.hands.map((h) => h.length), [0, 0, 5, 0]);
});

test('rules mode: firstCaller picks who calls the first hand', () => {
  const g = new Game({ firstCaller: 3 });
  g.startHand();
  assert.strictEqual(g.caller, 3);
});

test('example from the rules: A♥ 2♥ 3♥ then a trump — trump wins; following suit is forced', () => {
  const t = [{ seat: 0, card: 'AH' }, { seat: 1, card: '2H' }, { seat: 2, card: '3H' }, { seat: 3, card: '2S' }];
  assert.strictEqual(trickWinner(t, 'S'), 3);
  assert.deepStrictEqual(legalCards(['2S', '5H'], t.slice(0, 3)), ['5H']);
});
