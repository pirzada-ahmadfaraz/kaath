// Full-mesh WebRTC for up to 4 players. Socket.IO relays the signalling;
// audio/video flows directly between browsers.
// The newcomer sends offers to everyone already in the call, so there is no offer glare.

export class Mesh {
  constructor(socket, { onStream, onLeave }) {
    this.socket = socket;
    this.onStream = onStream;
    this.onLeave = onLeave;
    this.peers = new Map(); // publicId -> { pc, stream, pending }
    this.local = null;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    socket.on('rtc:signal', ({ from, data }) => this.onSignal(from, data).catch((e) => console.warn('rtc', e)));
    socket.on('rtc:peer-left', ({ id }) => this.drop(id));
  }

  async join(localStream) {
    this.local = localStream;
    try {
      this.iceServers = (await (await fetch('/api/ice')).json()).iceServers;
    } catch { /* keep default STUN */ }
    this.socket.emit('rtc:join', {}, (res) => {
      (res?.peers || []).forEach((id) => this.call(id).catch((e) => console.warn('rtc', e)));
    });
  }

  leave() {
    this.socket.emit('rtc:leave', {});
    [...this.peers.keys()].forEach((id) => this.drop(id));
  }

  setEnabled(kind, on) {
    this.local?.getTracks().filter((t) => t.kind === kind).forEach((t) => { t.enabled = on; });
  }

  createPeer(id) {
    this.drop(id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry = { pc, stream: new MediaStream(), pending: [] };
    this.peers.set(id, entry);
    pc.onicecandidate = (e) => { if (e.candidate) this.send(id, { candidate: e.candidate }); };
    pc.ontrack = (e) => {
      entry.stream.addTrack(e.track);
      this.onStream(id, entry.stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.call(id).catch((e) => console.warn('rtc restart', e));
    };
    return entry;
  }

  async call(id) {
    const { pc } = this.createPeer(id);
    const kinds = new Set();
    this.local?.getTracks().forEach((t) => { pc.addTrack(t, this.local); kinds.add(t.kind); });
    for (const kind of ['audio', 'video']) {
      if (!kinds.has(kind)) pc.addTransceiver(kind, { direction: 'recvonly' });
    }
    await pc.setLocalDescription(await pc.createOffer());
    this.send(id, { sdp: pc.localDescription });
  }

  async onSignal(from, data) {
    if (data.sdp?.type === 'offer') {
      const entry = this.createPeer(from);
      const { pc } = entry;
      await pc.setRemoteDescription(data.sdp);
      // Attach our tracks to the transceivers the offer created.
      for (const track of this.local?.getTracks() || []) {
        const tr = pc.getTransceivers().find((t) => t.receiver.track.kind === track.kind && !t.sender.track);
        if (tr) {
          await tr.sender.replaceTrack(track);
          tr.direction = 'sendrecv';
        }
      }
      await this.flush(entry);
      await pc.setLocalDescription(await pc.createAnswer());
      this.send(from, { sdp: pc.localDescription });
    } else if (data.sdp?.type === 'answer') {
      const entry = this.peers.get(from);
      if (!entry) return;
      await entry.pc.setRemoteDescription(data.sdp);
      await this.flush(entry);
    } else if (data.candidate) {
      const entry = this.peers.get(from);
      if (!entry) return;
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate);
      else entry.pending.push(data.candidate);
    }
  }

  async flush(entry) {
    for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  }

  send(to, data) {
    this.socket.emit('rtc:signal', { to, data: JSON.parse(JSON.stringify(data)) });
  }

  drop(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    entry.pc.close();
    this.peers.delete(id);
    this.onLeave(id);
  }
}
