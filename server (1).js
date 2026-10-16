// ZOMBIES multiplayer relay server.
// Host-authoritative: one player's browser runs the simulation; this server only
// manages rooms and relays messages. It also serves the game page itself.
//
// Features:
//  - Reconnect grace: a dropped socket keeps its seat for a while and can resume with a token.
//  - Host migration: if the host really leaves, the lowest-id remaining player becomes host.
//  - Join in progress: players can join a running game by room code.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;
const GUEST_GRACE_MS = 30000; // how long a dropped guest's seat is held
const HOST_GRACE_MS = 7000;   // how long we wait for a dropped host before handing the game over
const DEAD_AFTER_MS = 45000;  // no traffic/pong at all for this long => connection is dead
const GAME = path.join(__dirname, 'game.html');
// room: { code, members: Map(id -> member), hostId, started }
// member: { id, ws, token, timer }   (ws is null while the seat is being held)
const rooms = new Map();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html' || url === '/game.html') {
    fs.readFile(GAME, (err, buf) => {
      if (err) { res.writeHead(500); res.end('game.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

function code4() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let t = 0; t < 50; t++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const token = () => crypto.randomBytes(12).toString('hex');
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const hostMember = (room) => room.members.get(room.hostId);
const hostWs = (room) => { const m = hostMember(room); return m ? m.ws : null; };

// Game snapshots are sent ~20x/s. If a guest's connection can't keep up, queued snapshots pile up
// and the delay keeps growing, so skip a snapshot while that guest still has a backlog.
function relay(ws, d) {
  if (!ws || ws.readyState !== 1) return;
  if (d && d.k === 's' && ws.bufferedAmount > 32 * 1024) return;
  ws.send(JSON.stringify({ t: 'msg', d }));
}
function broadcast(room, o, exceptId) {
  for (const m of room.members.values()) if (m.id !== exceptId) send(m.ws, o);
}

function closeRoom(room, why) {
  for (const m of room.members.values()) {
    clearTimeout(m.timer);
    if (m.ws) { send(m.ws, { t: 'closed', why }); m.ws.member = null; m.ws.room = null; }
  }
  rooms.delete(room.code);
}

// Pick the lowest-id connected player as the new host.
function migrateHost(room) {
  let next = null;
  for (const m of room.members.values()) if (m.ws && m.id !== room.hostId && (!next || m.id < next.id)) next = m;
  if (!next) { closeRoom(room, 'empty'); return; }
  room.members.delete(room.hostId);
  room.hostId = next.id;
  broadcast(room, { t: 'newhost', id: next.id });
}

// A player is gone for good (left on purpose, or their grace period ran out).
function drop(room, member) {
  if (!room || !room.members.has(member.id) || room.members.get(member.id) !== member) return;
  clearTimeout(member.timer);
  if (member.ws) { member.ws.member = null; member.ws.room = null; }
  if (member.id === room.hostId) {
    const others = [...room.members.values()].filter(m => m.id !== member.id && m.ws);
    if (!others.length) { closeRoom(room, 'empty'); return; }
    migrateHost(room);
  } else {
    room.members.delete(member.id);
    send(hostWs(room), { t: 'peer', id: member.id, join: false });
    if (![...room.members.values()].some(m => m.ws)) closeRoom(room, 'empty');
  }
}

// Socket closed but the player may come back: hold the seat for a grace period.
function hold(ws) {
  const room = ws.room, member = ws.member;
  ws.room = null; ws.member = null;
  if (!room || !member || member.ws !== ws) return;
  member.ws = null;
  const isHost = member.id === room.hostId;
  clearTimeout(member.timer);
  member.timer = setTimeout(() => drop(room, member), isHost ? HOST_GRACE_MS : GUEST_GRACE_MS);
}

wss.on('connection', (ws) => {
  ws.lastSeen = Date.now();
  ws.on('pong', () => { ws.lastSeen = Date.now(); });
  ws.on('message', (raw) => {
    ws.lastSeen = Date.now(); // any traffic proves the connection is alive
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room, me = ws.member;

    if (m.t === 'ka') { send(ws, { t: 'ka' }); return; }

    if (m.t === 'host') {
      if (room) drop(room, me);
      const code = code4();
      if (!code) { send(ws, { t: 'err', msg: 'Server is full, try again later' }); return; }
      const r = { code, members: new Map(), hostId: 0, started: false };
      const mem = { id: 0, ws, token: token(), timer: null };
      r.members.set(0, mem);
      rooms.set(code, r);
      ws.room = r; ws.member = mem;
      send(ws, { t: 'room', code, id: 0, token: mem.token });

    } else if (m.t === 'join') {
      if (room) drop(room, me);
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) { send(ws, { t: 'err', msg: 'Room not found' }); return; }
      let id = -1;
      for (let i = 0; i < MAX_PLAYERS; i++) if (!r.members.has(i)) { id = i; break; }
      if (id < 0) { send(ws, { t: 'err', msg: 'Room is full (4 players)' }); return; }
      const mem = { id, ws, token: token(), timer: null };
      r.members.set(id, mem);
      ws.room = r; ws.member = mem;
      send(ws, { t: 'joined', code: r.code, id, token: mem.token, host: r.hostId, started: r.started });
      send(hostWs(r), { t: 'peer', id, join: true });

    } else if (m.t === 'resume') {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      const mem = r && r.members.get(Number(m.id));
      if (!r || !mem || mem.token !== m.token) { send(ws, { t: 'err', msg: 'Session expired', fatal: true }); return; }
      clearTimeout(mem.timer);
      if (mem.ws && mem.ws !== ws) { const old = mem.ws; old.room = null; old.member = null; try { old.terminate(); } catch (e) {} }
      mem.ws = ws; ws.room = r; ws.member = mem;
      send(ws, { t: 'resumed', code: r.code, id: mem.id, host: r.hostId });

    } else if (m.t === 'lock') { // host: game is now running (used so the room is kept alive / handed over)
      if (room && me && me.id === room.hostId) room.started = !!m.on;

    } else if (m.t === 'in') { // guest -> host
      if (room && me && me.id !== room.hostId) send(hostWs(room), { t: 'from', id: me.id, d: m.d });

    } else if (m.t === 'to') { // host -> one player
      if (room && me && me.id === room.hostId) {
        const tgt = room.members.get(Number(m.id));
        if (tgt) relay(tgt.ws, m.d);
      }
    } else if (m.t === 'all') { // host -> every other player
      if (room && me && me.id === room.hostId) for (const g of room.members.values()) if (g.id !== me.id) relay(g.ws, m.d);

    } else if (m.t === 'leave') {
      if (room && me) drop(room, me);
    }
  });
  ws.on('close', () => hold(ws));
  ws.on('error', () => {});
});

// Heartbeat. Only kill a socket after a long silence: a busy link can delay pongs behind queued game
// data, and killing it after one missed ping was a cause of random disconnects.
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - ws.lastSeen > DEAD_AFTER_MS) { ws.terminate(); continue; }
    try { ws.ping(); } catch (e) {}
  }
}, 10000);

server.listen(PORT, () => console.log('ZOMBIES server on :' + PORT));
