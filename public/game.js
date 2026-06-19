// ─── Socket ────────────────────────────────────────────────────────────────
const socket = io();

// ─── State ─────────────────────────────────────────────────────────────────
let myId = null;
let myIndex = null;
let roomId = null;
let trackInfo = null;
let CANVAS_W = 1200;
let CANVAS_H = 700;
let gameActive = false;

const keys = {};
let input = { up: false, down: false, left: false, right: false, item: false };

// Particles
const particles = [];

// ─── DOM ────────────────────────────────────────────────────────────────────
const lobby          = document.getElementById('lobby');
const waiting        = document.getElementById('waiting');
const waitingRoomId  = document.getElementById('waitingRoomId');
const countdownOvl   = document.getElementById('countdownOverlay');
const countdownNum   = document.getElementById('countdownNum');
const finishOverlay  = document.getElementById('finishOverlay');
const finishTitle    = document.getElementById('finishTitle');
const finishSub      = document.getElementById('finishSub');
const canvas         = document.getElementById('gameCanvas');
const hud            = document.getElementById('hud');
const hudLap         = document.getElementById('hudLap');
const hudHp          = document.getElementById('hudHp');
const hudOppLap      = document.getElementById('hudOppLap');
const hudOppHp       = document.getElementById('hudOppHp');
const joinBtn        = document.getElementById('joinBtn');
const roomInput      = document.getElementById('roomInput');

const ctx = canvas.getContext('2d');

// ─── Lobby ─────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const id = roomInput.value.trim().toUpperCase();
  if (!id) return;
  roomId = id;
  socket.emit('joinRoom', { roomId });
  lobby.classList.add('hidden');
  waiting.classList.remove('hidden');
  waitingRoomId.textContent = `ROOM: ${roomId}`;
});

roomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinBtn.click();
});

// ─── Socket Events ──────────────────────────────────────────────────────────
socket.on('joined', ({ playerId, index, track, canvasW, canvasH }) => {
  myId = playerId;
  myIndex = index;
  trackInfo = track;
  CANVAS_W = canvasW;
  CANVAS_H = canvasH;
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
});

socket.on('roomFull', () => {
  waiting.classList.add('hidden');
  lobby.classList.remove('hidden');
  alert('Room is full. Try a different Room ID.');
});

socket.on('countdown', (n) => {
  countdownOvl.classList.remove('hidden');
  countdownNum.textContent = n;
  // Restart animation
  countdownNum.style.animation = 'none';
  void countdownNum.offsetWidth;
  countdownNum.style.animation = '';
});

socket.on('raceStart', () => {
  countdownOvl.classList.add('hidden');
  waiting.classList.add('hidden');
  canvas.classList.remove('hidden');
  hud.classList.remove('hidden');
  gameActive = true;
});

socket.on('gameState', (state) => {
  if (!gameActive) return;
  renderFrame(state);
  updateHUD(state);

  if (state.state === 'finished') {
    gameActive = false;
    showFinish(state);
  }
});

socket.on('opponentLeft', () => {
  gameActive = false;
  finishTitle.textContent = 'OPPONENT LEFT';
  finishSub.textContent = 'The race has ended.';
  finishOverlay.classList.remove('hidden');
});

// ─── Input ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => { keys[e.code] = true; });
document.addEventListener('keyup',   e => { keys[e.code] = false; });

setInterval(() => {
  if (!gameActive) return;
  const newInput = {
    up:    !!(keys['KeyW'] || keys['ArrowUp']),
    down:  !!(keys['KeyS'] || keys['ArrowDown']),
    left:  !!(keys['KeyA'] || keys['ArrowLeft']),
    right: !!(keys['KeyD'] || keys['ArrowRight']),
    item:  !!(keys['Space'] || keys['KeyZ']),
  };
  // Only emit on change
  if (JSON.stringify(newInput) !== JSON.stringify(input)) {
    input = newInput;
    socket.emit('input', input);
  }
}, 1000 / 60);

// ─── Rendering ──────────────────────────────────────────────────────────────
function renderFrame(state) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  drawBackground();
  if (trackInfo) drawTrack();
  drawStartLine();
  updateParticles();
  drawParticles();
  for (const p of state.players) drawCar(p);
}

function drawBackground() {
  ctx.fillStyle = '#1a1f14'; // Dark grass
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Subtle grid on grass
  ctx.strokeStyle = 'rgba(255,255,255,0.02)';
  ctx.lineWidth = 1;
  for (let x = 0; x < CANVAS_W; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
  }
  for (let y = 0; y < CANVAS_H; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
  }
}

function drawTrack() {
  const t = trackInfo;
  const cx = t.cx, cy = t.cy;

  // ── Outer track fill (asphalt) ──
  ctx.save();
  // Draw outer ellipse path
  ctx.beginPath();
  ctx.ellipse(cx, cy, t.outerRx, t.outerRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#2a2a2a';
  ctx.fill();

  // Cut out inner (grass island)
  ctx.beginPath();
  ctx.ellipse(cx, cy, t.innerRx, t.innerRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#1e2818';
  ctx.fill();
  ctx.restore();

  // ── Track markings ──
  // Outer edge line
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, t.outerRx, t.outerRy, 0, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Inner edge line
  ctx.beginPath();
  ctx.ellipse(cx, cy, t.innerRx, t.innerRy, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // ── Dashed center lane line ──
  ctx.save();
  ctx.setLineDash([18, 14]);
  ctx.beginPath();
  const midRx = (t.outerRx + t.innerRx) / 2;
  const midRy = (t.outerRy + t.innerRy) / 2;
  ctx.ellipse(cx, cy, midRx, midRy, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,200,0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // ── Inner grass texture dots ──
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, t.innerRx - 2, t.innerRy - 2, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#243020';
  ctx.fillRect(cx - t.innerRx, cy - t.innerRy, t.innerRx * 2, t.innerRy * 2);
  for (let i = 0; i < 60; i++) {
    const gx = cx + (Math.random() - 0.5) * t.innerRx * 1.8;
    const gy = cy + (Math.random() - 0.5) * t.innerRy * 1.8;
    ctx.fillStyle = `rgba(80,120,60,${0.3 + Math.random() * 0.3})`;
    ctx.fillRect(gx, gy, 3, 3);
  }
  ctx.restore();

  // ── Rumble strips (outer and inner edges) ──
  drawRumbleStrips(cx, cy, t.outerRx, t.outerRy, 12);
  drawRumbleStrips(cx, cy, t.innerRx, t.innerRy, -12);
}

function drawRumbleStrips(cx, cy, rx, ry, offset) {
  const steps = 64;
  const inward = offset < 0;
  const abs = Math.abs(offset);
  for (let i = 0; i < steps; i++) {
    const a1 = (i / steps) * Math.PI * 2;
    const a2 = ((i + 1) / steps) * Math.PI * 2;
    const odd = i % 2 === 0;
    if (!odd) continue;

    // Draw a wedge between rx and rx+offset at this angle segment
    ctx.beginPath();
    const nx = rx + (inward ? -abs : abs);
    const ny = ry + (inward ? -abs : abs);
    ctx.moveTo(cx + rx * Math.cos(a1), cy + ry * Math.sin(a1));
    ctx.lineTo(cx + nx * Math.cos(a1), cy + ny * Math.sin(a1));
    ctx.lineTo(cx + nx * Math.cos(a2), cy + ny * Math.sin(a2));
    ctx.lineTo(cx + rx * Math.cos(a2), cy + ry * Math.sin(a2));
    ctx.closePath();
    ctx.fillStyle = odd ? '#cc3333' : '#ffffff';
    ctx.fill();
  }
}

function drawStartLine() {
  if (!trackInfo) return;
  const t = trackInfo;
  const cx = t.cx, cy = t.cy;

  // Start line: vertical stripe at the right side of the oval (angle 0)
  const x1 = cx + t.innerRx;
  const x2 = cx + t.outerRx;
  const lineY = cy;
  const stripeH = 6;
  const stripes = 6;
  const totalH = stripes * stripeH * 2;
  const startY = lineY - totalH / 2;

  for (let i = 0; i < stripes * 2; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#000000';
    ctx.fillRect(x1, startY + i * stripeH, x2 - x1, stripeH);
  }

  ctx.fillStyle = 'rgba(255,255,100,0.8)';
  ctx.font = '700 10px Courier New';
  ctx.letterSpacing = '2px';
  ctx.textAlign = 'center';
  ctx.fillText('START / FINISH', (x1 + x2) / 2, startY - 6);
}

// ─── Car Drawing ──────────────────────────────────────────────────────────────
function drawCar(p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle + Math.PI / 2); // canvas Y-down, so +90°

  const r = p.radius;
  const isMe = p.id === myId;

  // Shadow
  ctx.beginPath();
  ctx.ellipse(3, 3, r * 1.1, r * 0.7, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();

  // Body
  // Use roundRect polyfill
  const bw = r * 1.4, bh = r * 2.2;
  ctx.fillStyle = p.color;
  roundRectFill(ctx, -bw / 2, -bh / 2, bw, bh, 5);

  // Windshield
  ctx.fillStyle = isMe ? 'rgba(180,220,255,0.7)' : 'rgba(140,180,220,0.5)';
  roundRectFill(ctx, -bw * 0.35, -bh * 0.35, bw * 0.7, bh * 0.28, 3);

  // Wheels
  ctx.fillStyle = '#1a1a1a';
  const wy = bh * 0.25;
  roundRectFill(ctx, -bw * 0.68, -wy - 6, 8, 13, 2);
  roundRectFill(ctx,  bw * 0.68 - 8, -wy - 6, 8, 13, 2);
  roundRectFill(ctx, -bw * 0.68,  wy - 6, 8, 13, 2);
  roundRectFill(ctx,  bw * 0.68 - 8,  wy - 6, 8, 13, 2);

  // HP indicator ring
  const hpFrac = Math.max(0, p.hp / 100);
  ctx.beginPath();
  ctx.arc(0, 0, r + 5, -Math.PI / 2, -Math.PI / 2 + hpFrac * Math.PI * 2);
  ctx.strokeStyle = hpFrac > 0.5 ? '#44ff88' : hpFrac > 0.25 ? '#ffcc00' : '#ff3333';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // "ME" indicator
  if (isMe) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = 'bold 9px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('YOU', 0, bh / 2 + 13);
  }

  ctx.restore();

  // Exhaust particles when accelerating
  if (input.up && p.id === myId) {
    const tailAngle = p.angle + Math.PI;
    spawnParticle(
      p.x + Math.cos(tailAngle) * r,
      p.y + Math.sin(tailAngle) * r,
      Math.cos(tailAngle) * (1 + Math.random()) + (Math.random() - 0.5),
      Math.sin(tailAngle) * (1 + Math.random()) + (Math.random() - 0.5),
      '#888888', 5
    );
  }
}

// roundRect polyfill (never use native)
function roundRectFill(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

// ─── Particles ────────────────────────────────────────────────────────────────
function spawnParticle(x, y, vx, vy, color, size) {
  particles.push({ x, y, vx, vy, color, size, life: 1 });
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.06;
    p.size *= 0.92;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  for (const p of particles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = p.color + Math.floor(p.life * 255).toString(16).padStart(2, '0');
    ctx.fill();
  }
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
function updateHUD(state) {
  const me = state.players.find(p => p.id === myId);
  const opp = state.players.find(p => p.id !== myId);
  if (me) {
    hudLap.textContent = `${me.lap} / 3`;
    hudHp.style.width = `${me.hp}%`;
  }
  if (opp) {
    hudOppLap.textContent = `${opp.lap} / 3`;
    hudOppHp.style.width = `${opp.hp}%`;
  }
}

function showFinish(state) {
  const me = state.players.find(p => p.id === myId);
  const opp = state.players.find(p => p.id !== myId);

  let title, sub;
  if (me && me.finished && (!opp || !opp.finished || me.finishTime <= opp.finishTime)) {
    title = '🏆 YOU WIN';
    sub = 'Race Complete';
  } else if (me && me.hp <= 0) {
    title = '💥 DNF';
    sub = 'Vehicle Destroyed';
  } else {
    title = 'OPPONENT WINS';
    sub = 'Better luck next time';
  }

  finishTitle.textContent = title;
  finishSub.textContent = sub;
  finishOverlay.classList.remove('hidden');
}
