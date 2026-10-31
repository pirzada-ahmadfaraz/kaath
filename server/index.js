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
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));

// STUN works for most home networks; a TURN server is needed for strict NATs / mobile data.
app.get('/api/ice', (_req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
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
