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
const MAX_SPEED = 9;
const MAX_LAPS = 3;

// ─── Track Definition ─────────────────────────────────────────────────────────
const TRACK = {
  cx: CANVAS_W / 2,
  cy: CANVAS_H / 2,
  outerRx: 500,
  outerRy: 280,
  innerRx: 310,
  innerRy: 140,
  checkpoints: [
    { angle: Math.PI * 0.5 },
    { angle: Math.PI },
    { angle: Math.PI * 1.5 },
  ],
  startAngle: 0,
};

// Spawn just before start/finish line, inside the track width
function getSpawn(index) {
  // Right side of oval, stagger P1 (outer lane) and P2 (inner lane)
  const laneOffsets = [
    { dx: 430, dy: -20 },  // P1: outer lane
    { dx: 370, dy:  20 },  // P2: inner lane
  ];
  const o = laneOffsets[index] || { dx: 400, dy: 0 };
  return {
    x: TRACK.cx + o.dx,
    y: TRACK.cy + o.dy,
    angle: -Math.PI / 2, // facing upward = CCW travel
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
    checkpoint: -1,
    finished: false,
    finishTime: null,
    input: { up: false, down: false, left: false, right: false, item: false },
    color: index === 0 ? '#FF4444' : '#44AAFF',
    name: `P${index + 1}`,
  };
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),
    state: 'waiting',
    interval: null,
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

  if (input.up) {
    player.vx += Math.cos(player.angle) * ACCEL;
    player.vy += Math.sin(player.angle) * ACCEL;
  }
  if (input.down) {
    player.vx -= Math.cos(player.angle) * BRAKE_FORCE;
    player.vy -= Math.sin(player.angle) * BRAKE_FORCE;
  }

  const onTrack = isOnTrack(player.x, player.y);
  const friction = onTrack ? FRICTION : 0.90;
  player.vx *= friction;
  player.vy *= friction;

  const newSpeed = Math.sqrt(player.vx ** 2 + player.vy ** 2);
  if (newSpeed > MAX_SPEED) {
    player.vx = (player.vx / newSpeed) * MAX_SPEED;
    player.vy = (player.vy / newSpeed) * MAX_SPEED;
  }

  player.speed = newSpeed;
  player.x += player.vx;
  player.y += player.vy;

  // Soft boundary
  const m = 20;
  if (player.x < m) { player.x = m; player.vx *= -0.3; }
  if (player.x > CANVAS_W - m) { player.x = CANVAS_W - m; player.vx *= -0.3; }
  if (player.y < m) { player.y = m; player.vy *= -0.3; }
  if (player.y > CANVAS_H - m) { player.y = CANVAS_H - m; player.vy *= -0.3; }
}

// ─── Checkpoint / Lap ─────────────────────────────────────────────────────────
function normalizeAngle(a) {
  while (a > Math.PI)  a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function checkCheckpoints(player) {
  if (player.finished) return;
  const angle = Math.atan2(player.y - TRACK.cy, player.x - TRACK.cx);
  const cp = TRACK.checkpoints;

  for (let i = 0; i < cp.length; i++) {
    if (player.checkpoint === i - 1) {
      if (Math.abs(normalizeAngle(angle - cp[i].angle)) < 0.35) {
        player.checkpoint = i;
      }
    }
  }

  if (player.checkpoint === cp.length - 1) {
    if (Math.abs(normalizeAngle(angle - TRACK.startAngle)) < 0.25) {
      player.lap += 1;
      player.checkpoint = -1;
      if (player.lap >= MAX_LAPS) {
        player.finished = true;
        player.finishTime = Date.now();
      }
    }
  }
}

// ─── Car Collision ────────────────────────────────────────────────────────────
function resolveCarCollision(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx ** 2 + dy ** 2);
  const minDist = a.radius + b.radius;

  if (dist < minDist && dist > 0.01) {
    const nx = dx / dist;
    const ny = dy / dist;
    const overlap = (minDist - dist) / 2;
    a.x -= nx * overlap;
    a.y -= ny * overlap;
    b.x += nx * overlap;
    b.y += ny * overlap;

    const relVx = a.vx - b.vx;
    const relVy = a.vy - b.vy;
    const dot = relVx * nx + relVy * ny;

    if (dot > 0) {
      a.vx -= dot * 0.9 * nx;
      a.vy -= dot * 0.9 * ny;
      b.vx += dot * 0.9 * nx;
      b.vy += dot * 0.9 * ny;
    }

    const impact = Math.abs(dot);
    if (impact > 2) {
      const dmg = Math.min(Math.floor(impact * 4), 20);
      a.hp = Math.max(0, a.hp - dmg);
      b.hp = Math.max(0, b.hp - dmg);
    }
  }
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
function buildState(room) {
  return {
    state: room.state,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id, index: p.index,
      x: p.x, y: p.y, angle: p.angle,
      vx: p.vx, vy: p.vy, speed: p.speed,
      hp: p.hp, lap: p.lap, checkpoint: p.checkpoint,
      finished: p.finished, finishTime: p.finishTime,
      color: p.color, name: p.name,
    })),
  };
}

function startGameLoop(room) {
  let countdown = 3;

  // Broadcast initial state immediately so client can render track + parked cars
  io.to(room.id).emit('gameState', buildState(room));

  // Countdown ticks
  const countdownInterval = setInterval(() => {
    io.to(room.id).emit('countdown', countdown);
    countdown--;
    if (countdown < 0) {
      clearInterval(countdownInterval);
      room.state = 'racing';
      room.startTime = Date.now();
      io.to(room.id).emit('raceStart');
    }
  }, 1000);

  // Physics loop — runs always, only updates physics when racing
  room.interval = setInterval(() => {
    const players = Array.from(room.players.values());

    if (room.state === 'racing') {
      for (const p of players) {
        if (p.finished || p.hp <= 0) continue;
        updatePhysics(p);
        checkCheckpoints(p);
      }
      if (players.length === 2) resolveCarCollision(players[0], players[1]);

      const doneCount = players.filter(p => p.finished || p.hp <= 0).length;
      if (players.length === 2 && doneCount >= 1) {
        room.state = 'finished';
      }
    }

    io.to(room.id).emit('gameState', buildState(room));

    if (room.state === 'finished') {
      clearInterval(room.interval);
    }
  }, TICK_RATE);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

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

    socket.emit('joined', {
      playerId: socket.id,
      index,
      track: TRACK,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
    });
    io.to(roomId).emit('playerCount', room.players.size);

    if (room.players.size === 2) {
      room.state = 'countdown';
      startGameLoop(room);
    }
  });

  socket.on('input', (input) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.input = input;
  });

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Road Rage on port ${PORT}`));
