'use strict';
// Court Piece (Rang / Hokm) rules engine. Pure state machine, no I/O.
// Seats 0..3 clockwise. Teams: seats 0 & 2 vs seats 1 & 3.

const crypto = require('crypto');

const SUITS = ['S', 'H', 'C', 'D'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const TRICKS_TO_WIN = 7;
const TOTAL_TRICKS = 13;
const HAND_POINTS = 1;
const COURT_POINTS = 3; // winning the first 7 tricks in a row
const DEFAULT_TARGET = 7;

const suitOf = (c) => c.slice(-1);
const rankOf = (c) => c.slice(0, -1);
const rankValue = (c) => RANKS.indexOf(rankOf(c));
const teamOf = (seat) => seat % 2;

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand) {
  return hand.sort((a, b) =>
    SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)) || rankValue(b) - rankValue(a));
}

// trick: [{ seat, card }] in play order. Returns the seat currently winning.
function trickWinner(trick, trump) {
  let best = trick[0];
  for (const p of trick.slice(1)) {
    const bs = suitOf(best.card);
    const ps = suitOf(p.card);
    if (ps === bs) {
      if (rankValue(p.card) > rankValue(best.card)) best = p;
    } else if (ps === trump) {
      best = p;
    }
  }
  return best.seat;
}

function legalCards(hand, trick) {
  if (trick.length === 0) return hand.slice();
  const led = suitOf(trick[0].card);
  const following = hand.filter((c) => suitOf(c) === led);
  return following.length ? following : hand.slice();
}

class Game {
  // callerMode 'rules': the seat after the dealer calls trump, and the deal passes on when the
  // caller's team loses. callerMode 'host': the host picks the trump caller before every hand.
  constructor({ target = DEFAULT_TARGET, dealer, firstCaller, callerMode = 'rules', rand = crypto.randomInt } = {}) {
    this.rand = rand;
    this.target = target;
    this.callerMode = callerMode;
    this.dealer = firstCaller != null ? (firstCaller + 3) % 4 : dealer ?? rand(4);
    this.scores = [0, 0];
    this.handNumber = 0;
    this.history = [];
    this.phase = 'idle'; // idle | choosingCaller | choosingTrump | playing | trickEnd | handOver | gameOver
    this.hands = [[], [], [], []];
    this.trick = [];
    this.tricksWon = [0, 0];
    this.tricksBySeat = [0, 0, 0, 0];
    this.trump = null;
    this.caller = null;
    this.turn = null;
    this.lastTrick = null;
    this.pendingWinner = null;
    this.result = null;
  }

  startHand() {
    if (this.phase !== 'idle' && this.phase !== 'handOver') throw new Error('Cannot start a hand now');
    this.handNumber++;
    this.hands = [[], [], [], []];
    this.caller = null;
    this.trump = null;
    this.trick = [];
    this.tricksWon = [0, 0];
    this.tricksBySeat = [0, 0, 0, 0];
    this.lastTrick = null;
    this.pendingWinner = null;
    this.result = null;
    if (this.callerMode === 'host') {
      this.turn = null;
      this.phase = 'choosingCaller';
    } else {
      this.dealTo((this.dealer + 1) % 4);
    }
  }

  get suggestedCaller() {
    return (this.dealer + 1) % 4;
  }

  setCaller(seat) {
    if (this.phase !== 'choosingCaller') throw new Error('Not choosing the trump caller');
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) throw new Error('Invalid seat');
    this.dealer = (seat + 3) % 4;
    this.dealTo(seat);
  }

  // Caller gets their first 5 cards and must pick trump before the rest is dealt.
  dealTo(caller) {
    this.deck = shuffle(newDeck(), this.rand);
    this.caller = caller;
    this.hands[caller] = sortHand(this.deck.splice(0, 5));
    this.turn = caller;
    this.phase = 'choosingTrump';
  }

  chooseTrump(seat, suit) {
    if (this.phase !== 'choosingTrump') throw new Error('Not choosing trump');
    if (seat !== this.caller) throw new Error('Only the trump caller can choose');
    if (!SUITS.includes(suit)) throw new Error('Invalid suit');
    this.trump = suit;
    // Remaining deal: 5 to each other player, then two rounds of 4 to everyone.
    for (let i = 1; i < 4; i++) this.hands[(this.caller + i) % 4].push(...this.deck.splice(0, 5));
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) this.hands[(this.caller + i) % 4].push(...this.deck.splice(0, 4));
    }
    this.hands.forEach(sortHand);
    this.phase = 'playing';
    this.turn = this.caller;
  }

  legalFor(seat) {
    if (this.phase !== 'playing' || this.turn !== seat) return [];
    return legalCards(this.hands[seat], this.trick);
  }

  playCard(seat, card) {
    if (this.phase !== 'playing') throw new Error('Not in play');
    if (seat !== this.turn) throw new Error('Not your turn');
    if (!this.legalFor(seat).includes(card)) throw new Error('Illegal card');
    this.hands[seat].splice(this.hands[seat].indexOf(card), 1);
    this.trick.push({ seat, card });
    if (this.trick.length < 4) {
      this.turn = (seat + 1) % 4;
      return { trickComplete: false };
    }
    // Trick stays on the table until collectTrick() so clients can see it.
    this.pendingWinner = trickWinner(this.trick, this.trump);
    this.turn = null;
    this.phase = 'trickEnd';
    return { trickComplete: true, winner: this.pendingWinner };
  }

  collectTrick() {
    if (this.phase !== 'trickEnd') throw new Error('No trick to collect');
    const w = this.pendingWinner;
    this.tricksWon[teamOf(w)]++;
    this.tricksBySeat[w]++;
    this.lastTrick = { cards: this.trick, winner: w };
    this.trick = [];
    this.pendingWinner = null;
    if (this.tricksWon[0] >= TRICKS_TO_WIN || this.tricksWon[1] >= TRICKS_TO_WIN) {
      this.endHand();
    } else {
      this.phase = 'playing';
      this.turn = w;
    }
  }

  endHand() {
    const winTeam = this.tricksWon[0] > this.tricksWon[1] ? 0 : 1;
    const court = this.tricksWon[1 - winTeam] === 0;
    const points = court ? COURT_POINTS : HAND_POINTS;
    const callerTeam = teamOf(this.caller);
    this.scores[winTeam] += points;
    const gameOver = this.scores[winTeam] >= this.target;
    this.result = {
      winTeam, court, points, callerTeam, trump: this.trump,
      tricksWon: this.tricksWon.slice(), gameWinner: gameOver ? winTeam : null,
    };
    this.history.push(this.result);
    // Caller's team keeps the deal if they win; otherwise it passes on,
    // which hands the trump call to the other team.
    if (winTeam !== callerTeam) this.dealer = (this.dealer + 1) % 4;
    this.turn = null;
    this.phase = gameOver ? 'gameOver' : 'handOver';
  }

  viewFor(seat) {
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      dealer: this.dealer,
      caller: this.caller,
      callerMode: this.callerMode,
      suggestedCaller: this.suggestedCaller,
      trump: this.trump,
      turn: this.turn,
      hand: seat >= 0 ? this.hands[seat].slice() : [],
      legal: this.legalFor(seat),
      handCounts: this.hands.map((h) => h.length),
      trick: this.trick.slice(),
      pendingWinner: this.pendingWinner,
      tricksWon: this.tricksWon.slice(),
      tricksBySeat: this.tricksBySeat.slice(),
      lastTrick: this.lastTrick,
      scores: this.scores.slice(),
      target: this.target,
      result: this.result,
    };
  }
}

module.exports = {
  Game, SUITS, RANKS, suitOf, rankValue, teamOf, trickWinner, legalCards,
  TRICKS_TO_WIN, COURT_POINTS, HAND_POINTS,
};
