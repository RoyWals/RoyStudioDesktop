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
  },
  {
    id: 'webgpu3d_ragdoll',
    title: '🦾 WebGPU 3D v3 + Ragdoll',
    desc: '3D-сцена v7.0, физика ragdoll3D и интерактивная камера.',
    files: {
      'game.royproj': `project {\n  name: "WebGPU 3D Ragdoll"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#070b14"\n}\n`,
      'main.roy': `game "WebGPU 3D Ragdoll" {\n  size: 800x500\n  fps: 60\n}\n\nlet phys = physics3D()\nlet s3d = webgpuScene3D({ shadows: true })\nlet rag = ragdoll3D(phys, { x: 0, y: 4, z: 0, scale: 1.0 })\nlet meshes = {\n  head: s3d.addSphere({ x: 0, y: 5, z: 0, r: 0.22, color: "#38bdf8" }),\n  chest: s3d.addSphere({ x: 0, y: 4.5, z: 0, r: 0.26, color: "#0ea5e9" }),\n  pelvis: s3d.addSphere({ x: 0, y: 4, z: 0, r: 0.24, color: "#0284c7" }),\n  lHand: s3d.addSphere({ x: -0.4, y: 4.5, z: 0, r: 0.14, color: "#f472b6" }),\n  rHand: s3d.addSphere({ x: 0.4, y: 4.5, z: 0, r: 0.14, color: "#f472b6" }),\n  lKnee: s3d.addSphere({ x: -0.2, y: 3.4, z: 0, r: 0.15, color: "#a78bfa" }),\n  rKnee: s3d.addSphere({ x: 0.2, y: 3.4, z: 0, r: 0.15, color: "#a78bfa" }),\n  lFoot: s3d.addSphere({ x: -0.2, y: 2.8, z: 0, r: 0.14, color: "#34d399" }),\n  rFoot: s3d.addSphere({ x: 0.2, y: 2.8, z: 0, r: 0.14, color: "#34d399" })\n}\n\non start {\n  phys.addPlane(0, 0, 0)\n  s3d.addBox({ x: 0, y: -0.25, z: 0, w: 12, h: 0.5, d: 12, color: "#1e293b" })\n  s3d.setCamera(0, 2.8, 6.5, 0, 1.2, 0)\n}\n\non update(dt) {\n  if keyPressed("Space") {\n    rag = ragdoll3D(phys, { x: 0, y: 4.5, z: 0, scale: 1.0 })\n    rag.impulse(0.6, 1.5, 0)\n  }\n  phys.step(dt)\n  rag.syncMeshes(meshes)\n}\n\non draw {\n  cls("#070b14")\n  s3d.render()\n  text("WebGPU 3D v3 + Ragdoll3D · Space — сбросить манекен", 400, 28, "#38bdf8", 15, "center")\n}\n`
    }
  },
  {
    id: 'pro25d',
    title: '🏛 2.5D Pro (Doom/Build)',
    desc: 'Секторный/рейкаст 2.5D уровень с освещением и туманом.',
    files: {
      'game.royproj': `project {\n  name: "2.5D Pro Sector"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#050810"\n}\n`,
      'main.roy': `game "2.5D Pro Sector" {\n  size: 800x500\n  fps: 60\n}\n\nlet map = [\n  "########",\n  "#......#",\n  "#..2...#",\n  "#....3.#",\n  "#......#",\n  "########"\n]\nlet px = 1.5\nlet py = 1.5\nlet pa = 0.4\n\non update(dt) {\n  if key("ArrowLeft") { pa -= 2.2 * dt }\n  if key("ArrowRight") { pa += 2.2 * dt }\n  if key("KeyW") { px += cos(pa) * 2.5 * dt; py += sin(pa) * 2.5 * dt }\n  if key("KeyS") { px -= cos(pa) * 2.5 * dt; py -= sin(pa) * 2.5 * dt }\n}\n\non draw {\n  cls("#050810")\n  drawRaycaster3D(map, { x: px, y: py, angle: pa, fov: 1.2 }, { tileSize: 1, fogDist: 8, wallColors: { "#": "#334155", "2": "#0ea5e9", "3": "#f43f5e" } })\n  text("2.5D Pro · WASD + ←/→", 20, 28, "#e2e8f0", 14)\n}\n`
    }
  },
  {
    id: 'hd2d',
    title: '✨ HD-2D Octopath',
    desc: 'Стилизованная HD-2D сцена с глубиной, светом и пиксельными спрайтами.',
    files: {
      'game.royproj': `project {\n  name: "HD-2D Octopath"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#090b16"\n}\n`,
      'main.roy': `game "HD-2D Octopath" {\n  size: 800x500\n  fps: 60\n}\n\nlet sc = hd2dScene({ tilt: 0.45, dof: true, bloom: 0.35 })\nlet t = 0\n\non update(dt) {\n  t += dt\n}\n\non draw {\n  cls("#090b16")\n  sc.render()\n  drawGlow(400 + cos(t) * 120, 240, 80, "#fbbf24", 0.35)\n  text("HD-2D Octopath Scene (v7.0)", 400, 28, "#fde68a", 16, "center")\n}\n`
    }
  },
  {
    id: 'desktop_osapp',
    title: '🖥 Desktop-утилита (UI 3.0 + osApp)',
    desc: 'Нативное приложение на UI 3.0, .royui и Desktop OS Bridge.',
    files: {
      'game.royproj': `project {\n  name: "RoyNotes Desktop"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#121212"\n}\n`,
      'layout.royui': `{\n  title: "RoyNotes"\n  theme: "dark"\n  padding: 16\n}\n`,
      'main.roy': `game "RoyNotes Desktop" {\n  size: 800x500\n  fps: 60\n}\n\nlet note = "Привет из RoyLang v7.0 osApp!"\n\non start {\n  osApp.window.setTitle("RoyNotes — Desktop Utility")\n}\n\non draw {\n  cls("#121212")\n  text("Desktop UI 3.0 + osApp", 24, 34, "#38bdf8", 18)\n  note = textArea("note_box", 24, 56, 752, 340, { value: note })\n  if button("btn_notify", "Уведомление OS", 24, 416, 170, 36) {\n    osApp.notify("RoyNotes", "Заметка активна (" + len(note) + " симв.)")\n  }\n  if button("btn_copy", "Копировать в буфер", 210, 416, 180, 36) {\n    osApp.clipboard.write(note)\n  }\n}\n`
    }
  },
  {
    id: 'mini_daw',
    title: '🎹 Мини-DAW + Export .wav',
    desc: 'Аудио-секвенсор на audioDSP / audioTracker и экспорт WAV.',
    files: {
      'game.royproj': `project {\n  name: "RoyDAW Studio"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#0b0f19"\n}\n`,
      'main.roy': `game "RoyDAW Studio" {\n  size: 800x500\n  fps: 60\n}\n\nlet dsp = audioDSP({ bpm: 124 })\nlet trk = audioTracker({ steps: 16, bpm: 124 })\nlet playing = false\n\non draw {\n  cls("#0b0f19")\n  text("RoyDAW · v70-apex AudioDSP", 24, 34, "#f472b6", 18)\n  if button("btn_play", playing ? "⏹ Стоп" : "▶ Играть бит", 24, 70, 160, 38) {\n    playing = !playing\n    if playing { trk.play() } else { trk.stop() }\n  }\n  if button("btn_wav", "💾 Экспорт .wav", 200, 70, 170, 38) {\n    exportWav("beat.wav", dsp.render(2.0))\n  }\n}\n`
    }
  },
  {
    id: 'mp_server',
    title: '🌐 Мультиплеер Сервер (--target server)',
    desc: 'Авторитетный Node.js сервер (serverRoom + matchmaker + antiCheat).',
    files: {
      'game.royproj': `project {\n  name: "RoyNet Server"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 20\n  bg: "#090d16"\n}\n`,
      'main.roy': `#if TARGET_SERVER\nlet room = serverRoom({ maxPlayers: 16, tickRate: 20 })\nlet ac = antiCheat({ maxSpeed: 400 })\n\non start {\n  print("Authoritative RoyServer started!")\n}\n#else\ngame "RoyNet Server Preview" {\n  size: 800x500\n  fps: 60\n}\non draw {\n  cls("#090d16")\n  text("Выбери 📦 Сборка → Server (Node) для экспорта server.mjs", 400, 250, "#34d399", 16, "center")\n}\n#endif\n`
    }
  },
  {
    id: 'wasm_accel',
    title: '⚡ WASM-ускоритель (--target wasm)',
    desc: 'Компиляция циклов и математики в нативный .wasm + .wat.',
    files: {
      'game.royproj': `project {\n  name: "RoyWASM Kernel"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#090d16"\n}\n`,
      'main.roy': `fn fastSum(n) {\n  let s = 0\n  for i in 0..n {\n    s += i * 2\n  }\n  return s\n}\n\n#if TARGET_WEB\ngame "RoyWASM Kernel" {\n  size: 800x500\n  fps: 60\n}\non draw {\n  cls("#090d16")\n  text("fastSum(1000) = " + fastSum(1000), 400, 230, "#fbbf24", 20, "center")\n  text("Выбери 📦 Сборка → WASM (.wasm) для бинарного .wasm", 400, 270, "#94a3b8", 13, "center")\n}\n#endif\n`
    }
  },
  {
    id: 'cutscene_director',
    title: '🎬 Катсцена (Director + LipSync)',
    desc: 'Режиссёрская шкала времени directorTimeline и lipSync.',
    files: {
      'game.royproj': `project {\n  name: "Director Cutscene"\n  version: "0.1.0"\n  entry: "main.roy"\n  size: 800x500\n  fps: 60\n  bg: "#090a14"\n}\n`,
      'main.roy': `game "Director Cutscene" {\n  size: 800x500\n  fps: 60\n}\n\nlet dir = directorTimeline({ duration: 6.0, loop: true })\nlet mouth = lipSync({ sensitivity: 1.2 })\n\non update(dt) {\n  dir.update(dt)\n  mouth.update(dt)\n}\n\non draw {\n  cls("#090a14")\n  let t = dir.time()\n  drawCircle(400, 240, 64, "#38bdf8")\n  drawCircle(378, 224, 8, "#090a14")\n  drawCircle(422, 224, 8, "#090a14")\n  drawRect(382, 260, 36, 6 + abs(sin(t * 9)) * 14, "#090a14")\n  text("DirectorTimeline t = " + (round(t * 10) / 10) + "s", 400, 42, "#e2e8f0", 16, "center")\n}\n`
    }
  }
];


// === Interactive 3D Model Viewer (.obj / .gltf / .glb) ===
function decodeBase64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function parseObjMesh(text) {
  const verts = [];
  const faces = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      verts.push([Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0]);
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const idx = parts.slice(1).map(tok => {
        const vi = parseInt(tok.split('/')[0], 10);
        return vi < 0 ? verts.length + vi : vi - 1;
      }).filter(i => Number.isFinite(i) && i >= 0);
      for (let i = 1; i + 1 < idx.length; i++) {
        faces.push([idx[0], idx[i], idx[i + 1]]);
      }
    }
  }
  return { verts, faces };
}

function extractGltfPrimitive(gltf, getBufferBytes) {
  const mesh = gltf?.meshes?.[0];
  const prim = mesh?.primitives?.[0];
  if (!prim || prim.attributes?.POSITION == null) return { verts: [], faces: [] };

  const readAccessor = (accIdx) => {
    const acc = gltf.accessors[accIdx];
    const bv = gltf.bufferViews[acc.bufferView];
    const buf = getBufferBytes(bv.buffer || 0);
    const byteOff = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const dv = new DataView(buf.buffer, buf.byteOffset + byteOff, buf.byteLength - byteOff);
    const compCount = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
    const stride = bv.byteStride || (compCount * (acc.componentType === 5123 ? 2 : acc.componentType === 5121 ? 1 : 4));
    const out = [];
    for (let i = 0; i < acc.count; i++) {
      const base = i * stride;
      for (let c = 0; c < compCount; c++) {
        if (acc.componentType === 5126) out.push(dv.getFloat32(base + c * 4, true));
        else if (acc.componentType === 5123) out.push(dv.getUint16(base + c * 2, true));
        else if (acc.componentType === 5125) out.push(dv.getUint32(base + c * 4, true));
        else if (acc.componentType === 5121) out.push(dv.getUint8(base + c));
      }
    }
    return out;
  };

  const pos = readAccessor(prim.attributes.POSITION);
  const verts = [];
  for (let i = 0; i + 2 < pos.length; i += 3) verts.push([pos[i], pos[i + 1], pos[i + 2]]);
  const faces = [];
  if (prim.indices != null) {
    const ind = readAccessor(prim.indices);
    for (let i = 0; i + 2 < ind.length; i += 3) faces.push([ind[i], ind[i + 1], ind[i + 2]]);
  } else {
    for (let i = 0; i + 2 < verts.length; i += 3) faces.push([i, i + 1, i + 2]);
  }
  return { verts, faces };
}

function parseGlbMesh(b64) {
  const bytes = decodeBase64ToBytes(b64);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) return { verts: [], faces: [] };
  let off = 12;
  let gltf = null;
  let binChunk = null;
  while (off + 8 <= dv.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const slice = bytes.subarray(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) gltf = JSON.parse(new TextDecoder().decode(slice));
    else if (type === 0x004E4942) binChunk = slice;
    off += 8 + len;
  }
  if (!gltf || !binChunk) return { verts: [], faces: [] };
  return extractGltfPrimitive(gltf, () => binChunk);
}

function parseGltfMesh(text) {
  const gltf = JSON.parse(text);
  const bufs = (gltf.buffers || []).map(b => {
    const uri = String(b.uri || '');
    const m = /^data:[^;]*;base64,(.+)$/i.exec(uri);
    return m ? decodeBase64ToBytes(m[1]) : new Uint8Array(0);
  });
  return extractGltfPrimitive(gltf, (i) => bufs[i] || new Uint8Array(0));
}

export function mountModel3DViewer(stageEl, controlsEl, metaEl, { path, text, base64 }) {
  const ext = path.split('.').pop().toLowerCase();
  let mesh = { verts: [], faces: [] };
  try {
    if (ext === 'obj') mesh = parseObjMesh(text);
    else if (ext === 'glb') mesh = parseGlbMesh(base64);
    else if (ext === 'gltf') mesh = parseGltfMesh(text);
  } catch {}

  if (!mesh.verts.length) {
    metaEl.textContent = `${path} · Не удалось прочитать геометрию`;
    stageEl.innerHTML = '<div class="muted">Пустая или внешне-буферная 3D-модель.</div>';
    controlsEl.innerHTML = '';
    return () => {};
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of mesh.verts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  const scale = 2.2 / Math.max(0.0001, maxX - minX, maxY - minY, maxZ - minZ);
  const normVerts = mesh.verts.map(([x, y, z]) => [(x - cx) * scale, (y - cy) * scale, (z - cz) * scale]);
  const maxFaces = mesh.faces.length > 6000 ? mesh.faces.slice(0, 6000) : mesh.faces;

  metaEl.textContent = `${path} · Вершин: ${mesh.verts.length} · Треугольников: ${mesh.faces.length}`;
  controlsEl.innerHTML = `
    <button id="m3dWire">Каркас</button>
    <button id="m3dSpin" class="is-active">Автовращение</button>
    <button id="m3dReset">Сброс</button>
  `;
  stageEl.innerHTML = '<canvas id="m3dCanvas" width="640" height="440" style="max-width:100%;max-height:100%;cursor:grab;"></canvas>';
  const canvas = stageEl.querySelector('#m3dCanvas');
  const ctx = canvas.getContext('2d');

  let yaw = 0.6, pitch = 0.35, dist = 4.2, wireframe = false, autoSpin = true, dragging = false, lx = 0, ly = 0;
  let rafId = 0;

  controlsEl.querySelector('#m3dWire').onclick = (e) => { wireframe = !wireframe; e.target.classList.toggle('is-active', wireframe); };
  controlsEl.querySelector('#m3dSpin').onclick = (e) => { autoSpin = !autoSpin; e.target.classList.toggle('is-active', autoSpin); };
  controlsEl.querySelector('#m3dReset').onclick = () => { yaw = 0.6; pitch = 0.35; dist = 4.2; };

  canvas.onmousedown = (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.style.cursor = 'grabbing'; };
  const onUp = () => { dragging = false; canvas.style.cursor = 'grab'; };
  const onMove = (e) => {
    if (!dragging) return;
    yaw += (e.clientX - lx) * 0.01;
    pitch = Math.max(-1.45, Math.min(1.45, pitch + (e.clientY - ly) * 0.01));
    lx = e.clientX; ly = e.clientY;
  };
  window.addEventListener('mouseup', onUp);
  window.addEventListener('mousemove', onMove);
  canvas.onwheel = (e) => { e.preventDefault(); dist = Math.max(1.6, Math.min(12, dist + e.deltaY * 0.003)); };

  const draw = () => {
    if (!document.body.contains(canvas)) {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove);
      return;
    }
    if (autoSpin && !dragging) yaw += 0.008;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0b101b';
    ctx.fillRect(0, 0, w, h);

    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const cpt = Math.cos(pitch), spt = Math.sin(pitch);
    const fov = 420;
    const proj = new Array(normVerts.length);
    const viewZ = new Array(normVerts.length);

    for (let i = 0; i < normVerts.length; i++) {
      const [vx, vy, vz] = normVerts[i];
      const x1 = vx * cyw - vz * syw;
      const z1 = vx * syw + vz * cyw;
      const y2 = vy * cpt - z1 * spt;
      const z2 = vy * spt + z1 * cpt + dist;
      viewZ[i] = z2;
      const s = fov / Math.max(0.2, z2);
      proj[i] = [w * 0.5 + x1 * s, h * 0.5 - y2 * s];
    }

    const tris = [];
    for (let i = 0; i < maxFaces.length; i++) {
      const [a, b, c] = maxFaces[i];
      if (!proj[a] || !proj[b] || !proj[c]) continue;
      const zAvg = (viewZ[a] + viewZ[b] + viewZ[c]) / 3;
      if (zAvg <= 0.25) continue;
      tris.push({ a, b, c, z: zAvg });
    }
    tris.sort((p, q) => q.z - p.z);

    for (const t of tris) {
      const [ax, ay] = proj[t.a], [bx, by] = proj[t.b], [cx2, cy2] = proj[t.c];
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx2, cy2); ctx.closePath();
      if (!wireframe) {
        const shade = Math.max(35, Math.min(220, Math.round(210 - (t.z - dist + 1.5) * 45)));
        ctx.fillStyle = `rgb(${Math.round(shade * 0.25)}, ${Math.round(shade * 0.72)}, ${shade})`;
        ctx.fill();
      }
      ctx.strokeStyle = wireframe ? '#38bdf8' : 'rgba(186,230,253,0.22)';
      ctx.lineWidth = wireframe ? 1 : 0.6;
      ctx.stroke();
    }
    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('mousemove', onMove);
  };
}


// === Built-in Pixel Art Editor ===
export function mountPixelEditor(hostEl, { state, fsBridge, refreshFromDisk, addLog, openFile }) {
  let size = 16;
  let tool = 'pen';
  let color = '#38bdf8';
  let gridOn = true;
  let drawing = false;
  let pixels = new Uint32Array(size * size);

  hostEl.innerHTML = `
    <div class="px-toolbar">
      <select id="pxSize">
        <option value="16" selected>16×16</option>
        <option value="32">32×32</option>
        <option value="64">64×64</option>
      </select>
      <input id="pxColor" type="color" value="#38bdf8" title="Цвет" />
      <button id="pxPen" class="primary">✏ Карандаш</button>
      <button id="pxEraser">🩹 Ластик</button>
      <button id="pxFill">🪣 Заливка</button>
      <button id="pxPick">💉 Пипетка</button>
      <button id="pxGrid" class="is-active">⊞ Сетка</button>
      <button id="pxClear">🗑 Очистить</button>
      <input id="pxFileName" type="text" value="assets/sprite.png" style="width:150px;" title="Путь для сохранения" />
      <button id="pxSave" class="primary">💾 Сохранить .png</button>
    </div>
    <div class="px-stage"><canvas id="pxCanvas"></canvas></div>
  `;

  const canvas = hostEl.querySelector('#pxCanvas');
  const ctx = canvas.getContext('2d');

  const hexToRgba = (hex) => {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  };
  const rgbaToHex = (val) => {
    const r = (val & 255).toString(16).padStart(2, '0');
    const g = ((val >> 8) & 255).toString(16).padStart(2, '0');
    const b = ((val >> 16) & 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  };

  const renderCanvas = () => {
    const cell = size <= 16 ? 22 : (size <= 32 ? 12 : 7);
    const pxW = size * cell;
    canvas.width = pxW;
    canvas.height = pxW;
    ctx.clearRect(0, 0, pxW, pxW);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = pixels[y * size + x];
        if (v) {
          ctx.fillStyle = rgbaToHex(v);
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    if (gridOn && cell >= 6) {
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= size; i++) {
        ctx.beginPath(); ctx.moveTo(i * cell + 0.5, 0); ctx.lineTo(i * cell + 0.5, pxW); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * cell + 0.5); ctx.lineTo(pxW, i * cell + 0.5); ctx.stroke();
      }
    }
  };

  const floodFill = (sx, sy, targetCol, replCol) => {
    if (targetCol === replCol) return;
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const idx = y * size + x;
      if (pixels[idx] !== targetCol) continue;
      pixels[idx] = replCol;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  };

  const applyAtEvent = (e, isClick = false) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * size);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * size);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const idx = y * size + x;
    if (tool === 'pick') {
      const v = pixels[idx];
      if (v) {
        color = rgbaToHex(v);
        hostEl.querySelector('#pxColor').value = color;
      }
      return;
    }
    if (tool === 'fill') {
      if (isClick) floodFill(x, y, pixels[idx], hexToRgba(color));
    } else if (tool === 'eraser') {
      pixels[idx] = 0;
    } else {
      pixels[idx] = hexToRgba(color);
    }
    renderCanvas();
  };

  canvas.onmousedown = (e) => { drawing = true; applyAtEvent(e, true); };
  canvas.onmousemove = (e) => { if (drawing) applyAtEvent(e, false); };
  window.addEventListener('mouseup', () => { drawing = false; });

  const setTool = (t, btnId) => {
    tool = t;
    ['#pxPen', '#pxEraser', '#pxFill', '#pxPick'].forEach(id => hostEl.querySelector(id)?.classList.remove('primary'));
    hostEl.querySelector(btnId)?.classList.add('primary');
  };
  hostEl.querySelector('#pxPen').onclick = () => setTool('pen', '#pxPen');
  hostEl.querySelector('#pxEraser').onclick = () => setTool('eraser', '#pxEraser');
  hostEl.querySelector('#pxFill').onclick = () => setTool('fill', '#pxFill');
  hostEl.querySelector('#pxPick').onclick = () => setTool('pick', '#pxPick');
  hostEl.querySelector('#pxColor').oninput = (e) => { color = e.target.value; };
  hostEl.querySelector('#pxGrid').onclick = (e) => { gridOn = !gridOn; e.target.classList.toggle('is-active', gridOn); renderCanvas(); };
  hostEl.querySelector('#pxClear').onclick = () => { pixels.fill(0); renderCanvas(); };
  hostEl.querySelector('#pxSize').onchange = (e) => {
    size = Number(e.target.value) || 16;
    pixels = new Uint32Array(size * size);
    renderCanvas();
  };
  hostEl.querySelector('#pxSave').onclick = async () => {
    const outCanvas = document.createElement('canvas');
    outCanvas.width = size;
    outCanvas.height = size;
    const octx = outCanvas.getContext('2d');
    const imgData = octx.createImageData(size, size);
    for (let i = 0; i < pixels.length; i++) {
      const v = pixels[i];
      if (!v) continue;
      imgData.data[i * 4] = v & 255;
      imgData.data[i * 4 + 1] = (v >> 8) & 255;
      imgData.data[i * 4 + 2] = (v >> 16) & 255;
      imgData.data[i * 4 + 3] = 255;
    }
    octx.putImageData(imgData, 0, 0);
    const dataUrl = outCanvas.toDataURL('image/png');
    const b64 = dataUrl.split(',')[1];
    const rel = (hostEl.querySelector('#pxFileName').value || 'assets/sprite.png').trim().replace(/^\/+/, '');
    if (state.rootPath && typeof fsBridge.writeFileBase64 === 'function') {
      await fsBridge.writeFileBase64(rel, b64);
      await refreshFromDisk();
    } else {
      state.assetBase64[rel] = b64;
      state.assetUrls[rel] = dataUrl;
      if (!state.allFiles.includes(rel)) state.allFiles.push(rel);
      state.allFiles.sort();
    }
    addLog(`Пиксель-арт сохранён: ${rel} (${size}×${size})`, 'info');
    if (openFile) openFile(rel);
  };

  renderCanvas();
}

// ─── .royui Visual Designer (Roblox Studio-style) ────────────────────────────
export function mountRoyUiDesigner(hostEl, { state, fsBridge, refreshFromDisk, addLog, openFile }) {
  const snap8 = (v) => Math.round(v / 8) * 8;
  const defaults = {
    Panel:       { tag: 'Panel', w: 260, h: 180, bg: '#1e2433', color: '#ffffff', text: '', fontSize: 14, radius: 8, onClick: '' },
    Button:      { tag: 'Button', w: 144, h: 40, bg: '#007acc', color: '#ffffff', text: 'Нажми меня', fontSize: 14, radius: 6, onClick: 'onBtnClick' },
    Text:        { tag: 'Text', w: 184, h: 32, bg: 'transparent', color: '#e6edf3', text: 'Заголовок UI', fontSize: 18, radius: 0, onClick: '' },
    Input:       { tag: 'Input', w: 200, h: 36, bg: '#0d1117', color: '#c9d1d9', text: 'Введите текст...', fontSize: 13, radius: 5, onClick: '' },
    ProgressBar: { tag: 'ProgressBar', w: 200, h: 24, bg: '#238636', color: '#ffffff', text: '75%', fontSize: 12, radius: 6, onClick: '' },
    Image:       { tag: 'Image', w: 96, h: 96, bg: '#2d333b', color: '#8b949e', text: '🖼 sprite.png', fontSize: 12, radius: 6, onClick: '' },
    Toggle:      { tag: 'Toggle', w: 136, h: 32, bg: '#21262d', color: '#e6edf3', text: '☑ Вкл.', fontSize: 13, radius: 6, onClick: 'onToggle' },
  };

  let nextIdx = 4;
  let items = [
    { id: 'panel_main', tag: 'Panel', x: 40, y: 32, w: 280, h: 200, bg: '#1e2433', color: '#ffffff', text: '', fontSize: 14, radius: 8, onClick: '' },
    { id: 'lbl_title', tag: 'Text', x: 64, y: 48, w: 232, h: 32, bg: 'transparent', color: '#ffffff', text: 'Меню игры', fontSize: 18, radius: 0, onClick: '' },
    { id: 'btn_play', tag: 'Button', x: 64, y: 104, w: 232, h: 40, bg: '#007acc', color: '#ffffff', text: 'Играть', fontSize: 14, radius: 6, onClick: 'startGame' },
  ];
  let selectedId = 'btn_play';

  hostEl.innerHTML = `
    <div class="px-toolbar">
      <input id="uidFile" type="text" value="ui/hud.royui" style="width:160px" />
      <button id="uidLoad" class="bc-btn">📂 Загрузить</button>
      <button id="uidSave" class="bc-btn">💾 Сохранить .royui</button>
      <button id="uidCopyCode" class="bc-btn">📋 Код renderRoyUI</button>
      <button id="uidClear" class="bc-btn">🧹 Очистить</button>
    </div>
    <div class="uid-wrap">
      <div class="uid-palette">
        <div class="uid-sec-title">Элементы UI</div>
        ${Object.keys(defaults).map(t => `<button class="uid-pal-btn" data-tag="${t}">+ ${t}</button>`).join('')}
      </div>
      <div class="uid-canvas-wrap">
        <div id="uidCanvas" class="uid-canvas"></div>
      </div>
      <div id="uidInspector" class="uid-inspector"></div>
    </div>`;

  const canvasEl = hostEl.querySelector('#uidCanvas');
  const inspEl = hostEl.querySelector('#uidInspector');
  const fileIn = hostEl.querySelector('#uidFile');

  const toRoyUI = () => items.map(it => {
    const props = [
      `id="${it.id}"`, `x=${it.x}`, `y=${it.y}`, `w=${it.w}`, `h=${it.h}`,
      `bg="${it.bg}"`, `color="${it.color}"`, `fontSize=${it.fontSize}`, `radius=${it.radius}`,
    ];
    if (it.text) props.push(`text="${it.text.replace(/"/g, '\\"')}"`);
    if (it.onClick) props.push(`onClick="${it.onClick}"`);
    return `${it.tag}(${props.join(', ')})`;
  }).join('\n');

  const parseRoyUIText = (src) => {
    const out = [];
    const lines = String(src || '').split(/\r?\n/);
    let idx = 1;
    for (const raw of lines) {
      const m = raw.trim().match(/^([A-Za-z_]\w*)\((.*)\)\s*$/);
      if (!m) continue;
      const tag = m[1];
      const body = m[2];
      const getStr = (k, def = '') => {
        const km = body.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`));
        return km ? km[1] : def;
      };
      const getNum = (k, def = 0) => {
        const km = body.match(new RegExp(`${k}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`));
        return km ? Number(km[1]) : def;
      };
      out.push({
        id: getStr('id', `${tag.toLowerCase()}_${idx++}`),
        tag,
        x: getNum('x', 24), y: getNum('y', 24),
        w: Math.max(24, getNum('w', 120)), h: Math.max(20, getNum('h', 36)),
        bg: getStr('bg', '#1e2433'), color: getStr('color', '#ffffff'),
        text: getStr('text', ''), fontSize: getNum('fontSize', 14),
        radius: getNum('radius', 4), onClick: getStr('onClick', ''),
      });
    }
    return out;
  };

  let dragState = null;

  const renderCanvas = () => {
    canvasEl.innerHTML = '';
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'uid-item' + (it.id === selectedId ? ' selected' : '');
      div.style.left = `${it.x}px`;
      div.style.top = `${it.y}px`;
      div.style.width = `${it.w}px`;
      div.style.height = `${it.h}px`;
      div.style.background = it.bg;
      div.style.color = it.color;
      div.style.fontSize = `${it.fontSize}px`;
      div.style.borderRadius = `${it.radius}px`;
      div.textContent = it.text || (it.tag === 'Panel' ? '' : it.tag);
      const handle = document.createElement('div');
      handle.className = 'uid-handle';
      div.appendChild(handle);

      div.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        selectedId = it.id;
        const isResize = e.target === handle;
        dragState = {
          item: it,
          mode: isResize ? 'resize' : 'move',
          startX: e.clientX, startY: e.clientY,
          origX: it.x, origY: it.y, origW: it.w, origH: it.h,
        };
        renderCanvas();
        renderInspector();
      });
      canvasEl.appendChild(div);
    }
  };

  const renderInspector = () => {
    const it = items.find(x => x.id === selectedId);
    if (!it) {
      inspEl.innerHTML = `<div class="uid-sec-title">Инспектор</div><div style="font-size:12px;color:var(--muted)">Выберите элемент на холсте или добавьте из палитры слева.</div>`;
      return;
    }
    inspEl.innerHTML = `
      <div class="uid-sec-title">Свойства · ${it.tag}</div>
      <label class="uid-field">ID<input data-k="id" value="${it.id}" /></label>
      <label class="uid-field">Текст<input data-k="text" value="${it.text.replace(/"/g, '&quot;')}" /></label>
      <div class="uid-field-row">
        <label class="uid-field">X<input data-k="x" type="number" value="${it.x}" /></label>
        <label class="uid-field">Y<input data-k="y" type="number" value="${it.y}" /></label>
      </div>
      <div class="uid-field-row">
        <label class="uid-field">W<input data-k="w" type="number" value="${it.w}" /></label>
        <label class="uid-field">H<input data-k="h" type="number" value="${it.h}" /></label>
      </div>
      <div class="uid-field-row">
        <label class="uid-field">Фон<input data-k="bg" value="${it.bg}" /></label>
        <label class="uid-field">Цвет<input data-k="color" value="${it.color}" /></label>
      </div>
      <div class="uid-field-row">
        <label class="uid-field">Шрифт<input data-k="fontSize" type="number" value="${it.fontSize}" /></label>
        <label class="uid-field">Радиус<input data-k="radius" type="number" value="${it.radius}" /></label>
      </div>
      <label class="uid-field">onClick<input data-k="onClick" value="${it.onClick}" /></label>
      <div class="uid-ins-actions">
        <button id="uidDup">📄 Копия</button>
        <button id="uidDel">🗑 Удалить</button>
      </div>`;

    inspEl.querySelectorAll('input[data-k]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.k;
        it[k] = inp.type === 'number' ? Number(inp.value || 0) : inp.value;
        if (k === 'id') selectedId = it.id;
        renderCanvas();
      });
    });
    inspEl.querySelector('#uidDup')?.addEventListener('click', () => {
      const copy = { ...it, id: `${it.tag.toLowerCase()}_${nextIdx++}`, x: it.x + 16, y: it.y + 16 };
      items.push(copy);
      selectedId = copy.id;
      renderCanvas();
      renderInspector();
    });
    inspEl.querySelector('#uidDel')?.addEventListener('click', () => {
      items = items.filter(x => x.id !== it.id);
      selectedId = items[0]?.id || null;
      renderCanvas();
      renderInspector();
    });
  };

  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const it = dragState.item;
    if (dragState.mode === 'move') {
      it.x = Math.max(0, snap8(dragState.origX + dx));
      it.y = Math.max(0, snap8(dragState.origY + dy));
    } else {
      it.w = Math.max(24, snap8(dragState.origW + dx));
      it.h = Math.max(20, snap8(dragState.origH + dy));
    }
    renderCanvas();
    renderInspector();
  });
  window.addEventListener('mouseup', () => { dragState = null; });
  canvasEl.addEventListener('mousedown', () => { selectedId = null; renderCanvas(); renderInspector(); });

  hostEl.querySelectorAll('.uid-pal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tpl = defaults[btn.dataset.tag];
      const item = { ...tpl, id: `${tpl.tag.toLowerCase()}_${nextIdx++}`, x: 48, y: 48 };
      items.push(item);
      selectedId = item.id;
      renderCanvas();
      renderInspector();
    });
  });

  hostEl.querySelector('#uidClear')?.addEventListener('click', () => {
    items = []; selectedId = null; renderCanvas(); renderInspector();
  });

  hostEl.querySelector('#uidLoad')?.addEventListener('click', async () => {
    const rel = fileIn.value.trim() || 'ui/hud.royui';
    const txt = state.textFiles[rel] || '';
    if (!txt) { addLog(`Файл ${rel} не найден или пуст`, 'warn'); return; }
    const parsed = parseRoyUIText(txt);
    if (parsed.length) {
      items = parsed;
      selectedId = items[0].id;
      renderCanvas();
      renderInspector();
      addLog(`Загружено элементов UI: ${items.length} из ${rel}`, 'ok');
    }
  });

  hostEl.querySelector('#uidSave')?.addEventListener('click', async () => {
    const rel = fileIn.value.trim() || 'ui/hud.royui';
    const content = toRoyUI();
    if (fsBridge.getMode() !== 'demo' && !state.isDemo) {
      await fsBridge.writeFile(rel, content);
      await refreshFromDisk();
    } else {
      state.textFiles[rel] = content;
    }
    addLog(`Сохранено .royui: ${rel} (${items.length} эл.)`, 'ok');
    if (openFile) openFile(rel);
  });

  hostEl.querySelector('#uidCopyCode')?.addEventListener('click', async () => {
    const code = `let uiLayout = parseRoyUI("""\n${toRoyUI()}\n""")\nfunction drawUI() {\n  renderRoyUI(uiLayout)\n}`;
    try { await navigator.clipboard.writeText(code); addLog('Код renderRoyUI скопирован в буфер обмена', 'ok'); } catch {}
  });

  renderCanvas();
  renderInspector();
}

// ─── Cutscene Timeline & Dialog Graph Editor ────────────────────────────────
export function mountCutsceneGraphEditor(hostEl, { state, fsBridge, refreshFromDisk, addLog, openFile }) {
  let mode = 'timeline'; // 'timeline' | 'graph'
  let currentTime = 0;
  let playing = false;
  let rafId = 0;
  const maxTime = 10.0;

  let keyframes = [
    { id: 'kf1', track: 'Camera', time: 0.5, action: 'panTo', target: 'hero', value: 'x=200, zoom=1.2' },
    { id: 'kf2', track: 'Actor', time: 1.8, action: 'playAnim', target: 'hero', value: 'wave' },
    { id: 'kf3', track: 'Dialog / LipSync', time: 2.5, action: 'say', target: 'hero', value: 'Привет, мир!' },
    { id: 'kf4', track: 'Audio / SFX', time: 2.5, action: 'playSfx', target: 'sfx_chime', value: '0.8' },
  ];
  let selectedKfId = 'kf1';

  let nodes = [
    { id: 'start', speaker: 'Капитан', text: 'Добро пожаловать на борт!', lipSync: 'happy', next: 'choice_1', x: 40, y: 48 },
    { id: 'choice_1', speaker: 'Игрок', text: 'Готов к вылету!', lipSync: 'talk', next: 'end', x: 280, y: 140 },
    { id: 'end', speaker: 'Капитан', text: 'Тогда запускаем двигатели!', lipSync: 'excited', next: '', x: 520, y: 60 },
  ];
  let selectedNodeId = 'start';

  hostEl.innerHTML = `
    <div class="px-toolbar">
      <button id="csModeTimeline" class="bc-btn">⏱ Таймлайн</button>
      <button id="csModeGraph" class="bc-btn">💬 Граф диалогов</button>
      <input id="csFile" type="text" value="cutscenes/intro.royanim" style="width:180px" />
      <button id="csSave" class="bc-btn">💾 Сохранить</button>
      <button id="csCopy" class="bc-btn">📋 Код RoyLang</button>
    </div>
    <div class="cs-wrap">
      <div class="cs-body">
        <div id="csStage" class="cs-stage"></div>
        <div id="csInspector" class="uid-inspector"></div>
      </div>
    </div>`;

  const stageEl = hostEl.querySelector('#csStage');
  const inspEl = hostEl.querySelector('#csInspector');
  const fileIn = hostEl.querySelector('#csFile');

  const tracks = ['Camera', 'Actor', 'Dialog / LipSync', 'Audio / SFX'];

  const render = () => {
    if (mode === 'timeline') renderTimeline();
    else renderGraph();
    renderInspector();
  };

  const renderTimeline = () => {
    stageEl.innerHTML = `
      <div class="cs-scrubber-row">
        <button id="csPlayBtn" class="bc-btn">${playing ? '⏸ Пауза' : '▶ Play'}</button>
        <input id="csScrub" type="range" min="0" max="${maxTime}" step="0.1" value="${currentTime.toFixed(1)}" />
        <span id="csTimeLbl">${currentTime.toFixed(1)}s / ${maxTime.toFixed(1)}s</span>
      </div>
      <div class="cs-tracks">
        ${tracks.map(tr => `
          <div class="cs-track">
            <div class="cs-track-lbl">${tr}</div>
            <div class="cs-track-lane" data-track="${tr}">
              <div class="cs-playhead" style="left:${(currentTime / maxTime) * 100}%"></div>
            </div>
          </div>`).join('')}
      </div>
      <div style="font-size:11px;color:var(--muted)">Клик по дорожке добавляет ключевой кадр. Перетаскивайте маркеры по времени.</div>`;

    stageEl.querySelector('#csPlayBtn')?.addEventListener('click', () => {
      playing = !playing;
      if (playing) {
        let last = performance.now();
        const tick = (now) => {
          if (!playing) return;
          const dt = (now - last) / 1000;
          last = now;
          currentTime += dt;
          if (currentTime > maxTime) currentTime = 0;
          const scrub = stageEl.querySelector('#csScrub');
          const lbl = stageEl.querySelector('#csTimeLbl');
          if (scrub) scrub.value = currentTime.toFixed(1);
          if (lbl) lbl.textContent = `${currentTime.toFixed(1)}s / ${maxTime.toFixed(1)}s`;
          stageEl.querySelectorAll('.cs-playhead').forEach(ph => { ph.style.left = `${(currentTime / maxTime) * 100}%`; });
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(rafId);
      }
      renderTimeline();
    });

    stageEl.querySelector('#csScrub')?.addEventListener('input', (e) => {
      currentTime = Number(e.target.value);
      const lbl = stageEl.querySelector('#csTimeLbl');
      if (lbl) lbl.textContent = `${currentTime.toFixed(1)}s / ${maxTime.toFixed(1)}s`;
      stageEl.querySelectorAll('.cs-playhead').forEach(ph => { ph.style.left = `${(currentTime / maxTime) * 100}%`; });
    });

    stageEl.querySelectorAll('.cs-track-lane').forEach(lane => {
      const tr = lane.dataset.track;
      keyframes.filter(k => k.track === tr).forEach(kf => {
        const dot = document.createElement('div');
        dot.className = 'cs-kf' + (kf.id === selectedKfId ? ' selected' : '');
        dot.style.left = `${(kf.time / maxTime) * 100}%`;
        dot.title = `${kf.time.toFixed(1)}s · ${kf.action}(${kf.target})`;
        dot.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          selectedKfId = kf.id;
          renderInspector();
          const rect = lane.getBoundingClientRect();
          const onMove = (ev) => {
            const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
            kf.time = Math.round(pct * maxTime * 10) / 10;
            dot.style.left = `${(kf.time / maxTime) * 100}%`;
            renderInspector();
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
        lane.appendChild(dot);
      });

      lane.addEventListener('mousedown', (e) => {
        if (e.target !== lane) return;
        const rect = lane.getBoundingClientRect();
        const t = Math.round(((e.clientX - rect.left) / rect.width) * maxTime * 10) / 10;
        const kf = { id: `kf_${Date.now().toString(36)}`, track: tr, time: t, action: 'trigger', target: 'actor', value: '' };
        keyframes.push(kf);
        selectedKfId = kf.id;
        render();
      });
    });
  };

  const renderGraph = () => {
    stageEl.innerHTML = `
      <div class="cs-scrubber-row">
        <button id="csAddNode" class="bc-btn">+ Узел диалога</button>
        <span style="font-size:11.5px;color:var(--muted)">Перетаскивайте карточки, задавайте next в инспекторе справа</span>
      </div>
      <div id="csGraph" class="cs-graph"><svg id="csSvg"></svg></div>`;
    const graphEl = stageEl.querySelector('#csGraph');
    const svgEl = stageEl.querySelector('#csSvg');

    const drawEdges = () => {
      svgEl.innerHTML = '';
      for (const n of nodes) {
        if (!n.next) continue;
        const targets = n.next.split(',').map(s => s.trim()).filter(Boolean);
        for (const tid of targets) {
          const t = nodes.find(x => x.id === tid);
          if (!t) continue;
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', n.x + 190);
          line.setAttribute('y1', n.y + 34);
          line.setAttribute('x2', t.x);
          line.setAttribute('y2', t.y + 34);
          line.setAttribute('stroke', '#3794ff');
          line.setAttribute('stroke-width', '2');
          svgEl.appendChild(line);
        }
      }
    };

    for (const n of nodes) {
      const card = document.createElement('div');
      card.className = 'cs-node' + (n.id === selectedNodeId ? ' selected' : '');
      card.style.left = `${n.x}px`;
      card.style.top = `${n.y}px`;
      card.innerHTML = `
        <div class="cs-node-head"><span>${n.id}</span><span>${n.speaker}</span></div>
        <div class="cs-node-text">${n.text}</div>
        <div class="cs-node-next">→ ${n.next || 'конец'}</div>`;
      card.addEventListener('mousedown', (e) => {
        selectedNodeId = n.id;
        renderInspector();
        const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
        const onMove = (ev) => {
          n.x = Math.max(0, ox + (ev.clientX - sx));
          n.y = Math.max(0, oy + (ev.clientY - sy));
          card.style.left = `${n.x}px`;
          card.style.top = `${n.y}px`;
          drawEdges();
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
      graphEl.appendChild(card);
    }
    drawEdges();

    stageEl.querySelector('#csAddNode')?.addEventListener('click', () => {
      const id = `node_${nodes.length + 1}`;
      nodes.push({ id, speaker: 'NPC', text: 'Новая реплика...', lipSync: 'talk', next: '', x: 120 + (nodes.length * 30) % 300, y: 120 });
      selectedNodeId = id;
      render();
    });
  };

  const renderInspector = () => {
    if (mode === 'timeline') {
      const kf = keyframes.find(k => k.id === selectedKfId);
      if (!kf) { inspEl.innerHTML = `<div class="uid-sec-title">Ключевой кадр</div><div style="font-size:12px;color:var(--muted)">Выберите ключ на таймлайне.</div>`; return; }
      inspEl.innerHTML = `
        <div class="uid-sec-title">Ключ · ${kf.track}</div>
        <label class="uid-field">Время (сек)<input data-k="time" type="number" step="0.1" value="${kf.time}" /></label>
        <label class="uid-field">Действие<input data-k="action" value="${kf.action}" /></label>
        <label class="uid-field">Цель (target)<input data-k="target" value="${kf.target}" /></label>
        <label class="uid-field">Параметр<input data-k="value" value="${kf.value}" /></label>
        <div class="uid-ins-actions"><button id="csDelKf">🗑 Удалить ключ</button></div>`;
      inspEl.querySelectorAll('input[data-k]').forEach(inp => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.k;
          kf[k] = inp.type === 'number' ? Number(inp.value || 0) : inp.value;
          renderTimeline();
        });
      });
      inspEl.querySelector('#csDelKf')?.addEventListener('click', () => {
        keyframes = keyframes.filter(x => x.id !== kf.id);
        selectedKfId = keyframes[0]?.id || null;
        render();
      });
    } else {
      const n = nodes.find(x => x.id === selectedNodeId);
      if (!n) { inspEl.innerHTML = `<div class="uid-sec-title">Узел диалога</div><div style="font-size:12px;color:var(--muted)">Выберите узел на графе.</div>`; return; }
      inspEl.innerHTML = `
        <div class="uid-sec-title">Узел · ${n.id}</div>
        <label class="uid-field">ID узла<input data-k="id" value="${n.id}" /></label>
        <label class="uid-field">Спикер<input data-k="speaker" value="${n.speaker}" /></label>
        <label class="uid-field">Реплика<input data-k="text" value="${n.text.replace(/"/g, '&quot;')}" /></label>
        <label class="uid-field">LipSync эмоция<input data-k="lipSync" value="${n.lipSync}" /></label>
        <label class="uid-field">Следующий ID (next)<input data-k="next" value="${n.next}" /></label>
        <div class="uid-ins-actions"><button id="csDelNode">🗑 Удалить узел</button></div>`;
      inspEl.querySelectorAll('input[data-k]').forEach(inp => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.k;
          n[k] = inp.value;
          if (k === 'id') selectedNodeId = n.id;
          renderGraph();
        });
      });
      inspEl.querySelector('#csDelNode')?.addEventListener('click', () => {
        nodes = nodes.filter(x => x.id !== n.id);
        selectedNodeId = nodes[0]?.id || null;
        render();
      });
    }
  };

  const toRoyLangCode = () => {
    const tl = keyframes.slice().sort((a, b) => a.time - b.time).map(k =>
      `  { time: ${k.time}, track: "${k.track}", action: "${k.action}", target: "${k.target}", value: "${k.value}" }`
    ).join(',\n');
    const dlg = nodes.map(n =>
      `  ${n.id}: { speaker: "${n.speaker}", text: "${n.text}", lipSync: "${n.lipSync}", next: "${n.next}" }`
    ).join(',\n');
    return `let cutscene = directorTimeline([\n${tl}\n])\n\nlet dialogGraph = {\n${dlg}\n}\n\n// Запуск липсинка для текущего узла:\n// lipSync(dialogGraph.start.text, dialogGraph.start.lipSync)`;
  };

  hostEl.querySelector('#csModeTimeline')?.addEventListener('click', () => { mode = 'timeline'; render(); });
  hostEl.querySelector('#csModeGraph')?.addEventListener('click', () => { mode = 'graph'; playing = false; cancelAnimationFrame(rafId); render(); });
  hostEl.querySelector('#csSave')?.addEventListener('click', async () => {
    const rel = fileIn.value.trim() || 'cutscenes/intro.royanim';
    const json = JSON.stringify({ keyframes, nodes }, null, 2);
    if (fsBridge.getMode() !== 'demo' && !state.isDemo) {
      await fsBridge.writeFile(rel, json);
      await refreshFromDisk();
    } else {
      state.textFiles[rel] = json;
    }
    addLog(`Сохранена катсцена: ${rel}`, 'ok');
    if (openFile) openFile(rel);
  });
  hostEl.querySelector('#csCopy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toRoyLangCode()); addLog('Код directorTimeline + dialogGraph скопирован', 'ok'); } catch {}
  });

  render();
}
