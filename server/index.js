'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });
const rooms = new RoomManager(io);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.rooms.size, turn: hasTurn(cachedIce || staticIce()) }));

// STUN works for many home networks; a TURN server is needed between different networks
// with strict NATs (mobile data, offices, some ISPs). Metered.ca provides TURN.
//
// Metered has two kinds of key:
//   METERED_API_KEY    - a credential's API key; GET /api/v1/turn/credentials?apiKey=... returns iceServers.
//   METERED_SECRET_KEY - the account secret; it can't fetch iceServers directly, but it can create a
//                        credential (POST /api/v1/turn/credential?secretKey=...) whose apiKey can.
// Either works. With only the secret key we create a credential and reuse it until it expires.
const ICE_TTL = 10 * 60 * 1000;           // refresh iceServers every 10 minutes
const MINTED_TTL_S = 7 * 24 * 60 * 60;    // credentials we create live for a week
let cachedIce = null;
let cachedAt = 0;
let mintedKey = null;
let mintedUntil = 0;
let iceInflight = null;

const hasTurn = (list) => Array.isArray(list)
  && list.some((s) => [].concat(s?.urls || []).some((u) => /^turns?:/.test(u)));

async function meteredIceServers(domain, apiKey) {
  const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`);
  const body = await r.json().catch(() => null);
  if (!r.ok || !hasTurn(body)) throw new Error(`credentials ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function mintMeteredKey(domain, secretKey) {
  if (mintedKey && Date.now() < mintedUntil) return mintedKey;
  const r = await fetch(`https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(secretKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiryInSeconds: MINTED_TTL_S, label: 'court-piece' }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.apiKey) throw new Error(`create credential ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  mintedKey = body.apiKey;
  mintedUntil = Date.now() + (MINTED_TTL_S - 3600) * 1000;
  return mintedKey;
}

async function loadMeteredIce() {
  const domain = process.env.METERED_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const apiKey = process.env.METERED_API_KEY;
  const secretKey = process.env.METERED_SECRET_KEY;
  if (!domain || (!apiKey && !secretKey)) return null;
  if (apiKey) {
    try { return await meteredIceServers(domain, apiKey); } catch (e) { console.error('[turn] METERED_API_KEY failed:', e.message); }
  }
  if (secretKey) {
    try {
      return await meteredIceServers(domain, await mintMeteredKey(domain, secretKey));
    } catch (e) {
      mintedKey = null;
      console.error('[turn] METERED_SECRET_KEY failed:', e.message);
    }
  }
  return null;
}

function staticIce() {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return iceServers;
}

app.get('/api/ice', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!cachedIce || Date.now() - cachedAt > ICE_TTL) {
    iceInflight ??= loadMeteredIce().finally(() => { iceInflight = null; });
    const fresh = await iceInflight;
    if (fresh) { cachedIce = fresh; cachedAt = Date.now(); }
  }
  // Serve the last good Metered list even if a refresh failed; otherwise static config.
  res.json({ iceServers: cachedIce || staticIce() });
});

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';
const cleanId = (id) => (typeof id === 'string' && /^[\w-]{8,64}$/.test(id) ? id : null);

io.on('connection', (socket) => {
  // Wrap handlers: errors go back to the client callback instead of crashing.
  const on = (event, fn) => socket.on(event, (payload = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    try {
      reply({ ok: true, ...(fn(payload) || {}) });
    } catch (e) {
      reply({ error: e.message });
    }
  });

  const currentRoom = () => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new Error('Room not found');
    return room;
  };

  const enter = (room, { name, playerId }) => {
    const id = cleanId(playerId);
    if (!id) throw new Error('Invalid player id');
    if (socket.data.code && socket.data.code !== room.code) rooms.get(socket.data.code)?.leave(socket.data.playerId);
    room.join(id, cleanName(name), socket.id);
    socket.data.code = room.code;
    socket.data.playerId = id;
    return { code: room.code };
  };

  on('room:create', (p) => enter(rooms.create(), p));
  on('room:join', (p) => {
    const room = rooms.get(p.code);
    if (!room) throw new Error('Room not found');
    return enter(room, p);
  });
  on('room:leave', () => {
    const room = currentRoom();
    const seat = room.seatOf(socket.data.playerId);
    const publicId = seat >= 0 ? room.seats[seat].publicId : null;
    room.leave(socket.data.playerId);
    if (publicId) notifyPeerLeft(room, publicId);
    socket.data.code = null;
  });

  on('seat:move', ({ seat }) => currentRoom().moveSeat(socket.data.playerId, seatIndex(seat)));
  on('bot:add', ({ seat }) => currentRoom().addBot(socket.data.playerId, seatIndex(seat)));
  on('bot:remove', ({ seat }) => currentRoom().removeBot(socket.data.playerId, seatIndex(seat)));
  on('game:start', ({ target, callerMode, firstCaller }) => {
    const t = Number(target);
    currentRoom().start(socket.data.playerId, {
      target: Number.isInteger(t) && t >= 1 && t <= 50 ? t : undefined,
      callerMode: callerMode === 'host' ? 'host' : 'rules',
      firstCaller: firstCaller == null || firstCaller === '' ? undefined : seatIndex(firstCaller),
    });
  });
  on('game:caller', ({ seat }) => currentRoom().setCaller(socket.data.playerId, seatIndex(seat)));
  on('game:trump', ({ suit }) => currentRoom().chooseTrump(socket.data.playerId, suit));
  on('game:play', ({ card }) => currentRoom().play(socket.data.playerId, String(card)));
  on('game:next', () => currentRoom().nextHand(socket.data.playerId));
  on('game:lobby', () => currentRoom().backToLobby(socket.data.playerId));

  // WebRTC signalling relay. Media itself goes peer-to-peer.
  const myPublicId = (room) => room.seats[room.requireSeat(socket.data.playerId)].publicId;
  on('rtc:join', () => {
    const room = currentRoom();
    const me = myPublicId(room);
    const peers = [...room.rtcPeers].filter((id) => id !== me && room.socketOfPublic(id));
    room.rtcPeers.add(me);
    return { peers };
  });
  on('rtc:signal', ({ to, data }) => {
    const room = currentRoom();
    const target = room.socketOfPublic(to);
    if (target) io.to(target).emit('rtc:signal', { from: myPublicId(room), data });
  });
  on('rtc:leave', () => {
    const room = currentRoom();
    const me = myPublicId(room);
    room.rtcPeers.delete(me);
    notifyPeerLeft(room, me);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const publicId = room.disconnect(socket.data.playerId, socket.id);
    if (publicId) notifyPeerLeft(room, publicId);
  });
});

function seatIndex(seat) {
  const n = Number(seat);
  if (!Number.isInteger(n) || n < 0 || n > 3) throw new Error('Invalid seat');
  return n;
}

function notifyPeerLeft(room, publicId) {
  room.seats.forEach((s) => {
    if (s && !s.isBot && s.connected && s.publicId !== publicId) io.to(s.socketId).emit('rtc:peer-left', { id: publicId });
  });
}

server.listen(PORT, () => console.log(`Court Piece running on http://localhost:${PORT}`));
