// Full-mesh WebRTC for up to 4 players. Socket.IO relays the signalling;
// audio/video flows directly between browsers (or via TURN when NAT blocks that).
//
// - The newcomer sends offers to everyone already in the call (the "initiator"), so
//   there is no offer glare on first connect.
// - Every connection has a session id (sid). Signals for an old/other session are
//   ignored, so stale ICE candidates from a previous connection can't break a new one.
// - Signals from one peer are processed strictly in order.
// - When a connection drops, only the initiator renegotiates (ICE restart on the same
//   connection, then a full rebuild if that keeps failing). The other side just asks it to.

const VIDEO_MAX_BITRATE = 350_000; // bps per outgoing video stream; keeps a 4-way mesh smooth
const DISCONNECT_GRACE = 3000;     // ms to wait in "disconnected" before restarting ICE
const CONNECT_TIMEOUT = 15000;     // ms an attempt may take before we retry
const MAX_ICE_RESTARTS = 2;        // then rebuild the connection from scratch

const newSid = () => Math.random().toString(36).slice(2, 10);

export class Mesh {
  constructor(socket, { onStream, onLeave }) {
    this.socket = socket;
    this.onStream = onStream;
    this.onLeave = onLeave;
    this.peers = new Map(); // publicId -> entry
    this.queues = new Map(); // publicId -> Promise (serialises signal handling)
    this.local = null;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    socket.on('rtc:signal', ({ from, data }) => this.enqueue(from, () => this.onSignal(from, data)));
    socket.on('rtc:peer-left', ({ id }) => this.drop(id));
  }

  async join(localStream) {
    this.local = localStream;
    try {
      const res = await fetch('/api/ice', { cache: 'no-store' });
      const { iceServers } = await res.json();
      if (Array.isArray(iceServers) && iceServers.length) this.iceServers = iceServers;
    } catch { /* keep default STUN */ }
    const hasTurn = this.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
    if (!hasTurn) console.warn('[rtc] No TURN server configured: video will fail between many networks.');
    this.socket.emit('rtc:join', {}, (res) => {
      (res?.peers || []).forEach((id) => this.enqueue(id, () => this.call(id)));
    });
  }

  leave() {
    this.socket.emit('rtc:leave', {});
    [...this.peers.keys()].forEach((id) => this.drop(id));
  }

  setEnabled(kind, on) {
    this.local?.getTracks().filter((t) => t.kind === kind).forEach((t) => { t.enabled = on; });
  }

  enqueue(id, fn) {
    const next = (this.queues.get(id) || Promise.resolve())
      .then(fn)
      .catch((e) => console.warn('[rtc]', id, e));
    this.queues.set(id, next);
    return next;
  }

  // ---------- connection lifecycle ----------

  createPeer(id, sid, initiator) {
    this.close(id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 2 });
    const entry = { pc, sid, initiator, stream: new MediaStream(), pending: [], restarts: 0, timer: null };
    this.peers.set(id, entry);

    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, entry, { candidate: e.candidate }); };
    pc.ontrack = (e) => {
      const { track } = e;
      if (!entry.stream.getTracks().includes(track)) entry.stream.addTrack(track);
      // Remote tracks start "muted" until media actually arrives; re-render on changes
      // so the tile shows the avatar instead of a black box while connecting.
      track.onunmute = () => this.onStream(id, entry.stream);
      track.onmute = () => this.onStream(id, entry.stream);
      track.onended = () => { entry.stream.removeTrack(track); this.onStream(id, entry.stream); };
      this.onStream(id, entry.stream);
    };
    pc.onconnectionstatechange = () => this.onState(id, entry);
    pc.oniceconnectionstatechange = () => this.onState(id, entry);
    return entry;
  }

  onState(id, entry) {
    const { pc } = entry;
    if (this.peers.get(id) !== entry) return;
    const state = pc.connectionState || pc.iceConnectionState;
    const ice = pc.iceConnectionState;
    if (state === 'connected' || ice === 'connected' || ice === 'completed') {
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.restarts = 0;
      this.tuneSenders(pc);
      return;
    }
    if (state === 'failed' || ice === 'failed') {
      this.recover(id, entry);
    } else if (state === 'disconnected' || ice === 'disconnected') {
      // Often recovers by itself (brief network blip). Give it a moment.
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.recover(id, entry), DISCONNECT_GRACE);
    }
  }

  recover(id, entry) {
    if (this.peers.get(id) !== entry) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.initiator) this.enqueue(id, () => this.restart(id, entry));
    else this.send(id, entry, { restart: true });
  }

  // Watchdog: if an attempt doesn't connect in time, try again.
  armTimeout(id, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const s = entry.pc.connectionState || entry.pc.iceConnectionState;
      if (s !== 'connected') this.recover(id, entry);
    }, CONNECT_TIMEOUT);
  }

  async call(id) {
    const entry = this.createPeer(id, newSid(), true);
    const { pc } = entry;
    const kinds = new Set();
    this.local?.getTracks().forEach((t) => { pc.addTrack(t, this.local); kinds.add(t.kind); });
    for (const kind of ['audio', 'video']) {
      if (!kinds.has(kind)) pc.addTransceiver(kind, { direction: 'recvonly' });
    }
    await pc.setLocalDescription(await pc.createOffer());
    this.send(id, entry, { sdp: pc.localDescription });
    this.armTimeout(id, entry);
  }

  async restart(id, entry) {
    if (this.peers.get(id) !== entry) return;
    const { pc } = entry;
    if (entry.restarts >= MAX_ICE_RESTARTS || pc.signalingState === 'closed') {
      console.info('[rtc] rebuilding connection to', id);
      return this.call(id);
    }
    entry.restarts += 1;
    console.info('[rtc] ICE restart', entry.restarts, 'for', id);
    if (pc.signalingState !== 'stable') {
      // A previous offer never got an answer. Start over cleanly.
      await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    }
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
    this.send(id, entry, { sdp: pc.localDescription });
    this.armTimeout(id, entry);
  }

  async onSignal(from, data) {
    const { sid } = data;
    let entry = this.peers.get(from);

    if (data.sdp?.type === 'offer') {
      const fresh = !entry || entry.sid !== sid || entry.initiator || entry.pc.signalingState === 'closed';
      if (fresh) entry = this.createPeer(from, sid, false);
      const { pc } = entry;
      await pc.setRemoteDescription(data.sdp);
      if (fresh) {
        // Attach our tracks to the transceivers the offer created.
        for (const track of this.local?.getTracks() || []) {
          const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === track.kind && !t.sender.track);
          if (tr) {
            await tr.sender.replaceTrack(track);
            tr.sender.setStreams?.(this.local);
            tr.direction = 'sendrecv';
          }
        }
      }
      await this.flush(entry);
      await pc.setLocalDescription(await pc.createAnswer());
      this.send(from, entry, { sdp: pc.localDescription });
      this.armTimeout(from, entry);
      return;
    }

    if (!entry || entry.sid !== sid) return; // stale message from an old connection

    if (data.sdp?.type === 'answer') {
      if (entry.pc.signalingState !== 'have-local-offer') return;
      await entry.pc.setRemoteDescription(data.sdp);
      await this.flush(entry);
    } else if (data.candidate) {
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pending.push(data.candidate);
    } else if (data.restart && entry.initiator) {
      await this.restart(from, entry);
    }
  }

  async flush(entry) {
    for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  }

  // Cap video bitrate so 3 outgoing streams fit on typical uplinks and TURN relays.
  tuneSenders(pc) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video' || !sender.getParameters) continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        if (p.encodings[0].maxBitrate === VIDEO_MAX_BITRATE) continue;
        p.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
        p.degradationPreference = 'balanced';
        sender.setParameters(p).catch(() => {});
      } catch { /* not supported */ }
    }
  }

  send(to, entry, data) {
    this.socket.emit('rtc:signal', { to, data: JSON.parse(JSON.stringify({ ...data, sid: entry.sid })) });
  }

  close(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.pc.onconnectionstatechange = entry.pc.oniceconnectionstatechange = null;
    entry.pc.close();
    this.peers.delete(id);
  }

  drop(id) {
    if (!this.peers.has(id)) return;
    this.close(id);
    this.onLeave(id);
  }
}
