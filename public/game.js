const socket = io();

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
let myId  = null;
let myIdx = null;
let WW = 1200, HH = 700;
let phase = 'lobby';
let trackData = null;   // { pts, roadW, cp }
let segs = [];          // precomputed segments

const keys = {};
let prevInputStr = '';
const particles  = [];

// ═══════════════════════════════════════════════════════
//  DOM
// ═══════════════════════════════════════════════════════
const sLobby     = document.getElementById('s-lobby');
const sWaiting   = document.getElementById('s-waiting');
const sCountdown = document.getElementById('s-countdown');
const sFinish    = document.getElementById('s-finish');
const cdNum      = document.getElementById('cd-num');
const finTitle   = document.getElementById('finish-title');
const finSub     = document.getElementById('finish-sub');
const tagRoom    = document.getElementById('tag-room');
const inpRoom    = document.getElementById('inp-room');
const btnJoin    = document.getElementById('btn-join');
const btnRematch = document.getElementById('btn-rematch');
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
  const s = Math.min(window.innerWidth / WW, window.innerHeight / HH);
  canvas.style.width  = Math.floor(WW * s) + 'px';
  canvas.style.height = Math.floor(HH * s) + 'px';
}
window.addEventListener('resize', scaleCanvas);

// ═══════════════════════════════════════════════════════
//  SCREENS
// ═══════════════════════════════════════════════════════
function show(screen) {
  [sLobby, sWaiting, sCountdown, sFinish].forEach(el => el.classList.add('hidden'));
  if (screen === 'lobby')     sLobby.classList.remove('hidden');
  if (screen === 'waiting')   sWaiting.classList.remove('hidden');
  if (screen === 'countdown') sCountdown.classList.remove('hidden');
  if (screen === 'finish')    sFinish.classList.remove('hidden');
  phase = screen;
}

// ═══════════════════════════════════════════════════════
//  LOBBY
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

// ═══════════════════════════════════════════════════════
//  SOCKET
// ═══════════════════════════════════════════════════════
socket.on('joined', ({ idx }) => {
  myIdx = idx;
  canvas.width  = WW;
  canvas.height = HH;
  scaleCanvas();
});

socket.on('full', () => { show('lobby'); alert('Room full.'); });
socket.on('waiting', () => {});

socket.on('countdown', n => {
  show('countdown');
  cdNum.textContent = n === 0 ? 'GO!' : String(n);
  cdNum.style.animation = 'none';
  void cdNum.offsetWidth;
  cdNum.style.animation = '';
});

socket.on('go', () => {
  sCountdown.classList.add('hidden');
  hud.style.display = 'block';
  phase = 'racing';
});

socket.on('state', st => {
  // First state: latch our id, extract track
  if (!myId) {
    const me = st.players.find(p => p.idx === myIdx);
    if (me) myId = me.id;
  }
  if (!trackData && st.trackPts) {
    trackData = { pts: st.trackPts, roadW: st.roadW, cp: st.cp };
    segs = buildSegs(trackData.pts);
  }

  // Always show canvas once we have state
  if (canvas.style.display !== 'block') {
    canvas.style.display = 'block';
    canvas.width  = st.W || WW;
    canvas.height = st.H || HH;
    WW = st.W || WW;
    HH = st.H || HH;
    scaleCanvas();
  }

  render(st);
  updateHUD(st);

  if (st.state === 'finished' && phase !== 'finish') {
    setTimeout(() => { showFinish(st); show('finish'); }, 800);
    phase = 'finish';
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
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
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
  if (s !== prevInputStr) { prevInputStr = s; socket.emit('input', inp); }
}, 16);

// ═══════════════════════════════════════════════════════
//  TRACK HELPERS (client-side, mirrors server)
// ═══════════════════════════════════════════════════════
function buildSegs(pts) {
  return pts.map((a, i) => {
    const b = pts[(i+1) % pts.length];
    const dx = b.x-a.x, dy = b.y-a.y;
    return { ax:a.x, ay:a.y, bx:b.x, by:b.y, dx, dy, len:Math.hypot(dx,dy) };
  });
}

// ═══════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════
function render(st) {
  ctx.clearRect(0, 0, WW, HH);
  drawBG();
  if (trackData) drawTrack();
  tickParticles();
  drawParticles();
  for (const p of st.players) drawCar(p);
}

// ── Pixel checkerboard grass ──
function drawBG() {
  const S = 50;
  for (let r = 0; r < Math.ceil(HH/S); r++) {
    for (let c = 0; c < Math.ceil(WW/S); c++) {
      ctx.fillStyle = (r+c)%2===0 ? '#131a0e' : '#101508';
      ctx.fillRect(c*S, r*S, S, S);
    }
  }
}

// ── Road ──
function drawTrack() {
  const { pts, roadW, cp } = trackData;
  const N = pts.length;

  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // 1. Kerb (outer border — slightly wider, red/white alternating would be complex,
  //    so just a bright contrasting outer edge)
  ctx.strokeStyle = '#cc2222';
  ctx.lineWidth   = roadW * 2 + 18;
  tracePath(pts);

  // 2. Road surface
  ctx.strokeStyle = '#333333';
  ctx.lineWidth   = roadW * 2;
  tracePath(pts);

  // 3. Inner kerb strip
  ctx.strokeStyle = '#cc2222';
  ctx.lineWidth   = roadW * 2 - 14;
  tracePath(pts);

  // 4. Inner road (covers most of kerb)
  ctx.strokeStyle = '#333333';
  ctx.lineWidth   = roadW * 2 - 22;
  tracePath(pts);

  // 5. Road surface texture — subtle noise stripes
  ctx.strokeStyle = '#2c2c2c';
  ctx.lineWidth   = roadW * 2 - 22;
  tracePath(pts);

  // 6. Centre dashed line
  ctx.setLineDash([24, 18]);
  ctx.strokeStyle = '#ffee0055';
  ctx.lineWidth   = 3;
  tracePath(pts);
  ctx.setLineDash([]);

  // 7. Direction arrows along the track
  drawDirectionArrows(pts, roadW);

  // 8. Checkpoint gates
  const cpColors = ['#ff9900', '#00ffcc', '#ff3366'];
  for (let i = 0; i < cp.length; i++) {
    const idx  = cp[i];
    const wp   = pts[idx];
    const prev = pts[(idx-1+N)%N];
    const next = pts[(idx+1)%N];
    // Perpendicular direction
    const tdx = next.x-prev.x, tdy = next.y-prev.y;
    const tlen = Math.hypot(tdx, tdy);
    const px = -tdy/tlen * roadW, py = tdx/tlen * roadW;

    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = cpColors[i];
    ctx.lineWidth   = 4;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(wp.x - px, wp.y - py);
    ctx.lineTo(wp.x + px, wp.y + py);
    ctx.stroke();

    // CP label
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([]);
    ctx.fillStyle   = cpColors[i];
    ctx.font        = 'bold 9px "Courier New"';
    ctx.textAlign   = 'center';
    ctx.fillText(`CP${i+1}`, wp.x, wp.y - roadW - 6);
    ctx.restore();
  }

  // 9. Start/finish line
  const sf   = pts[0];
  const sfN  = pts[1];
  const tdx  = sfN.x - sf.x, tdy = sfN.y - sf.y;
  const tlen = Math.hypot(tdx, tdy);
  const px   = -tdy/tlen * roadW, py = tdx/tlen * roadW;
  const ang  = Math.atan2(tdy, tdx);

  ctx.save();
  ctx.translate(sf.x, sf.y);
  ctx.rotate(ang + Math.PI/2);
  const stripes = 8, sw = (roadW * 2) / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i%2===0 ? '#ffffff' : '#111111';
    ctx.fillRect(-roadW + i*sw, -7, sw, 14);
  }
  ctx.restore();

  // "START" label above line
  ctx.fillStyle   = '#ffee00';
  ctx.font        = 'bold 11px "Courier New"';
  ctx.textAlign   = 'center';
  ctx.fillText('START / FINISH', sf.x + px*0.5, sf.y + py*0.5 - roadW - 10);
}

function tracePath(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
}

function drawDirectionArrows(pts, roadW) {
  const N = pts.length;
  // Draw an arrow every ~3 waypoints
  const step = 3;
  ctx.fillStyle   = 'rgba(255,255,255,0.18)';
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < N; i += step) {
    const a = pts[i], b = pts[(i+1)%N];
    const dx = b.x-a.x, dy = b.y-a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    const nx = dx/len, ny = dy/len;
    const px = -ny, py = nx;  // perpendicular
    const sz = 14;

    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.beginPath();
    ctx.moveTo( sz,    0);
    ctx.lineTo(-sz/2,  sz*0.55);
    ctx.lineTo(-sz/2, -sz*0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// ── Car ──
function drawCar(p) {
  const isMe = p.id === myId;
  const cw = 20, ch = 32;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);

  // Drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(-cw/2+4, -ch/2+5, cw, ch);

  // Body
  ctx.fillStyle = p.color;
  ctx.fillRect(-cw/2, -ch/2, cw, ch);

  // Windshield
  ctx.fillStyle = isMe ? 'rgba(180,230,255,0.85)' : 'rgba(140,190,220,0.6)';
  ctx.fillRect(-cw/2+3, -ch/2+3, cw-6, ch*0.3);

  // Rear stripe
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(-cw/2+3, ch/2-8, cw-6, 5);

  // Wheels — 4 corners
  ctx.fillStyle = '#0a0a0a';
  const wx = cw/2 + 4, wh = 12, wy = ch/2 - 14;
  ctx.fillRect(-wx,    -ch/2+4, 5, wh);  // front-left
  ctx.fillRect( wx-5,  -ch/2+4, 5, wh);  // front-right
  ctx.fillRect(-wx,     wy,     5, wh);  // rear-left
  ctx.fillRect( wx-5,   wy,     5, wh);  // rear-right

  // Pixel outline
  ctx.strokeStyle = isMe ? '#ffffff' : '#888888';
  ctx.lineWidth   = 2;
  ctx.strokeRect(-cw/2, -ch/2, cw, ch);

  ctx.restore();

  // HP bar (world-space, always horizontal)
  const bw = 40, bh = 5;
  const hpF = Math.max(0, p.hp / 100);
  const bx = p.x - bw/2, by = p.y - ch/2 - 13;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = hpF > 0.5 ? '#33ff66' : hpF > 0.25 ? '#ffcc00' : '#ff2222';
  ctx.fillRect(bx, by, bw * hpF, bh);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);

  // "YOU" label
  if (isMe) {
    ctx.fillStyle   = '#ffffff';
    ctx.font        = 'bold 8px "Courier New"';
    ctx.textAlign   = 'center';
    ctx.fillText('YOU ▼', p.x, by - 4);
  }

  // Exhaust particles when accelerating
  if (isMe && (keys.KeyW || keys.ArrowUp)) {
    const back = p.angle + Math.PI;
    for (let i = 0; i < 2; i++) {
      spawnParticle(
        p.x + Math.cos(back) * ch/2 + (Math.random()-.5)*6,
        p.y + Math.sin(back) * ch/2 + (Math.random()-.5)*6,
        Math.cos(back)*(0.5+Math.random()*0.8) + (Math.random()-.5)*.5,
        Math.sin(back)*(0.5+Math.random()*0.8) + (Math.random()-.5)*.5,
        '#888866', 3 + Math.random()*2
      );
    }
  }
}

// ═══════════════════════════════════════════════════════
//  PARTICLES
// ═══════════════════════════════════════════════════════
function spawnParticle(x, y, vx, vy, color, size) {
  if (particles.length > 150) return;
  particles.push({ x, y, vx, vy, color, size, life:1 });
}
function tickParticles() {
  for (let i = particles.length-1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.life -= 0.05; p.size *= 0.94;
    if (p.life <= 0) particles.splice(i, 1);
  }
}
function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = p.life * 0.75;
    ctx.fillStyle   = p.color;
    ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.size), Math.round(p.size));
  }
  ctx.globalAlpha = 1;
}

// ═══════════════════════════════════════════════════════
//  HUD
// ═══════════════════════════════════════════════════════
function updateHUD(st) {
  const me  = st.players.find(p => p.id === myId);
  const opp = st.players.find(p => p.id !== myId);
  if (me)  { elLap.textContent    = `${me.lap}/3`;  elHpMe.style.width  = `${me.hp}%`;  }
  if (opp) { elOppLap.textContent = `${opp.lap}/3`; elHpOpp.style.width = `${opp.hp}%`; }
}

function showFinish(st) {
  const me  = st.players.find(p => p.id === myId);
  const opp = st.players.find(p => p.id !== myId);
  if (me?.finished && (!opp?.finished || me.finishTime <= opp.finishTime)) {
    finTitle.textContent = '🏆 YOU WIN!'; finSub.textContent = '3 LAPS DONE';
  } else if (me?.hp <= 0) {
    finTitle.textContent = '💥 DNF'; finSub.textContent = 'WRECKED';
  } else {
    finTitle.textContent = 'YOU LOSE'; finSub.textContent = 'OPPONENT WINS';
  }
}
