// ─── Socket ────────────────────────────────────────────────────────────────
const socket = io();

// ─── State ─────────────────────────────────────────────────────────────────
let myId = null;
let myIndex = null;
let roomId = null;
let trackInfo = null;
let CANVAS_W = 1200;
let CANVAS_H = 700;

// rendering is always on once we get gameState
let renderActive = false;
// input only sent when racing
let raceActive = false;

const keys = {};
let lastInput = {};

const particles = [];

// ─── DOM ────────────────────────────────────────────────────────────────────
const lobby         = document.getElementById('lobby');
const waiting       = document.getElementById('waiting');
const waitingRoomId = document.getElementById('waitingRoomId');
const countdownOvl  = document.getElementById('countdownOverlay');
const countdownNum  = document.getElementById('countdownNum');
const finishOverlay = document.getElementById('finishOverlay');
const finishTitle   = document.getElementById('finishTitle');
const finishSub     = document.getElementById('finishSub');
const canvas        = document.getElementById('gameCanvas');
const hud           = document.getElementById('hud');
const hudLap        = document.getElementById('hudLap');
const hudHp         = document.getElementById('hudHp');
const hudOppLap     = document.getElementById('hudOppLap');
const hudOppHp      = document.getElementById('hudOppHp');
const joinBtn       = document.getElementById('joinBtn');
const roomInput     = document.getElementById('roomInput');

const ctx = canvas.getContext('2d');

// ─── Canvas sizing ──────────────────────────────────────────────────────────
function resizeCanvas() {
  const scaleX = window.innerWidth  / CANVAS_W;
  const scaleY = window.innerHeight / CANVAS_H;
  const scale  = Math.min(scaleX, scaleY);
  canvas.style.width  = (CANVAS_W * scale) + 'px';
  canvas.style.height = (CANVAS_H * scale) + 'px';
}
window.addEventListener('resize', resizeCanvas);

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
roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

// ─── Socket Events ──────────────────────────────────────────────────────────
socket.on('joined', ({ playerId, index, track, canvasW, canvasH }) => {
  myId     = playerId;
  myIndex  = index;
  trackInfo = track;
  CANVAS_W  = canvasW;
  CANVAS_H  = canvasH;
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  resizeCanvas();
});

socket.on('roomFull', () => {
  waiting.classList.add('hidden');
  lobby.classList.remove('hidden');
  alert('Room is full. Try a different Room ID.');
});

socket.on('countdown', (n) => {
  countdownOvl.classList.remove('hidden');
  countdownNum.textContent = n === 0 ? 'GO!' : n;
  countdownNum.style.animation = 'none';
  void countdownNum.offsetWidth;
  countdownNum.style.animation = '';
});

socket.on('raceStart', () => {
  countdownOvl.classList.add('hidden');
  raceActive = true;
});

socket.on('gameState', (state) => {
  // Show canvas on first frame (even during countdown)
  if (!renderActive) {
    renderActive = true;
    waiting.classList.add('hidden');
    canvas.classList.remove('hidden');
    hud.classList.remove('hidden');
  }

  renderFrame(state);
  updateHUD(state);

  if (state.state === 'finished' && raceActive) {
    raceActive = false;
    showFinish(state);
  }
});

socket.on('opponentLeft', () => {
  raceActive = false;
  finishTitle.textContent = 'OPPONENT LEFT';
  finishSub.textContent   = 'The race has ended.';
  finishOverlay.classList.remove('hidden');
});

// ─── Input ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => { keys[e.code] = true; e.preventDefault(); });
document.addEventListener('keyup',   e => { keys[e.code] = false; });

setInterval(() => {
  if (!raceActive) return;
  const input = {
    up:    !!(keys['KeyW'] || keys['ArrowUp']),
    down:  !!(keys['KeyS'] || keys['ArrowDown']),
    left:  !!(keys['KeyA'] || keys['ArrowLeft']),
    right: !!(keys['KeyD'] || keys['ArrowRight']),
    item:  !!(keys['Space'] || keys['KeyZ']),
  };
  if (JSON.stringify(input) !== JSON.stringify(lastInput)) {
    lastInput = input;
    socket.emit('input', input);
  }
}, 16);

// ─── Rendering ──────────────────────────────────────────────────────────────
function renderFrame(state) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  drawBackground();
  if (trackInfo) drawTrack();
  drawStartLine();
  updateParticles();
  drawParticles();
  for (const p of state.players) drawCar(p, state.state === 'racing' || state.state === 'finished');
}

function drawBackground() {
  // Dark grass
  ctx.fillStyle = '#151a10';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

function drawTrack() {
  const { cx, cy, outerRx, outerRy, innerRx, innerRy } = trackInfo;

  // ── Asphalt fill ──
  ctx.beginPath();
  ctx.ellipse(cx, cy, outerRx, outerRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#282828';
  ctx.fill();

  // ── Inner grass ──
  ctx.beginPath();
  ctx.ellipse(cx, cy, innerRx, innerRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#1b2214';
  ctx.fill();

  // ── Rumble strips ──
  drawRumbleStrips(cx, cy, outerRx, outerRy,  14, false);
  drawRumbleStrips(cx, cy, innerRx, innerRy, -14, true);

  // ── White edge lines ──
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(cx, cy, outerRx, outerRy, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, innerRx, innerRy, 0, 0, Math.PI * 2);
  ctx.stroke();

  // ── Dashed center line ──
  ctx.setLineDash([18, 14]);
  ctx.strokeStyle = 'rgba(255,255,180,0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, (outerRx + innerRx) / 2, (outerRy + innerRy) / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawRumbleStrips(cx, cy, rx, ry, thickness, inward) {
  const steps = 60;
  const sign = inward ? -1 : 1;
  const irx = rx + sign * Math.abs(thickness);
  const iry = ry + sign * Math.abs(thickness);

  for (let i = 0; i < steps; i++) {
    if (i % 2 !== 0) continue; // only alternate segments
    const a1 = (i / steps) * Math.PI * 2;
    const a2 = ((i + 1) / steps) * Math.PI * 2;

    ctx.beginPath();
    ctx.moveTo(cx + rx  * Math.cos(a1), cy + ry  * Math.sin(a1));
    ctx.lineTo(cx + irx * Math.cos(a1), cy + iry * Math.sin(a1));
    ctx.lineTo(cx + irx * Math.cos(a2), cy + iry * Math.sin(a2));
    ctx.lineTo(cx + rx  * Math.cos(a2), cy + ry  * Math.sin(a2));
    ctx.closePath();
    ctx.fillStyle = '#cc2222';
    ctx.fill();
  }
}

function drawStartLine() {
  if (!trackInfo) return;
  const { cx, cy, outerRx, innerRx } = trackInfo;
  const x1 = cx + innerRx;
  const x2 = cx + outerRx;
  const stripeH = 8;
  const stripeCount = 8;
  const totalH = stripeCount * stripeH;
  const startY = cy - totalH / 2;

  for (let i = 0; i < stripeCount; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#000000';
    ctx.fillRect(x1, startY + i * stripeH, x2 - x1, stripeH);
  }

  ctx.fillStyle = 'rgba(255,230,80,0.85)';
  ctx.font = 'bold 10px "Courier New"';
  ctx.textAlign = 'center';
  ctx.fillText('START / FINISH', (x1 + x2) / 2, startY - 6);
}

// ─── Car ─────────────────────────────────────────────────────────────────────
function drawCar(p, moving) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle + Math.PI / 2);

  const r = p.radius;
  const isMe = p.id === myId;
  const bw = r * 1.4, bh = r * 2.2;

  // Shadow
  ctx.beginPath();
  ctx.ellipse(3, 4, r * 1.1, r * 0.65, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();

  // Body
  ctx.fillStyle = p.color;
  rrFill(ctx, -bw/2, -bh/2, bw, bh, 5);

  // Windshield
  ctx.fillStyle = isMe ? 'rgba(160,210,255,0.75)' : 'rgba(120,170,210,0.5)';
  rrFill(ctx, -bw*0.36, -bh*0.36, bw*0.72, bh*0.28, 3);

  // Wheels
  ctx.fillStyle = '#111';
  const wy = bh * 0.26;
  rrFill(ctx, -bw*0.7,    -wy - 7, 9, 14, 2);
  rrFill(ctx,  bw*0.7 - 9,-wy - 7, 9, 14, 2);
  rrFill(ctx, -bw*0.7,     wy - 7, 9, 14, 2);
  rrFill(ctx,  bw*0.7 - 9, wy - 7, 9, 14, 2);

  // HP ring
  const hpFrac = Math.max(0, p.hp / 100);
  ctx.beginPath();
  ctx.arc(0, 0, r + 5, -Math.PI/2, -Math.PI/2 + hpFrac * Math.PI * 2);
  ctx.strokeStyle = hpFrac > 0.5 ? '#44ff88' : hpFrac > 0.25 ? '#ffcc00' : '#ff3333';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.restore();

  // "YOU" label
  if (isMe) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = 'bold 9px "Courier New"';
    ctx.textAlign = 'center';
    // label is above car in world space (not rotated)
    ctx.fillText('YOU', p.x, p.y - r - 10);
    ctx.restore();
  }

  // Exhaust particles (only for local player when accelerating)
  if (isMe && moving && lastInput.up) {
    const tailAngle = p.angle + Math.PI;
    spawnParticle(
      p.x + Math.cos(tailAngle) * r,
      p.y + Math.sin(tailAngle) * r,
      Math.cos(tailAngle) * (0.8 + Math.random() * 0.8) + (Math.random()-0.5)*0.5,
      Math.sin(tailAngle) * (0.8 + Math.random() * 0.8) + (Math.random()-0.5)*0.5,
      '#888', 4
    );
  }
}

// roundRect polyfill — never use native API
function rrFill(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y,         x + r, y);
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
    p.x += p.vx; p.y += p.vy;
    p.life -= 0.07; p.size *= 0.91;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles() {
  for (const p of particles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = p.color + Math.floor(p.life * 200).toString(16).padStart(2,'0');
    ctx.fill();
  }
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
function updateHUD(state) {
  const me  = state.players.find(p => p.id === myId);
  const opp = state.players.find(p => p.id !== myId);
  if (me)  { hudLap.textContent    = `${me.lap} / 3`;  hudHp.style.width    = `${me.hp}%`;  }
  if (opp) { hudOppLap.textContent = `${opp.lap} / 3`; hudOppHp.style.width = `${opp.hp}%`; }
}

// ─── Finish ───────────────────────────────────────────────────────────────────
function showFinish(state) {
  const me  = state.players.find(p => p.id === myId);
  const opp = state.players.find(p => p.id !== myId);
  let title, sub;
  if (me?.finished && (!opp?.finished || me.finishTime <= opp.finishTime)) {
    title = '🏆 YOU WIN'; sub = 'Race Complete';
  } else if (me?.hp <= 0) {
    title = '💥 DNF'; sub = 'Vehicle Destroyed';
  } else {
    title = 'OPPONENT WINS'; sub = 'Better luck next time';
  }
  finishTitle.textContent = title;
  finishSub.textContent   = sub;
  finishOverlay.classList.remove('hidden');
}
