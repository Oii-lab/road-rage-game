// ═══════════════════════════════════════════════════════
//  SOCKET
// ═══════════════════════════════════════════════════════
const socket = io();

// ═══════════════════════════════════════════════════════
//  GLOBAL STATE
// ═══════════════════════════════════════════════════════
let myId    = null;
let myIdx   = null;
let WW      = 1200;
let HH      = 700;
let track   = null;   // { pts, roadWidth, W, H, checkpointIdx }
let phase   = 'lobby'; // lobby | waiting | countdown | racing | finished
let lastState = null;

const keys  = {};
let prevInput = '';

// Particles
const particles = [];

// ═══════════════════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════════════════
const sLobby     = document.getElementById('s-lobby');
const sWaiting   = document.getElementById('s-waiting');
const sCountdown = document.getElementById('s-countdown');
const sFinish    = document.getElementById('s-finish');
const tagRoom    = document.getElementById('tag-room');
const cdNum      = document.getElementById('cd-num');
const finTitle   = document.getElementById('finish-title');
const finSub     = document.getElementById('finish-sub');
const btnJoin    = document.getElementById('btn-join');
const btnRematch = document.getElementById('btn-rematch');
const inpRoom    = document.getElementById('inp-room');
const canvas     = document.getElementById('canvas');
const hud        = document.getElementById('hud');
const elLap      = document.getElementById('hud-lap');
const elOppLap   = document.getElementById('hud-opp-lap');
const elHpMe     = document.getElementById('hp-me-fill');
const elHpOpp    = document.getElementById('hp-opp-fill');

const ctx = canvas.getContext('2d');

// ═══════════════════════════════════════════════════════
//  CANVAS SCALE
// ═══════════════════════════════════════════════════════
function scaleCanvas() {
  const sx = window.innerWidth  / WW;
  const sy = window.innerHeight / HH;
  const s  = Math.min(sx, sy);
  canvas.style.width  = Math.floor(WW * s) + 'px';
  canvas.style.height = Math.floor(HH * s) + 'px';
}
window.addEventListener('resize', scaleCanvas);

// ═══════════════════════════════════════════════════════
//  LOBBY CONTROLS
// ═══════════════════════════════════════════════════════
function doJoin() {
  const room = inpRoom.value.trim().toUpperCase();
  if (!room) return;
  tagRoom.textContent = 'ROOM: ' + room;
  socket.emit('join', { roomId: room });
  show('waiting');
}
btnJoin.addEventListener('click', doJoin);
inpRoom.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
btnRematch.addEventListener('click', () => location.reload());

function show(screen) {
  sLobby    .classList.toggle('hidden', screen !== 'lobby');
  sWaiting  .classList.toggle('hidden', screen !== 'waiting');
  sCountdown.classList.toggle('hidden', screen !== 'countdown');
  sFinish   .classList.toggle('hidden', screen !== 'finish');
  phase = screen;
}

// ═══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════
socket.on('joined', ({ idx, W, H }) => {
  myIdx = idx;
  WW = W; HH = H;
  canvas.width  = WW;
  canvas.height = HH;
  scaleCanvas();
  // Don't need to reassign myId here — do it on first state frame
});

socket.on('full', () => {
  show('lobby');
  alert('Room full — try a different ID.');
});

socket.on('waiting', count => {
  // Still waiting for 2nd player if count === 1
  if (count < 2) show('waiting');
});

socket.on('countdown', n => {
  show('countdown');
  cdNum.textContent = n === 0 ? 'GO!' : String(n);
  // Reset animation
  cdNum.style.animation = 'none';
  void cdNum.offsetWidth;
  cdNum.style.animation = '';
});

socket.on('go', () => {
  sCountdown.classList.add('hidden');
  phase = 'racing';
  hud.style.display = 'block';
});

socket.on('state', st => {
  // Latch our socket id from first frame
  if (!myId) {
    // find which player has our socket id... we know our idx
    const me = st.players.find(p => p.idx === myIdx);
    if (me) myId = me.id;
  }

  lastState = st;

  // Show canvas on first state (even during countdown so cars are visible)
  canvas.style.display = 'block';

  render(st);
  updateHUD(st);

  if (st.state === 'finished' && phase !== 'finish') {
    phase = 'finish';
    setTimeout(() => showFinish(st), 600);
  }
});

socket.on('opponentLeft', () => {
  finTitle.textContent = 'OPPONENT LEFT';
  finSub.textContent   = '';
  show('finish');
});

// ═══════════════════════════════════════════════════════
//  INPUT
// ═══════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))
    e.preventDefault();
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

setInterval(() => {
  if (phase !== 'racing') return;
  const inp = {
    up:    !!(keys.KeyW || keys.ArrowUp),
    down:  !!(keys.KeyS || keys.ArrowDown),
    left:  !!(keys.KeyA || keys.ArrowLeft),
    right: !!(keys.KeyD || keys.ArrowRight),
  };
  const s = JSON.stringify(inp);
  if (s !== prevInput) { prevInput = s; socket.emit('input', inp); }
}, 16);

// ═══════════════════════════════════════════════════════
//  RENDERING
// ═══════════════════════════════════════════════════════
function render(st) {
  ctx.clearRect(0, 0, WW, HH);
  drawBG();
  if (st.track) {
    track = st.track;
    drawTrack(track);
  }
  tickParticles();
  drawParticles();
  for (const p of st.players) drawCar(p);
}

// ── Background: pixel checkerboard dirt ──
function drawBG() {
  const S = 40;
  for (let r = 0; r < HH / S + 1; r++) {
    for (let c = 0; c < WW / S + 1; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#141810' : '#111510';
      ctx.fillRect(c * S, r * S, S, S);
    }
  }
}

// ── Track: draw each segment as a thick road ──
function drawTrack(t) {
  const { pts, roadWidth } = t;
  const rw = roadWidth;

  // ─ Road fill (multiple passes for thick pixel look) ─
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // Shadow
  ctx.strokeStyle = '#000000aa';
  ctx.lineWidth   = rw * 2 + 12;
  drawPath(pts, true);

  // Asphalt
  ctx.strokeStyle = '#2d2d2d';
  ctx.lineWidth   = rw * 2;
  drawPath(pts, true);

  // Centre dash
  ctx.setLineDash([20, 16]);
  ctx.strokeStyle = '#ffcc0044';
  ctx.lineWidth   = 3;
  drawPath(pts, true);
  ctx.setLineDash([]);

  // Edge lines (white pixel stripes)
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth   = 4;
  // Offset lines not trivial for curves — draw approximate border by using
  // slightly wider stroke then asphalt on top
  ctx.strokeStyle = '#555555';
  ctx.lineWidth   = rw * 2 + 6;
  drawPath(pts, true);
  ctx.strokeStyle = '#2d2d2d';
  ctx.lineWidth   = rw * 2;
  drawPath(pts, true);

  // Redraw white edge as outer border
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth   = rw * 2 + 6;
  drawPath(pts, true);
  ctx.strokeStyle = '#2d2d2d';
  ctx.lineWidth   = rw * 2 - 4;
  drawPath(pts, true);

  // ─ Checkpoint markers ─
  const cpColors = ['#ff9900', '#00ffcc', '#ff3366'];
  for (let i = 0; i < t.checkpointIdx.length; i++) {
    const wp = pts[t.checkpointIdx[i]];
    // Draw dashed gate line perpendicular to road
    const prev = pts[(t.checkpointIdx[i] - 1 + pts.length) % pts.length];
    const next = pts[(t.checkpointIdx[i] + 1) % pts.length];
    const dx = next.x - prev.x, dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    const px = -dy/len * rw, py = dx/len * rw;

    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = cpColors[i];
    ctx.lineWidth   = 3;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(wp.x - px, wp.y - py);
    ctx.lineTo(wp.x + px, wp.y + py);
    ctx.stroke();
    ctx.restore();
  }

  // ─ Start/finish line ─
  const sf = pts[0];
  const sfNext = pts[1];
  const sfDx = sfNext.x - sf.x, sfDy = sfNext.y - sf.y;
  const sfLen = Math.hypot(sfDx, sfDy);
  const sfPx = -sfDy/sfLen * rw, sfPy = sfDx/sfLen * rw;

  const stripes = 8, sw = (rw * 2) / stripes;
  ctx.save();
  ctx.translate(sf.x, sf.y);
  // Rotate so stripes go across the road
  ctx.rotate(Math.atan2(sfDy, sfDx) + Math.PI/2);
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#111111';
    ctx.fillRect(-rw + i * sw, -6, sw, 12);
  }
  ctx.restore();

  // "START" label
  ctx.save();
  ctx.font = 'bold 10px "Courier New"';
  ctx.fillStyle = '#ffcc00';
  ctx.textAlign = 'center';
  ctx.fillText('START', sf.x, sf.y - rw - 8);
  ctx.restore();
}

function drawPath(pts, closed) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (closed) ctx.closePath();
  ctx.stroke();
}

// ── Car: pixel box, angle=0 faces RIGHT ──
function drawCar(p) {
  const isMe = (p.id === myId);
  const cw = 22, ch = 36;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);   // angle=0 → faces right (positive X), standard canvas

  // Pixel shadow
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(-cw/2 + 3, -ch/2 + 4, cw, ch);

  // Body
  ctx.fillStyle = p.color;
  ctx.fillRect(-cw/2, -ch/2, cw, ch);

  // Windshield (lighter rect near front — front = positive Y after rotation)
  ctx.fillStyle = isMe ? 'rgba(200,240,255,0.8)' : 'rgba(160,200,230,0.6)';
  ctx.fillRect(-cw/2 + 3, -ch/2 + 3, cw - 6, ch * 0.32);

  // Wheels (4 dark rects)
  ctx.fillStyle = '#111';
  ctx.fillRect(-cw/2 - 5, -ch/2 + 4,  6, 10);  // front-left
  ctx.fillRect( cw/2 - 1, -ch/2 + 4,  6, 10);  // front-right
  ctx.fillRect(-cw/2 - 5,  ch/2 - 14, 6, 10);  // rear-left
  ctx.fillRect( cw/2 - 1,  ch/2 - 14, 6, 10);  // rear-right

  // Pixel border
  ctx.strokeStyle = isMe ? '#ffffff' : '#aaaaaa';
  ctx.lineWidth   = 2;
  ctx.strokeRect(-cw/2, -ch/2, cw, ch);

  ctx.restore();

  // HP bar (always horizontal, above car)
  const barW = 36, barH = 5;
  const hpFrac = Math.max(0, p.hp / 100);
  ctx.fillStyle = '#111';
  ctx.fillRect(p.x - barW/2, p.y - ch/2 - 12, barW, barH);
  ctx.fillStyle = hpFrac > 0.5 ? '#33ff66' : hpFrac > 0.25 ? '#ffcc00' : '#ff3333';
  ctx.fillRect(p.x - barW/2, p.y - ch/2 - 12, barW * hpFrac, barH);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x - barW/2, p.y - ch/2 - 12, barW, barH);

  // "YOU" tag
  if (isMe) {
    ctx.fillStyle = '#ffffff';
    ctx.font      = 'bold 8px "Courier New"';
    ctx.textAlign = 'center';
    ctx.fillText('YOU', p.x, p.y - ch/2 - 16);
  }

  // Exhaust particle when thrusting
  if (isMe && keys.KeyW || keys.ArrowUp) {
    const back = p.angle + Math.PI;
    spawnParticle(
      p.x + Math.cos(back) * ch/2,
      p.y + Math.sin(back) * ch/2,
      Math.cos(back) * (0.6 + Math.random()) + (Math.random()-.5)*.6,
      Math.sin(back) * (0.6 + Math.random()) + (Math.random()-.5)*.6,
      '#888866', 4 + Math.random() * 2
    );
  }
}

// ═══════════════════════════════════════════════════════
//  PARTICLES
// ═══════════════════════════════════════════════════════
function spawnParticle(x, y, vx, vy, color, size) {
  if (particles.length > 120) return;
  particles.push({ x, y, vx, vy, color, size, life: 1 });
}
function tickParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.life -= 0.055; p.size *= 0.93;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = p.life * 0.8;
    ctx.fillStyle   = p.color;
    ctx.fillRect(Math.round(p.x - p.size/2), Math.round(p.y - p.size/2),
                 Math.round(p.size), Math.round(p.size));
  }
  ctx.globalAlpha = 1;
}

// ═══════════════════════════════════════════════════════
//  HUD
// ═══════════════════════════════════════════════════════
function updateHUD(st) {
  const me  = st.players.find(p => p.id === myId);
  const opp = st.players.find(p => p.id !== myId);
  if (me) {
    elLap.textContent       = `${me.lap}/3`;
    elHpMe.style.width      = `${me.hp}%`;
  }
  if (opp) {
    elOppLap.textContent    = `${opp.lap}/3`;
    elHpOpp.style.width     = `${opp.hp}%`;
  }
}

function showFinish(st) {
  const me  = st.players.find(p => p.id === myId);
  const opp = st.players.find(p => p.id !== myId);
  let title = 'RACE OVER', sub = '';
  if (me?.finished && (!opp?.finished || me.finishTime <= opp.finishTime)) {
    title = '🏆 YOU WIN!'; sub = '3 LAPS COMPLETE';
  } else if (me?.hp <= 0) {
    title = '💥 DNF'; sub = 'DESTROYED';
  } else if (opp?.finished) {
    title = 'YOU LOSE'; sub = 'OPPONENT WINS';
  }
  finTitle.textContent = title;
  finSub.textContent   = sub;
  show('finish');
}
