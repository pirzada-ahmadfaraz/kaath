'use strict';
// Room = 4 seats + optional Game. Owns timers for bots, trick collection and AFK auto-play.

const crypto = require('crypto');
const { Game } = require('./game');
const bot = require('./bot');

const DELAY = { botTrump: 900, botPlay: 750, collect: 1500, nextHand: 6000, afk: 30000 };
const EMPTY_ROOM_TTL = 10 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['Bot Akbar', 'Bot Bilal', 'Bot Chaand', 'Bot Dilawar'];

const randomId = () => crypto.randomBytes(8).toString('hex');

class Room {
  constructor(code, io, onExpire) {
    this.code = code;
    this.io = io;
    this.onExpire = onExpire;
    this.seats = [null, null, null, null];
    this.hostId = null;
    this.game = null;
    this.timer = null;
    this.expireTimer = null;
    this.rtcPeers = new Set(); // publicIds currently in the video call
  }

  seatOf(playerId) {
    return this.seats.findIndex((s) => s && !s.isBot && s.playerId === playerId);
  }

  requireSeat(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) throw new Error('You are not in this room');
    return seat;
  }

  requireHost(playerId) {
    if (playerId !== this.hostId) throw new Error('Only the host can do that');
  }

  get inLobby() {
    return !this.game;
  }

  join(playerId, name, socketId) {
    let seat = this.seatOf(playerId);
    if (seat === -1) {
      seat = this.seats.findIndex((s) => s === null);
      if (seat === -1) seat = this.seats.findIndex((s) => s.isBot); // take over a bot
      if (seat === -1) throw new Error('Room is full');
      this.seats[seat] = { playerId, publicId: randomId(), name, isBot: false, connected: true, socketId };
    } else {
      Object.assign(this.seats[seat], { name, connected: true, socketId });
    }
    if (this.seatOf(this.hostId) === -1) this.hostId = playerId;
    clearTimeout(this.expireTimer);
    this.changed();
    return this.seats[seat];
  }

  leave(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    this.rtcPeers.delete(this.seats[seat].publicId);
    if (this.inLobby) {
      this.seats[seat] = null;
    } else {
      this.seats[seat] = this.makeBot(seat, `${this.seats[seat].name} (bot)`);
    }
    if (this.hostId === playerId) {
      const next = this.seats.find((s) => s && !s.isBot);
      this.hostId = next ? next.playerId : null;
    }
    this.changed();
    this.checkEmpty();
  }

  disconnect(playerId, socketId) {
    const seat = this.seatOf(playerId);
    if (seat === -1 || this.seats[seat].socketId !== socketId) return null;
    const s = this.seats[seat];
    s.connected = false;
    this.rtcPeers.delete(s.publicId);
    this.changed();
    this.checkEmpty();
    return s.publicId;
  }

  checkEmpty() {
    if (this.seats.some((s) => s && !s.isBot && s.connected)) return;
    clearTimeout(this.expireTimer);
    this.expireTimer = setTimeout(() => this.destroy(), EMPTY_ROOM_TTL);
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.expireTimer);
    this.onExpire(this.code);
  }

  makeBot(seat, name) {
    return { playerId: null, publicId: randomId(), name: name || BOT_NAMES[seat], isBot: true, connected: true };
  }

  moveSeat(playerId, to) {
    const from = this.requireSeat(playerId);
    if (!this.inLobby) throw new Error('Game already started');
    if (this.seats[to] !== null) throw new Error('Seat taken');
    this.seats[to] = this.seats[from];
    this.seats[from] = null;
    this.changed();
  }

  addBot(playerId, seat) {
    this.requireHost(playerId);
    if (!this.inLobby) throw new Error('Game already started');
    if (this.seats[seat] !== null) throw new Error('Seat taken');
    this.seats[seat] = this.makeBot(seat);
    this.changed();
  }

  removeBot(playerId, seat) {
    this.requireHost(playerId);
    if (!this.inLobby) throw new Error('Game already started');
    if (!this.seats[seat]?.isBot) throw new Error('Not a bot');
    this.seats[seat] = null;
    this.changed();
  }

  start(playerId, options) {
    this.requireHost(playerId);
    if (!this.inLobby) throw new Error('Game already started');
    if (this.seats.some((s) => s === null)) throw new Error('Need 4 players (add bots to fill seats)');
    this.game = new Game(options);
    this.game.startHand();
    this.changed();
  }

  setCaller(playerId, seat) {
    this.requireHost(playerId);
    if (!this.game) throw new Error('No game');
    this.game.setCaller(seat);
    this.changed();
  }

  chooseTrump(playerId, suit) {
    if (!this.game) throw new Error('No game');
    this.game.chooseTrump(this.requireSeat(playerId), suit);
    this.changed();
  }

  play(playerId, card) {
    if (!this.game) throw new Error('No game');
    this.game.playCard(this.requireSeat(playerId), card);
    this.changed();
  }

  nextHand(playerId) {
    this.requireSeat(playerId);
    if (this.game?.phase !== 'handOver') throw new Error('Hand not over');
    this.game.startHand();
    this.changed();
  }

  backToLobby(playerId) {
    this.requireHost(playerId);
    if (this.game && this.game.phase !== 'gameOver') throw new Error('Game still running');
    this.game = null;
    this.changed();
  }

  changed() {
    this.broadcast();
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const g = this.game;
    if (!g) return;
    const run = (ms, fn) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        try { fn(); } catch (e) { console.error(`[room ${this.code}]`, e); }
        this.changed();
      }, ms);
    };
    const actorDelay = (seat, botMs) => {
      const s = this.seats[seat];
      if (s.isBot) return botMs;
      return s.connected ? null : DELAY.afk;
    };

    if (g.phase === 'choosingCaller') {
      // Fall back to the rules if the host has dropped.
      const host = this.seats[this.seatOf(this.hostId)];
      if (!host?.connected) run(DELAY.afk, () => g.setCaller(g.suggestedCaller));
    } else if (g.phase === 'choosingTrump') {
      const ms = actorDelay(g.caller, DELAY.botTrump);
      if (ms !== null) run(ms, () => g.chooseTrump(g.caller, bot.chooseTrump(g.hands[g.caller])));
    } else if (g.phase === 'playing') {
      const seat = g.turn;
      const ms = actorDelay(seat, DELAY.botPlay);
      if (ms !== null) run(ms, () => g.playCard(seat, bot.chooseCard(g, seat)));
    } else if (g.phase === 'trickEnd') {
      run(DELAY.collect, () => g.collectTrick());
    } else if (g.phase === 'handOver') {
      run(DELAY.nextHand, () => g.startHand());
    }
  }

  viewFor(seat) {
    const me = this.seats[seat];
    return {
      code: this.code,
      you: { seat, publicId: me.publicId, isHost: me.playerId === this.hostId },
      hostPublicId: this.seats.find((s) => s && s.playerId === this.hostId)?.publicId ?? null,
      seats: this.seats.map((s) => s && {
        name: s.name, isBot: s.isBot, connected: s.connected, publicId: s.publicId,
      }),
      game: this.game ? this.game.viewFor(seat) : null,
    };
  }

  broadcast() {
    this.seats.forEach((s, i) => {
      if (s && !s.isBot && s.connected) this.io.to(s.socketId).emit('state', this.viewFor(i));
    });
  }

  socketOfPublic(publicId) {
    const s = this.seats.find((x) => x && !x.isBot && x.publicId === publicId && x.connected);
    return s ? s.socketId : null;
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  create() {
    let code;
    do {
      code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this.io, (c) => this.rooms.delete(c));
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim());
  }
}

module.exports = { Room, RoomManager };
