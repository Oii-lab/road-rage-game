const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_RATE = 1000 / 60;
const CANVAS_W = 1200;
const CANVAS_H = 700;

const CAR_RADIUS = 16;
const ACCEL = 0.28;
const BRAKE_FORCE = 0.18;
const TURN_SPEED = 0.045;
const FRICTION = 0.97;
const DRIFT_FRICTION = 0.985;
const MAX_SPEED = 9;
const MAX_LAPS = 3;

// ─── Track Definition ─────────────────────────────────────────────────────────
// Oval track: outer ellipse, inner ellipse, checkpoints, start line
const TRACK = {
  cx: CANVAS_W / 2,
  cy: CANVAS_H / 2,
  outerRx: 500,
  outerRy: 280,
  innerRx: 310,
  innerRy: 140,
  // Checkpoints (angle in radians, cars must pass in order 0→1→2→3→finish)
  checkpoints: [
    { angle: Math.PI * 0.5 },   // bottom
    { angle: Math.PI },          // left
    { angle: Math.PI * 1.5 },   // top
  ],
  // Shortcut corridor (narrow path cutting across center-left)
  shortcut: {
    x: CANVAS_W / 2 - 310,
    y: CANVAS_H / 2 - 50,
    w: 60,
    h: 100,
  },
  startAngle: 0, // right side of oval = start/finish line
};

// Spawn positions along start line
const SPAWN_POSITIONS = [
  { angle: -0.08, r: 0.72 },  // P1: slightly outside center radius
  { angle:  0.08, r: 0.72 },  // P2
];

function getSpawnPos(index) {
  const sp = SPAWN_POSITIONS[index];
  const rx = (TRACK.outerRx + TRACK.innerRx) / 2;
  const ry = (TRACK.outerRy + TRACK.innerRy) / 2;
  return {
    x: TRACK.cx + rx * TRACK.r_scale_x(sp) * Math.cos(sp.angle),
    y: TRACK.cy + ry * Math.sin(sp.angle),
    angle: sp.angle - Math.PI / 2, // face upward at start (CCW direction)
  };
}

// Simple spawn without ellipse scaling
function getSpawn(index) {
  const offsets = [
    { dx: 50, dy: -25 },
    { dx: 50, dy:  25 },
  ];
  const o = offsets[index] || { dx: 50, dy: 0 };
  return {
    x: TRACK.cx + o.dx,
    y: TRACK.cy + o.dy,
    angle: -Math.PI / 2, // face upward (CCW travel direction)
  };
}

// ─── Room Management ──────────────────────────────────────────────────────────
const rooms = new Map();

function createPlayer(id, index) {
  const spawn = getSpawn(index);
  return {
    id,
    index,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    vx: 0,
    vy: 0,
    speed: 0,
    radius: CAR_RADIUS,
    hp: 100,
    lap: 0,
    checkpoint: -1,   // last passed checkpoint index
    finished: false,
    finishTime: null,
    input: { up: false, down: false, left: false, right: false, item: false },
    // Visual
    color: index === 0 ? '#FF4444' : '#44AAFF',
    name: `P${index + 1}`,
  };
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),
    state: 'waiting', // waiting | countdown | racing | finished
    interval: null,
    countdown: 3,
    startTime: null,
  };
}

// ─── Physics ──────────────────────────────────────────────────────────────────
function pointInEllipse(px, py, cx, cy, rx, ry) {
  return ((px - cx) ** 2) / (rx ** 2) + ((py - cy) ** 2) / (ry ** 2) <= 1;
}

function isOnTrack(x, y) {
  const inOuter = pointInEllipse(x, y, TRACK.cx, TRACK.cy, TRACK.outerRx, TRACK.outerRy);
  const inInner = pointInEllipse(x, y, TRACK.cx, TRACK.cy, TRACK.innerRx, TRACK.innerRy);
  return inOuter && !inInner;
}

function updatePhysics(player) {
  const { input } = player;
  const speed = Math.sqrt(player.vx ** 2 + player.vy ** 2);

  // Steering only when moving
  if (speed > 0.3) {
    const dir = player.vx * Math.cos(player.angle) + player.vy * Math.sin(player.angle);
    const sign = dir >= 0 ? 1 : -1;
    if (input.left)  player.angle -= TURN_SPEED * sign;
    if (input.right) player.angle += TURN_SPEED * sign;
  }

  // Acceleration / brake
  if (input.up) {
    player.vx += Math.cos(player.angle) * ACCEL;
    player.vy += Math.sin(player.angle) * ACCEL;
  }
  if (input.down) {
    player.vx -= Math.cos(player.angle) * BRAKE_FORCE;
    player.vy -= Math.sin(player.angle) * BRAKE_FORCE;
  }

  // Friction (more on grass/off-track)
  const onTrack = isOnTrack(player.x, player.y);
  const friction = onTrack ? FRICTION : 0.90;
  player.vx *= friction;
  player.vy *= friction;

  // Speed cap
  const newSpeed = Math.sqrt(player.vx ** 2 + player.vy ** 2);
  if (newSpeed > MAX_SPEED) {
    player.vx = (player.vx / newSpeed) * MAX_SPEED;
    player.vy = (player.vy / newSpeed) * MAX_SPEED;
  }

  player.speed = newSpeed;
  player.x += player.vx;
  player.y += player.vy;

  // Boundary clamp (soft push back)
  const margin = 20;
  if (player.x < margin) { player.x = margin; player.vx *= -0.3; }
  if (player.x > CANVAS_W - margin) { player.x = CANVAS_W - margin; player.vx *= -0.3; }
  if (player.y < margin) { player.y = margin; player.vy *= -0.3; }
  if (player.y > CANVAS_H - margin) { player.y = CANVAS_H - margin; player.vy *= -0.3; }
}

// ─── Checkpoint / Lap Logic ───────────────────────────────────────────────────
function getAngleFromCenter(x, y) {
  return Math.atan2(y - TRACK.cy, x - TRACK.cx);
}

function checkCheckpoints(player) {
  if (player.finished) return;

  const angle = getAngleFromCenter(player.x, player.y);
  const cp = TRACK.checkpoints;

  // Check each checkpoint sector
  for (let i = 0; i < cp.length; i++) {
    if (player.checkpoint === i - 1) {
      const diff = Math.abs(normalizeAngle(angle - cp[i].angle));
      if (diff < 0.35) {
        player.checkpoint = i;
      }
    }
  }

  // Crossed finish line (angle near 0 = right side of oval)
  if (player.checkpoint === cp.length - 1) {
    const diff = Math.abs(normalizeAngle(angle - TRACK.startAngle));
    if (diff < 0.25) {
      player.lap += 1;
      player.checkpoint = -1;
      if (player.lap >= MAX_LAPS) {
        player.finished = true;
        player.finishTime = Date.now();
      }
    }
  }
}

function normalizeAngle(a) {
  while (a > Math.PI)  a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// ─── Collision Between Cars ────────────────────────────────────────────────────
function resolveCarCollision(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx ** 2 + dy ** 2);
  const minDist = a.radius + b.radius;

  if (dist < minDist && dist > 0.01) {
    // Push apart
    const nx = dx / dist;
    const ny = dy / dist;
    const overlap = (minDist - dist) / 2;
    a.x -= nx * overlap;
    a.y -= ny * overlap;
    b.x += nx * overlap;
    b.y += ny * overlap;

    // Exchange velocity components along collision normal
    const relVx = a.vx - b.vx;
    const relVy = a.vy - b.vy;
    const dot = relVx * nx + relVy * ny;

    if (dot > 0) {
      const impulse = dot * 0.9; // restitution
      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;
    }

    // Damage based on impact speed
    const impact = Math.abs(dot);
    if (impact > 2) {
      const dmg = Math.min(Math.floor(impact * 4), 20);
      a.hp = Math.max(0, a.hp - dmg);
      b.hp = Math.max(0, b.hp - dmg);
    }
  }
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
function startGameLoop(room) {
  room.interval = setInterval(() => {
    const players = Array.from(room.players.values());

    if (room.state === 'countdown') {
      // Handled by countdown timer, not tick
      return;
    }

    if (room.state !== 'racing') return;

    // Update each player
    for (const p of players) {
      if (p.finished || p.hp <= 0) continue;
      updatePhysics(p);
      checkCheckpoints(p);
    }

    // Car vs car collision
    if (players.length === 2) {
      resolveCarCollision(players[0], players[1]);
    }

    // Check win condition
    const finished = players.filter(p => p.finished || p.hp <= 0);
    if (finished.length >= players.length - 1 && players.length === 2) {
      room.state = 'finished';
    }

    // Build and broadcast state
    io.to(room.id).emit('gameState', buildState(room));

    if (room.state === 'finished') {
      clearInterval(room.interval);
    }
  }, TICK_RATE);
}

function buildState(room) {
  return {
    state: room.state,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      index: p.index,
      x: p.x,
      y: p.y,
      angle: p.angle,
      vx: p.vx,
      vy: p.vy,
      speed: p.speed,
      hp: p.hp,
      lap: p.lap,
      checkpoint: p.checkpoint,
      finished: p.finished,
      finishTime: p.finishTime,
      color: p.color,
      name: p.name,
    })),
  };
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  socket.on('joinRoom', ({ roomId }) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = createRoom(roomId);
      rooms.set(roomId, room);
    }

    if (room.players.size >= 2) {
      socket.emit('roomFull');
      return;
    }

    const index = room.players.size;
    const player = createPlayer(socket.id, index);
    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', { playerId: socket.id, index, track: TRACK, canvasW: CANVAS_W, canvasH: CANVAS_H });
    io.to(roomId).emit('playerCount', room.players.size);

    if (room.players.size === 2) {
      // Start countdown
      room.state = 'countdown';
      room.countdown = 3;
      startGameLoop(room);

      const countdownInterval = setInterval(() => {
        io.to(roomId).emit('countdown', room.countdown);
        room.countdown--;
        if (room.countdown < 0) {
          clearInterval(countdownInterval);
          room.state = 'racing';
          room.startTime = Date.now();
          io.to(roomId).emit('raceStart');
        }
      }, 1000);
    }
  });

  socket.on('input', (input) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.input = input;
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      clearInterval(room.interval);
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit('opponentLeft');
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Road Rage server running on port ${PORT}`);
});
