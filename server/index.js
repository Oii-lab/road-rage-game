const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, '../public')));

// ═══════════════════════════════════════════════════════
//  WORLD CONSTANTS
// ═══════════════════════════════════════════════════════
const W = 1200, H = 700;
const ROAD_WIDTH  = 110;   // half-width of track corridor
const MAX_LAPS    = 3;
const TICK        = 1000 / 60;

const CAR_W       = 22;
const CAR_H       = 36;
const ACCEL       = 0.32;
const BRAKE       = 0.22;
const TURN        = 0.048;   // rad/tick
const FRICTION    = 0.96;
const OFF_FRICTION= 0.88;
const MAX_SPEED   = 10;

// ═══════════════════════════════════════════════════════
//  TRACK  —  Figure-8 waypoints (centre-line)
//  Waypoints go: right loop (CW) → crossover → left loop (CW)
// ═══════════════════════════════════════════════════════
const TRACK_PTS = [
  // ── right loop ──
  { x: 820, y: 350 },   // 0  start/finish
  { x: 960, y: 260 },   // 1
  { x: 1080,y: 200 },   // 2
  { x: 1130,y: 350 },   // 3
  { x: 1080,y: 500 },   // 4
  { x: 960, y: 560 },   // 5
  { x: 820, y: 500 },   // 6
  // ── crossover ──
  { x: 640, y: 420 },   // 7
  { x: 560, y: 350 },   // 8  (centre cross)
  { x: 640, y: 280 },   // 9
  // ── left loop ──
  { x: 820, y: 200 },   // 10
  { x: 380, y: 200 },   // 11
  { x: 200, y: 260 },   // 12
  { x: 120, y: 350 },   // 13
  { x: 200, y: 440 },   // 14
  { x: 380, y: 500 },   // 15
  { x: 560, y: 460 },   // 16
  { x: 640, y: 420 },   // back to 7 area → closes loop
];
// Checkpoint indices (must pass these IN ORDER before crossing start)
const CHECKPOINT_IDX = [3, 8, 13];   // right-tip, cross, left-tip

// ── Precompute segment normals & lengths for isOnTrack ──
function segData(pts) {
  const segs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx*dx + dy*dy);
    segs.push({ ax: a.x, ay: a.y, dx, dy, len });
  }
  return segs;
}
const SEGS = segData(TRACK_PTS);

// Distance from point P to line segment AB
function distToSeg(px, py, s) {
  const t = Math.max(0, Math.min(1, ((px-s.ax)*s.dx + (py-s.ay)*s.dy) / (s.len*s.len)));
  const cx = s.ax + t*s.dx, cy = s.ay + t*s.dy;
  const dx = px-cx, dy = py-cy;
  return Math.sqrt(dx*dx + dy*dy);
}

function isOnTrack(x, y) {
  for (const s of SEGS) {
    if (distToSeg(x, y, s) <= ROAD_WIDTH) return true;
  }
  return false;
}

// Nearest waypoint index (for checkpoint logic)
function nearestWaypoint(x, y) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < TRACK_PTS.length; i++) {
    const dx = x - TRACK_PTS[i].x, dy = y - TRACK_PTS[i].y;
    const d = dx*dx + dy*dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ── Spawn: just before start/finish (wp 0), staggered side by side ──
const SPAWNS = [
  { x: 820, y: 330, angle: Math.PI },   // P1  facing left (direction of travel)
  { x: 820, y: 370, angle: Math.PI },   // P2
];

// ═══════════════════════════════════════════════════════
//  ROOM / PLAYER
// ═══════════════════════════════════════════════════════
const rooms = new Map();

function makePlayer(id, idx) {
  const sp = SPAWNS[idx];
  console.log(`[spawn] P${idx} at (${sp.x}, ${sp.y}) onTrack=${isOnTrack(sp.x, sp.y)}`);
  return {
    id, idx,
    x: sp.x, y: sp.y,
    angle: sp.angle,
    vx: 0, vy: 0,
    hp: 100,
    lap: 0,
    cpHit: [],           // which checkpoints hit this lap
    finished: false,
    finishTime: null,
    color: idx === 0 ? '#FF3366' : '#33CCFF',
    input: { up:false, down:false, left:false, right:false },
  };
}

function makeRoom(id) {
  return { id, players: new Map(), state:'waiting', loop: null };
}

// ═══════════════════════════════════════════════════════
//  PHYSICS
// ═══════════════════════════════════════════════════════
function tickPlayer(p) {
  const spd = Math.hypot(p.vx, p.vy);

  // Steering
  if (spd > 0.4) {
    // Determine forward/reverse to flip steering when reversing
    const fwd = p.vx * Math.cos(p.angle) + p.vy * Math.sin(p.angle);
    const sign = fwd >= 0 ? 1 : -1;
    if (p.input.left)  p.angle -= TURN * sign;
    if (p.input.right) p.angle += TURN * sign;
  }

  // Thrust
  if (p.input.up) {
    p.vx += Math.cos(p.angle) * ACCEL;
    p.vy += Math.sin(p.angle) * ACCEL;
  }
  if (p.input.down) {
    p.vx -= Math.cos(p.angle) * BRAKE;
    p.vy -= Math.sin(p.angle) * BRAKE;
  }

  // Friction
  const fr = isOnTrack(p.x, p.y) ? FRICTION : OFF_FRICTION;
  p.vx *= fr;
  p.vy *= fr;

  // Speed cap
  const s2 = Math.hypot(p.vx, p.vy);
  if (s2 > MAX_SPEED) { p.vx *= MAX_SPEED/s2; p.vy *= MAX_SPEED/s2; }

  p.x += p.vx;
  p.y += p.vy;

  // World bounds (hard clamp)
  p.x = Math.max(10, Math.min(W-10, p.x));
  p.y = Math.max(10, Math.min(H-10, p.y));
}

function tickCheckpoint(p) {
  if (p.finished) return;
  const wp = nearestWaypoint(p.x, p.y);
  const cpIdx = CHECKPOINT_IDX.indexOf(wp);

  // Hit a required checkpoint?
  if (cpIdx !== -1 && !p.cpHit.includes(cpIdx)) {
    // Must hit in order
    if (cpIdx === 0 || p.cpHit.includes(cpIdx - 1)) {
      p.cpHit.push(cpIdx);
    }
  }

  // Cross start/finish (near wp 0) after all checkpoints hit?
  const dx = p.x - TRACK_PTS[0].x, dy = p.y - TRACK_PTS[0].y;
  if (Math.hypot(dx, dy) < ROAD_WIDTH * 0.8 &&
      p.cpHit.length === CHECKPOINT_IDX.length) {
    p.lap++;
    p.cpHit = [];
    if (p.lap >= MAX_LAPS) {
      p.finished = true;
      p.finishTime = Date.now();
    }
  }
}

function resolveCollision(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minD = CAR_W * 2.2;
  if (dist > minD || dist < 0.1) return;

  const nx = dx/dist, ny = dy/dist;
  const overlap = (minD - dist) / 2;
  a.x -= nx*overlap; a.y -= ny*overlap;
  b.x += nx*overlap; b.y += ny*overlap;

  const rvx = a.vx - b.vx, rvy = a.vy - b.vy;
  const dot = rvx*nx + rvy*ny;
  if (dot > 0) {
    const imp = dot * 0.85;
    a.vx -= imp*nx; a.vy -= imp*ny;
    b.vx += imp*nx; b.vy += imp*ny;
    const dmg = Math.min(20, Math.floor(Math.abs(dot) * 5));
    if (dmg > 1) { a.hp = Math.max(0, a.hp-dmg); b.hp = Math.max(0, b.hp-dmg); }
  }
}

// ═══════════════════════════════════════════════════════
//  GAME LOOP
// ═══════════════════════════════════════════════════════
function snapshot(room) {
  return {
    state: room.state,
    players: [...room.players.values()].map(p => ({
      id:p.id, idx:p.idx, x:p.x, y:p.y, angle:p.angle,
      vx:p.vx, vy:p.vy, hp:p.hp, lap:p.lap,
      finished:p.finished, finishTime:p.finishTime, color:p.color,
    })),
    track: { pts: TRACK_PTS, roadWidth: ROAD_WIDTH, W, H, checkpointIdx: CHECKPOINT_IDX },
  };
}

function startRoom(room) {
  let cd = 3;
  // Push immediate state so clients see parked cars
  io.to(room.id).emit('state', snapshot(room));

  const cdTimer = setInterval(() => {
    io.to(room.id).emit('countdown', cd);
    if (cd === 0) {
      clearInterval(cdTimer);
      room.state = 'racing';
      io.to(room.id).emit('go');
    }
    cd--;
  }, 1000);

  room.loop = setInterval(() => {
    const ps = [...room.players.values()];

    if (room.state === 'racing') {
      for (const p of ps) {
        if (!p.finished && p.hp > 0) {
          tickPlayer(p);
          tickCheckpoint(p);
        }
      }
      if (ps.length === 2) resolveCollision(ps[0], ps[1]);

      // End when at least 1 player done (or destroyed)
      if (ps.some(p => p.finished || p.hp <= 0)) {
        room.state = 'finished';
        clearInterval(room.loop);
      }
    }

    io.to(room.id).emit('state', snapshot(room));
  }, TICK);
}

// ═══════════════════════════════════════════════════════
//  SOCKETS
// ═══════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log('[+]', socket.id);

  socket.on('join', ({ roomId }) => {
    let room = rooms.get(roomId);
    if (!room) { room = makeRoom(roomId); rooms.set(roomId, room); }
    if (room.players.size >= 2) { socket.emit('full'); return; }

    const idx = room.players.size;
    const player = makePlayer(socket.id, idx);
    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { idx, W, H });
    io.to(roomId).emit('waiting', room.players.size);

    if (room.players.size === 2) {
      room.state = 'countdown';
      startRoom(room);
    }
  });

  socket.on('input', inp => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) p.input = inp;
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      clearInterval(room.loop);
      rooms.delete(socket.data.roomId);
    } else {
      room.state = 'finished';
      clearInterval(room.loop);
      io.to(room.id).emit('opponentLeft');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Road Rage running on :${PORT}`));
