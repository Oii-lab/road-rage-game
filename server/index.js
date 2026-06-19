const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, '../public')));

// ═══════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════
const W = 1200, H = 700;
const ROAD_W   = 90;   // half-width of road corridor
const MAX_LAPS = 3;
const TICK     = 1000 / 60;

const ACCEL      = 0.30;
const BRAKE      = 0.20;
const TURN       = 0.045;
const FRICTION   = 0.965;
const OFF_FR     = 0.87;
const MAX_SPEED  = 9;
const CAR_R      = 14;  // collision circle radius

// ═══════════════════════════════════════════════════════
//  TRACK — simple oval with one chicane
//  All points are CENTRE-LINE, travel direction: index 0 → 1 → 2 → ... → 0
//  Visualised as closed polyline with ROAD_W half-width
// ═══════════════════════════════════════════════════════
const TRACK_PTS = [
  { x: 900, y: 350 },  //  0  start/finish (right side)
  { x: 980, y: 240 },  //  1
  { x: 1050,y: 160 },  //  2
  { x: 1100,y: 350 },  //  3  rightmost point
  { x: 1050,y: 540 },  //  4
  { x: 980, y: 610 },  //  5
  { x: 850, y: 620 },  //  6
  { x: 680, y: 580 },  //  7  bottom-right chicane entry
  { x: 600, y: 530 },  //  8  chicane dip
  { x: 520, y: 580 },  //  9  chicane exit
  { x: 340, y: 590 },  // 10
  { x: 160, y: 530 },  // 11
  { x:  90, y: 350 },  // 12  leftmost
  { x: 160, y: 170 },  // 13
  { x: 340, y: 110 },  // 14
  { x: 560, y: 120 },  // 15
  { x: 680, y: 160 },  // 16
  { x: 760, y: 250 },  // 17
  { x: 820, y: 350 },  // 18  back near start
];

// Checkpoints: gate indices the player must cross in order each lap
// (use 3 well-spread points)
const CP = [3, 8, 12];  // right tip, chicane, left tip

// ─── Segment helper ───────────────────────────────────
function buildSegs(pts) {
  const segs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, dx, dy, len });
  }
  return segs;
}
const SEGS = buildSegs(TRACK_PTS);

function distToSeg(px, py, s) {
  if (s.len < 0.001) return Math.hypot(px - s.ax, py - s.ay);
  const t  = Math.max(0, Math.min(1, ((px-s.ax)*s.dx + (py-s.ay)*s.dy) / (s.len * s.len)));
  return Math.hypot(px - (s.ax + t*s.dx), py - (s.ay + t*s.dy));
}

function isOnTrack(x, y) {
  for (const s of SEGS) if (distToSeg(x, y, s) <= ROAD_W) return true;
  return false;
}

// Progress along track: returns a float 0..N (segment index + fraction)
// Used for lap/checkpoint logic — avoids angle-based bugs
function trackProgress(x, y) {
  let bestSeg = 0, bestT = 0, bestD = Infinity;
  for (let i = 0; i < SEGS.length; i++) {
    const s = SEGS[i];
    if (s.len < 0.001) continue;
    const t = Math.max(0, Math.min(1, ((x-s.ax)*s.dx + (y-s.ay)*s.dy) / (s.len * s.len)));
    const d = Math.hypot(x - (s.ax + t*s.dx), y - (s.ay + t*s.dy));
    if (d < bestD) { bestD = d; bestSeg = i; bestT = t; }
  }
  return bestSeg + bestT;  // e.g. 3.7 = 70% along segment 3
}

// ─── Spawns: just behind start line, side by side ────
//   Start/finish is between pt 18 and pt 0, facing toward pt 1 (up-right)
//   angle = atan2(pt1.y - pt0.y, pt1.x - pt0.x) ≈ direction of travel
const startAngle = Math.atan2(
  TRACK_PTS[1].y - TRACK_PTS[0].y,
  TRACK_PTS[1].x - TRACK_PTS[0].x
);
// Perpendicular (sideways) to lane them
const perpAngle = startAngle + Math.PI / 2;
const SPAWNS = [
  {
    x: TRACK_PTS[0].x + Math.cos(perpAngle) * 28,
    y: TRACK_PTS[0].y + Math.sin(perpAngle) * 28,
    angle: startAngle,
  },
  {
    x: TRACK_PTS[0].x - Math.cos(perpAngle) * 28,
    y: TRACK_PTS[0].y - Math.sin(perpAngle) * 28,
    angle: startAngle,
  },
];

// ═══════════════════════════════════════════════════════
//  ROOM / PLAYER
// ═══════════════════════════════════════════════════════
const rooms = new Map();

function makePlayer(id, idx) {
  const sp = SPAWNS[idx];
  console.log(`[spawn] P${idx} at (${sp.x.toFixed(0)},${sp.y.toFixed(0)}) angle=${sp.angle.toFixed(2)} onTrack=${isOnTrack(sp.x, sp.y)}`);
  return {
    id, idx,
    x: sp.x, y: sp.y,
    angle: sp.angle,
    vx: 0, vy: 0,
    hp: 100,
    lap: 0,
    // Checkpoint tracking: which CP gates hit this lap (by index into CP array)
    cpHit: new Array(CP.length).fill(false),
    // Progress gating: track the "last progress" to detect forward crossing of start line
    prevProgress: null,
    finished: false,
    finishTime: null,
    color: idx === 0 ? '#FF3366' : '#33CCFF',
    input: { up:false, down:false, left:false, right:false },
  };
}

function makeRoom(id) {
  return { id, players: new Map(), state: 'waiting', loop: null };
}

// ═══════════════════════════════════════════════════════
//  PHYSICS
// ═══════════════════════════════════════════════════════
function tickPlayer(p) {
  const spd = Math.hypot(p.vx, p.vy);

  if (spd > 0.3) {
    const fwd  = p.vx * Math.cos(p.angle) + p.vy * Math.sin(p.angle);
    const sign = fwd >= 0 ? 1 : -1;
    if (p.input.left)  p.angle -= TURN * sign;
    if (p.input.right) p.angle += TURN * sign;
  }

  if (p.input.up) {
    p.vx += Math.cos(p.angle) * ACCEL;
    p.vy += Math.sin(p.angle) * ACCEL;
  }
  if (p.input.down) {
    p.vx -= Math.cos(p.angle) * BRAKE;
    p.vy -= Math.sin(p.angle) * BRAKE;
  }

  const fr = isOnTrack(p.x, p.y) ? FRICTION : OFF_FR;
  p.vx *= fr;
  p.vy *= fr;

  const s = Math.hypot(p.vx, p.vy);
  if (s > MAX_SPEED) { p.vx *= MAX_SPEED/s; p.vy *= MAX_SPEED/s; }

  p.x += p.vx;
  p.y += p.vy;
  p.x = Math.max(5, Math.min(W-5, p.x));
  p.y = Math.max(5, Math.min(H-5, p.y));
}

// ─── Checkpoint & lap logic ───────────────────────────
function tickCheckpoint(p) {
  if (p.finished) return;

  const prog = trackProgress(p.x, p.y);

  // Check each required gate
  for (let i = 0; i < CP.length; i++) {
    if (p.cpHit[i]) continue;
    const gateProg = CP[i];  // which segment index the gate sits on
    // Within ±1.5 segments of the gate?
    if (Math.abs(prog - gateProg) < 1.5) {
      // Must hit in order
      if (i === 0 || p.cpHit[i-1]) {
        p.cpHit[i] = true;
        console.log(`[cp] P${p.idx} hit checkpoint ${i}`);
      }
    }
  }

  // Crossed start/finish? (progress wraps from ~N back to ~0)
  // Detect: was near end of track last tick, now near start
  if (p.prevProgress !== null) {
    const N = SEGS.length;
    const wasNearEnd   = p.prevProgress > N - 2;
    const isNearStart  = prog < 2;
    const allCpHit     = p.cpHit.every(v => v);

    if (wasNearEnd && isNearStart && allCpHit) {
      p.lap++;
      p.cpHit = new Array(CP.length).fill(false);
      console.log(`[lap] P${p.idx} completed lap ${p.lap}`);
      if (p.lap >= MAX_LAPS) {
        p.finished = true;
        p.finishTime = Date.now();
        console.log(`[finish] P${p.idx} wins!`);
      }
    }
  }

  p.prevProgress = prog;
}

// ─── Car collision ────────────────────────────────────
function resolveCollision(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minD = CAR_R * 2.5;
  if (dist >= minD || dist < 0.01) return;

  const nx = dx/dist, ny = dy/dist;
  const overlap = (minD - dist) / 2;
  a.x -= nx*overlap; a.y -= ny*overlap;
  b.x += nx*overlap; b.y += ny*overlap;

  const rvx = a.vx - b.vx, rvy = a.vy - b.vy;
  const dot  = rvx*nx + rvy*ny;
  if (dot > 0) {
    const imp = dot * 0.8;
    a.vx -= imp*nx; a.vy -= imp*ny;
    b.vx += imp*nx; b.vy += imp*ny;
    const dmg = Math.min(18, Math.floor(Math.abs(dot) * 4));
    if (dmg > 1) {
      a.hp = Math.max(0, a.hp - dmg);
      b.hp = Math.max(0, b.hp - dmg);
    }
  }
}

// ═══════════════════════════════════════════════════════
//  GAME LOOP
// ═══════════════════════════════════════════════════════
function snapshot(room) {
  return {
    state: room.state,
    players: [...room.players.values()].map(p => ({
      id:p.id, idx:p.idx,
      x:p.x, y:p.y, angle:p.angle,
      vx:p.vx, vy:p.vy,
      hp:p.hp, lap:p.lap,
      finished:p.finished, finishTime:p.finishTime,
      color:p.color,
      cpHit: p.cpHit,
    })),
    trackPts:  TRACK_PTS,
    roadW:     ROAD_W,
    cp:        CP,
    W, H,
  };
}

function startRoom(room) {
  // Send initial state immediately so clients see parked cars
  io.to(room.id).emit('state', snapshot(room));

  let cd = 3;
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
    if (room.state === 'racing') {
      const ps = [...room.players.values()];
      for (const p of ps) {
        if (!p.finished && p.hp > 0) {
          tickPlayer(p);
          tickCheckpoint(p);
        }
      }
      if (ps.length === 2) resolveCollision(ps[0], ps[1]);

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

    const idx    = room.players.size;
    const player = makePlayer(socket.id, idx);
    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { idx });
    io.to(roomId).emit('waiting', room.players.size);

    if (room.players.size === 2) {
      room.state = 'countdown';
      startRoom(room);
    }
  });

  socket.on('input', inp => {
    const room = rooms.get(socket.data.roomId);
    const p    = room?.players.get(socket.id);
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
server.listen(PORT, () => {
  console.log(`Road Rage on :${PORT}`);
  console.log(`Start angle: ${startAngle.toFixed(3)} rad`);
  console.log(`Spawns: P0(${SPAWNS[0].x.toFixed(0)},${SPAWNS[0].y.toFixed(0)}) P1(${SPAWNS[1].x.toFixed(0)},${SPAWNS[1].y.toFixed(0)})`);
  SPAWNS.forEach((s,i) => console.log(`  P${i} onTrack: ${isOnTrack(s.x, s.y)}`));
});
