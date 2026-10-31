'use strict';
// Simple heuristic bot so a table can be filled when fewer than 4 friends are online.

const { SUITS, suitOf, rankValue, teamOf, trickWinner } = require('./game');

function chooseTrump(hand) {
  let best = SUITS[0];
  let bestScore = -1;
  for (const s of SUITS) {
    const cards = hand.filter((c) => suitOf(c) === s);
    const score = cards.length * 100 + cards.reduce((n, c) => n + rankValue(c), 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

function chooseCard(game, seat) {
  const legal = game.legalFor(seat);
  const trump = game.trump;
  const cheapest = (cards) => cards.slice().sort((a, b) =>
    (suitOf(a) === trump) - (suitOf(b) === trump) || rankValue(a) - rankValue(b))[0];

  const trick = game.trick;
  if (trick.length === 0) {
    const aces = legal.filter((c) => c.startsWith('A') && suitOf(c) !== trump);
    return aces[0] || cheapest(legal);
  }

  const winning = trickWinner(trick, trump);
  if (teamOf(winning) === teamOf(seat) && trick.length >= 2) return cheapest(legal);

  const winners = legal.filter((c) => trickWinner([...trick, { seat, card: c }], trump) === seat);
  return winners.length ? cheapest(winners) : cheapest(legal);
}

module.exports = { chooseTrump, chooseCard };
