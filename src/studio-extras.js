// RoyStudio Desktop — Tier 2 & Tier 3 Features
// Live Debugger / Telemetry / Hot-Swap / REPL / CrashReport / Test Runner / Sprite Atlas / Welcome Templates

export function sendStudioCmd(frameEl, payload) {
  try {
    if (frameEl && frameEl.contentWindow) {
      frameEl.contentWindow.postMessage({ type: 'roy-studio-cmd', ...payload }, '*');
      return true;
    }
  } catch {}
  return false;
}

export function renderImageGridOverlay(stageEl, imgEl, gridSize, onPickTile) {
  if (!stageEl || !imgEl) return;
  const old = stageEl.querySelector('.iv-grid-canvas');
  if (old) old.remove();
  if (!gridSize || gridSize <= 0) return;

  const w = imgEl.naturalWidth || 0;
  const h = imgEl.naturalHeight || 0;
  if (!w || !h) return;

  const parent = imgEl.parentElement;
  const canvas = document.createElement('canvas');
  canvas.className = 'iv-grid-canvas';
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = imgEl.clientWidth + 'px';
  canvas.style.height = imgEl.clientHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
  }
  parent.appendChild(canvas);

  parent.onclick = (e) => {
    const rect = imgEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = Math.floor(((e.clientX - rect.left) / rect.width) * w);
    const py = Math.floor(((e.clientY - rect.top) / rect.height) * h);
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const col = Math.floor(px / gridSize);
    const row = Math.floor(py / gridSize);
    const tx = col * gridSize;
    const ty = row * gridSize;
    if (onPickTile) onPickTile({ col, row, x: tx, y: ty, w: gridSize, h: gridSize });
  };
}

export async function packFolderToSpriteAtlas(dirRel, { state, RoyLang, fsBridge, refreshFromDisk, addLog, openFile }) {
  if (typeof RoyLang.packSpriteAtlas !== 'function') {
    throw new Error('RoyLang.packSpriteAtlas недоступен в текущей версии движка');
  }
  const prefix = dirRel ? dirRel.replace(/\/+$/, '') + '/' : '';
  const imgExts = new Set(['png', 'jpg', 'jpeg', 'webp']);
  const candidates = Object.keys(state.assetUrls || {}).filter(p => {
    if (prefix && !p.startsWith(prefix)) return false;
    const ext = p.split('.').pop().toLowerCase();
    return imgExts.has(ext) && !/\/?atlas\.png$/i.test(p);
  }).sort();

  if (!candidates.length) {
    throw new Error(`В папке "${dirRel || '/'}" нет PNG/JPG/WebP спрайтов для упаковки`);
  }

  const loaded = await Promise.all(candidates.map(p => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ path: p, name: p.split('/').pop().replace(/\.[^.]+$/, ''), img, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error(`Не удалось загрузить ${p}`));
    img.src = state.assetUrls[p];
  })));

  const packed = RoyLang.packSpriteAtlas(loaded.map(it => ({ name: it.name, w: it.w, h: it.h })), { padding: 2, pow2: true });
  const canvas = document.createElement('canvas');
  canvas.width = packed.width;
  canvas.height = packed.height;
  const ctx = canvas.getContext('2d');
  const byName = new Map(loaded.map(it => [it.name, it]));

  const frames = {};
  for (const r of (packed.rects || packed.frames || [])) {
    const src = byName.get(r.name);
    if (src) ctx.drawImage(src.img, r.x, r.y);
    frames[r.name] = { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  const dataUrl = canvas.toDataURL('image/png');
  const b64 = dataUrl.split(',')[1];
  const outPng = prefix + 'atlas.png';
  const outRoyson = prefix + 'atlas.royson';
  const roysonText = typeof RoyLang.stringifyRoyson === 'function'
    ? RoyLang.stringifyRoyson({ image: 'atlas.png', width: packed.width, height: packed.height, frames }, { indent: 2, pretty: true, unquotedKeys: true }) + '\n'
    : JSON.stringify({ image: 'atlas.png', width: packed.width, height: packed.height, frames }, null, 2);

  if (state.rootPath && typeof fsBridge.writeFileBase64 === 'function') {
    await fsBridge.writeFileBase64(outPng, b64);
    await fsBridge.writeFile(outRoyson, roysonText);
    await refreshFromDisk();
  } else {
    state.assetBase64[outPng] = b64;
    state.assetUrls[outPng] = dataUrl;
    state.textFiles[outRoyson] = roysonText;
    if (!state.allFiles.includes(outPng)) state.allFiles.push(outPng);
    if (!state.allFiles.includes(outRoyson)) state.allFiles.push(outRoyson);
    state.allFiles.sort();
  }
  addLog(`Спрайт-атлас собран: ${outPng} (${packed.width}×${packed.height}, спрайтов: ${loaded.length})`, 'info');
  if (openFile) openFile(outRoyson);
}

export const PROJECT_TEMPLATES = [
  {
    id: 'empty',
    title: '📄 Пустой проект',
    desc: 'Минимальный каркас game {} + on update / on draw.',
    files: {
      'game.royproj': `project {\n  name: "My RoyGame"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#090d16"\n}\n`,
      'main.roy': `game "My RoyGame" {\n  size: 800x500\n  fps: 60\n}\n\non update(dt) {\n}\n\non draw {\n  cls("#090d16")\n  text("Hello RoyLang v6.9!", 400, 250, "#38bdf8", 24, "center")\n}\n`
    }
  },
  {
    id: 'arcade2d',
    title: '🚀 2D Аркада',
    desc: 'Игрок, звёздное поле, монетки, счёт и watch/tweak.',
    files: {
      'game.royproj': `project {\n  name: "Star Collector"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#070b14"\n}\n`,
      'main.roy': `game "Star Collector" {\n  size: 800x500\n  fps: 60\n  gamepad: "auto"\n}\n\nlet px = 400\nlet py = 250\nlet score = 0\nlet cx = 200\nlet cy = 160\n\non update(dt) {\n  let spd = tweak("Скорость", 260, 80, 600, 10)\n  if key("ArrowLeft") or key("KeyA") { px -= spd * dt }\n  if key("ArrowRight") or key("KeyD") { px += spd * dt }\n  if key("ArrowUp") or key("KeyW") { py -= spd * dt }\n  if key("ArrowDown") or key("KeyS") { py += spd * dt }\n  px = clamp(px, 20, 780)\n  py = clamp(py, 20, 480)\n  if dist(px, py, cx, cy) < 28 {\n    score += 10\n    cx = randInt(50, 750)\n    cy = randInt(60, 440)\n  }\n  watch("score", score)\n  watch("pos", round(px) + ", " + round(py))\n}\n\non draw {\n  cls("#070b14")\n  drawGrid(40, "rgba(56,189,248,0.07)")\n  drawGlow(cx, cy, 30, "#fbbf24", 0.45)\n  drawCircle(cx, cy, 11, "#fbbf24")\n  drawGlow(px, py, 36, "#38bdf8", 0.35)\n  drawCircle(px, py, 16, "#38bdf8")\n  text("Счёт: " + score, 20, 28, "#f8fafc", 18)\n}\n`
    }
  },
  {
    id: 'platformer',
    title: '🏃 Платформер',
    desc: 'Гравитация, прыжок, платформы и камера.',
    files: {
      'game.royproj': `project {\n  name: "Neon Jumper"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#0b1020"\n}\n`,
      'main.roy': `game "Neon Jumper" {\n  size: 800x500\n  fps: 60\n}\n\nlet x = 120\nlet y = 340\nlet vx = 0\nlet vy = 0\nlet grounded = false\nlet plats = [\n  { x: 0, y: 440, w: 800, h: 60 },\n  { x: 180, y: 340, w: 160, h: 18 },\n  { x: 430, y: 260, w: 180, h: 18 }\n]\n\non update(dt) {\n  let moveSpd = tweak("Бег", 240, 100, 500, 10)\n  let jumpF = tweak("Прыжок", 480, 250, 800, 10)\n  vx = 0\n  if key("ArrowLeft") or key("KeyA") { vx = -moveSpd }\n  if key("ArrowRight") or key("KeyD") { vx = moveSpd }\n  if (keyPressed("Space") or keyPressed("ArrowUp") or keyPressed("KeyW")) and grounded {\n    vy = -jumpF\n    grounded = false\n  }\n  vy += 1100 * dt\n  x = clamp(x + vx * dt, 16, 784)\n  y += vy * dt\n  grounded = false\n  for p in plats {\n    if x + 14 > p.x and x - 14 < p.x + p.w and y + 16 >= p.y and y + 16 <= p.y + 24 and vy >= 0 {\n      y = p.y - 16\n      vy = 0\n      grounded = true\n    }\n  }\n}\n\non draw {\n  cls("#0b1020")\n  for p in plats {\n    drawRect(p.x, p.y, p.w, p.h, "#1e293b")\n    strokeRect(p.x, p.y, p.w, p.h, "#38bdf8", 2)\n  }\n  drawRect(x - 14, y - 16, 28, 32, "#f43f5e")\n  text("A/D — бег, Space — прыжок", 20, 28, "#94a3b8", 14)\n}\n`
    }
  },
  {
    id: 'scene3d',
    title: '🔫 3D Арена (FPS)',
    desc: 'Мини-шутер от первого лица: drawRaycaster3D, WASD, стрельба, мишени и мини-карта.',
    files: {
      'game.royproj': `project {\n  name: "Roy3D Arena"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#04070f"\n}\n`,
      'main.roy': `game "Roy3D Arena" {\n  size: 800x500\n  fps: 60\n}\n\nlet map = [\n  "##########",\n  "#........#",\n  "#..22..3.#",\n  "#..2.....#",\n  "#.....33.#",\n  "#..3.....#",\n  "#....22..#",\n  "#........#",\n  "##########"\n]\n\nlet px = 1.5\nlet py = 1.5\nlet pa = 0.5\nlet score = 0\nlet flash = 0\nlet recoil = 0\n\nlet targets = [\n  { x: 5.5, y: 1.5, color: "#f43f5e", scale: 0.65, aspect: 0.7, alive: true },\n  { x: 7.5, y: 3.5, color: "#fbbf24", scale: 0.65, aspect: 0.7, alive: true },\n  { x: 2.5, y: 6.5, color: "#34d399", scale: 0.65, aspect: 0.7, alive: true },\n  { x: 7.5, y: 7.5, color: "#a78bfa", scale: 0.65, aspect: 0.7, alive: true }\n]\n\nfn isSolid(wx, wy) {\n  let gx = floor(wx)\n  let gy = floor(wy)\n  if gy < 0 or gy >= len(map) or gx < 0 or gx >= 10 { return true }\n  let ch = map[gy][gx]\n  return ch != "."\n}\n\nfn hasLos(x1, y1, x2, y2) {\n  let steps = 16\n  for i in 1..steps {\n    let k = i / steps\n    if isSolid(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k) { return false }\n  }\n  return true\n}\n\non update(dt) {\n  let spd = tweak("Скорость", 2.8, 1.0, 6.0, 0.2)\n  let turn = tweak("Поворот", 2.4, 1.0, 5.0, 0.2)\n  if key("ArrowLeft") or key("KeyQ") { pa -= turn * dt }\n  if key("ArrowRight") or key("KeyE") { pa += turn * dt }\n\n  let mx = 0\n  let my = 0\n  if key("KeyW") or key("ArrowUp") { mx += cos(pa); my += sin(pa) }\n  if key("KeyS") or key("ArrowDown") { mx -= cos(pa); my -= sin(pa) }\n  if key("KeyA") { mx += sin(pa); my -= cos(pa) }\n  if key("KeyD") { mx -= sin(pa); my += cos(pa) }\n\n  let nx = px + mx * spd * dt\n  let ny = py + my * spd * dt\n  if !isSolid(nx, py) { px = nx }\n  if !isSolid(px, ny) { py = ny }\n\n  flash = max(0, flash - dt)\n  recoil = max(0, recoil - dt * 5)\n\n  if keyPressed("Space") or mouse.clicked {\n    flash = 0.1\n    recoil = 1\n    for t in targets {\n      let d = dist(px, py, t.x, t.y)\n      let ang = atan2(t.y - py, t.x - px) - pa\n      while ang > 3.14159 { ang -= 6.28318 }\n      while ang < -3.14159 { ang += 6.28318 }\n      if abs(ang) < 0.18 and d < 9 and hasLos(px, py, t.x, t.y) {\n        score += 10\n        let rx = randInt(1, 8) + 0.5\n        let ry = randInt(1, 7) + 0.5\n        if !isSolid(rx, ry) { t.x = rx; t.y = ry }\n        break\n      }\n    }\n  }\n\n  watch("score", score)\n  watch("pos", (round(px * 10) / 10) + ", " + (round(py * 10) / 10))\n}\n\non draw {\n  cls("#04070f")\n  drawRaycaster3D(map, { x: px, y: py, angle: pa, fov: 1.15 }, {\n    tileSize: 1,\n    step: 2,\n    ceilColor: "#0a0f1c",\n    floorColor: "#1b2434",\n    fogColor: "#04070f",\n    fogDist: 9,\n    wallColors: { "#": "#475569", "2": "#0ea5e9", "3": "#f43f5e" },\n    sprites: targets\n  })\n\n  // Прицел\n  drawLine(390, 250, 396, 250, "#38bdf8", 2)\n  drawLine(404, 250, 410, 250, "#38bdf8", 2)\n  drawLine(400, 240, 400, 246, "#38bdf8", 2)\n  drawLine(400, 254, 400, 260, "#38bdf8", 2)\n\n  // Бластер\n  let wy = 415 + recoil * 22\n  if flash > 0 { drawGlow(400, wy - 12, 46, "#fbbf24", 0.7) }\n  drawRect(382, wy, 36, 90, "#334155")\n  drawRect(390, wy - 10, 20, 22, "#0ea5e9")\n\n  // Мини-карта\n  let mmX = 678\n  let mmY = 12\n  let cs = 11\n  drawRect(mmX - 4, mmY - 4, 10 * cs + 8, 9 * cs + 8, "rgba(4,7,15,0.78)")\n  for gy in 0..9 {\n    for gx in 0..10 {\n      if map[gy][gx] != "." {\n        let wc = map[gy][gx] == "2" ? "#0ea5e9" : (map[gy][gx] == "3" ? "#f43f5e" : "#475569")\n        drawRect(mmX + gx * cs, mmY + gy * cs, cs - 1, cs - 1, wc)\n      }\n    }\n  }\n  for t in targets { drawCircle(mmX + t.x * cs, mmY + t.y * cs, 2.5, t.color) }\n  drawCircle(mmX + px * cs, mmY + py * cs, 3, "#f8fafc")\n  drawLine(mmX + px * cs, mmY + py * cs, mmX + (px + cos(pa) * 0.9) * cs, mmY + (py + sin(pa) * 0.9) * cs, "#38bdf8", 1.5)\n\n  // HUD\n  drawRect(0, 464, 800, 36, "rgba(4,7,15,0.85)")\n  text("ROY3D ARENA · СЧЁТ: " + score, 16, 487, "#38bdf8", 15)\n  text("WASD — ход · ←/→ — поворот · SPACE / ЛКМ — выстрел", 784, 487, "#94a3b8", 12, "right")\n}\n`
    }
  }
];
