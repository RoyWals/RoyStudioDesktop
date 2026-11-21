import {
  RoyLang,
  getEngineState,
  onEngineChange,
  loadEngineFromBundle,
  resetToBuiltin,
  compareSemver,
  sortSemverDesc
} from './core/engine-manager.js';
import { createFsBridge, isTauriEnv, isTextFile, isImageFile, isMediaFile, getExt } from './fs-bridge.js';
import { createRoyEditor, createSecondaryEditor, detectMonacoLang, updateRoyLanguageMeta, updateRoyAnalysis } from './editor/monaco-roy.js';
import { sendStudioCmd, renderImageGridOverlay, packFolderToSpriteAtlas, PROJECT_TEMPLATES } from './studio-extras.js';

const fsBridge = createFsBridge();

const state = {
  projectName: 'Демо-проект',
  rootPath: null,
  allFiles: [],
  allDirs: [],
  textFiles: {},
  assetUrls: {},
  assetBase64: {},
  dirty: new Set(),
  collapsedDirs: new Set(),
  openTabs: [],
  activeFile: null,
  entryFile: 'main.roy',
  diagnostics: [],
  logs: [],
  activeView: 'explorer',
  inlineEdit: null,
  autoSave: false,
  tabHistory: [],
  tabHistoryIdx: -1,
  diagIdx: -1
};

const RECENT_KEY = 'roystudio.recent.v1';
function readRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
function saveRecent(items) { localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, 12))); renderRecent(); }
function rememberRecent(proj, file = null) {
  if (!proj?.rootPath) return;
  const items = readRecent().filter(x => x.rootPath !== proj.rootPath || (file && x.file !== file));
  items.unshift({ rootPath: proj.rootPath, name: proj.name, file: file || null, at: Date.now() });
  saveRecent(items);
}
function renderRecent() {
  const box = el('recentProjects'); if (!box) return;
  const items = readRecent();
  box.innerHTML = items.length ? items.map((x, i) => `<button class="recent-item" data-recent="${i}" title="${escapeHtml(x.rootPath)}"><span>◷</span><span><b>${escapeHtml(x.name || x.rootPath)}</b><small>${escapeHtml(x.file || x.rootPath)}</small></span></button>`).join('') : '<div class="muted pad-msg">Недавних проектов нет</div>';
  box.querySelectorAll('.recent-item').forEach(b => b.addEventListener('click', async () => {
    const x = readRecent()[Number(b.dataset.recent)];
    try { const p = await fsBridge.openFolderPath(x.rootPath); if (p) { loadProjectState(p); if (x.file && state.textFiles[x.file]) openFile(x.file); } }
    catch (err) { addLog(`Не удалось открыть недавний проект: ${err.message || err}`, 'err'); }
  }));
}

const el = id => document.getElementById(id);
let editor = null;
let diagTimer = null;
let autoSaveTimer = null;

function installDropHandlers() {
  const editorDrop = el('editorHost');
  const treeDrop = el('fileTree');
  const mark = (node, on) => node?.classList.toggle('drop-target', on);
  const pathsFromDataTransfer = (dt) => [...(dt?.files || [])];
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };

  if (editorDrop) {
    editorDrop.addEventListener('dragover', e => { prevent(e); mark(editorDrop, true); });
    editorDrop.addEventListener('dragleave', e => { if (!editorDrop.contains(e.relatedTarget)) mark(editorDrop, false); });
    editorDrop.addEventListener('drop', async e => {
      prevent(e); mark(editorDrop, false);
      const targetFile = state.activeFile;
      const files = pathsFromDataTransfer(e.dataTransfer);
      for (const file of files) {
        try {
          const item = isTauriEnv() && file.path
            ? await fsBridge.openExternalFile(file.path)
            : await fsBridge.importDroppedFile(file);
          const p = item.path;
          state.allFiles = [...new Set([...state.allFiles, p])].sort();
          if (item.text != null) state.textFiles[p] = item.text;
          if (item.assetUrl) state.assetUrls[p] = item.assetUrl;
          if (item.base64) state.assetBase64[p] = item.base64;
          if (overEditor && isMediaFile(p) && targetFile && state.textFiles[targetFile] != null) {
            openFile(targetFile);
            editor?.insertText(JSON.stringify(p));
          } else openFile(p);
        } catch (err) { addLog(`Не удалось открыть файл: ${err.message || err}`, 'err'); }
      }
      renderTree();
    });
  }
  if (treeDrop) {
    treeDrop.addEventListener('dragover', e => { prevent(e); mark(treeDrop, true); });
    treeDrop.addEventListener('dragleave', e => { if (!treeDrop.contains(e.relatedTarget)) mark(treeDrop, false); });
    treeDrop.addEventListener('drop', async e => {
      prevent(e); mark(treeDrop, false);
      const files = pathsFromDataTransfer(e.dataTransfer);
      const target = e.target.closest?.('.tree-folder')?.dataset.dir || '';
      const treeRect = treeDrop.getBoundingClientRect();
      const treePoint = e.clientX >= treeRect.left && e.clientX <= treeRect.right && e.clientY >= treeRect.top && e.clientY <= treeRect.bottom;
      for (const file of files) {
        try {
          const item = treePoint
            ? await fsBridge.importDroppedFile(file, target ? `${target}/${file.name}` : file.name)
            : (isTauriEnv() && file.path ? await fsBridge.openExternalFile(file.path) : await fsBridge.importDroppedFile(file));
          const p = item.path;
          state.allFiles = [...new Set([...state.allFiles, p])].sort();
          if (item.text != null) state.textFiles[p] = item.text;
          if (item.assetUrl) state.assetUrls[p] = item.assetUrl;
          if (item.base64) state.assetBase64[p] = item.base64;
          openFile(p);
          addLog(treePoint ? `Файл добавлен в проект: ${p}` : `Открыт файл: ${p}`, 'info');
        } catch (err) { addLog(`Не удалось добавить файл: ${err.message || err}`, 'err'); }
      }
      renderTree();
    });
  }
  // Tauri intercepts native Windows drops before Chromium exposes File.path.
  // Consume its paths too, so dragging from Explorer works in the desktop build.
  fsBridge.onTauriEvent('tauri://drag-drop', async payload => {
    const paths = Array.isArray(payload?.paths) ? payload.paths : [];
    const point = payload?.position;
    const overEditor = point && editorDrop?.getBoundingClientRect && (() => {
      const r = editorDrop.getBoundingClientRect();
      return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
    })();
    const targetFile = state.activeFile;
    const overTree = point && treeDrop?.getBoundingClientRect && (() => {
      const r = treeDrop.getBoundingClientRect();
      return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
    })();
    for (const filePath of paths) {
      try {
        if (overTree) {
          const item = await fsBridge.openExternalFile(filePath);
          const p = item.path;
          if (state.rootPath) await fsBridge.copyExternalFile(filePath, p);
          else throw new Error('Сначала открой папку проекта, чтобы добавить в неё файл');
          state.allFiles = [...new Set([...state.allFiles, p])].sort();
          if (item.text != null) state.textFiles[p] = item.text;
          if (item.assetUrl) state.assetUrls[p] = item.assetUrl;
          if (isMediaFile(p)) {
            state.assetBase64[p] = item.base64;
            openFile(p);
          } else openFile(p);
        } else {
          const item = await fsBridge.openExternalFile(filePath);
          const p = item.path;
          state.allFiles = [...new Set([...state.allFiles, p])].sort();
          if (item.text != null) state.textFiles[p] = item.text;
          if (item.assetUrl) state.assetUrls[p] = item.assetUrl;
          if (isMediaFile(p) && targetFile && state.textFiles[targetFile] != null) {
            openFile(targetFile);
            editor?.insertText(JSON.stringify(p));
          } else openFile(p);
        }
      } catch (err) { addLog(`Не удалось обработать перетащенный файл: ${err.message || err}`, 'err'); }
    }
    renderTree();
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const FOLDER_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" fill="#dcb67a"><path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.1l1.4 1.5H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3z"/></svg>`;

function getFileIconSvg(path) {
  const ext = getExt(path);
  if (ext === 'roy' || ext === 'roylang') {
    // Фирменная иконка RoyLang: кристалл-корона с буквой R
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#e879f9"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#rg)" stroke-width="1.3"/>
      <path d="M5.5 11.5V5h3.1c1.2 0 1.9.6 1.9 1.6 0 .8-.4 1.3-1.1 1.5l1.3 3.4H9.3L8.2 8.4H6.8v3.1H5.5zm1.3-4.2h1.6c.5 0 .8-.2.8-.7s-.3-.6-.8-.6H6.8v1.3z" fill="url(#rg)"/>
    </svg>`;
  }
  if (ext === 'royproj') {
    // Манифест проекта .royproj: кристалл-корона с буквой P (в стиле .roy)
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="rpg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#fb923c"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#rpg)" stroke-width="1.3"/>
      <path d="M5.6 11.5V5h3.0c1.3 0 2.0.7 2.0 1.8s-.7 1.9-2.0 1.9H6.9v2.8H5.6zm1.3-4h1.5c.6 0 .9-.3.9-.7s-.3-.7-.9-.7H6.9v1.4z" fill="url(#rpg)"/>
    </svg>`;
  }
  if (ext === 'royson') {
    // Данные .royson: кристалл-корона со знаком {} (в стиле .roy)
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="rsg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#rsg)" stroke-width="1.3"/>
      <path d="M6.9 5.3c-.9 0-1.3.4-1.3 1.2v1.1c0 .5-.3.8-.8.9v.1c.5.1.8.4.8.9v1.1c0 .8.4 1.2 1.3 1.2" fill="none" stroke="url(#rsg)" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9.1 5.3c.9 0 1.3.4 1.3 1.2v1.1c0 .5.3.8.8.9v.1c-.5.1-.8.4-.8.9v1.1c0 .8-.4 1.2-1.3 1.2" fill="none" stroke="url(#rsg)" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (ext === 'royscene') {
    // Сцена .royscene: кристалл с S
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="rsce" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#rsce)" stroke-width="1.3"/>
      <text x="8" y="11.2" text-anchor="middle" font-size="7.8" font-weight="800" fill="url(#rsce)" font-family="sans-serif">S</text>
    </svg>`;
  }
  if (ext === 'royprefab') {
    // Префаб .royprefab: кристалл с E
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="rpref" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#rpref)" stroke-width="1.3"/>
      <text x="8" y="11.2" text-anchor="middle" font-size="7.8" font-weight="800" fill="url(#rpref)" font-family="sans-serif">E</text>
    </svg>`;
  }
  if (ext === 'royanim') {
    // Таймлайн-анимация .royanim: кристалл с ▶
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="ranim" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f472b6"/><stop offset="100%" stop-color="#a855f7"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#ranim)" stroke-width="1.3"/>
      <polygon points="6.4,5.4 11,8.3 6.4,11.2" fill="url(#ranim)"/>
    </svg>`;
  }
  if (ext === 'roymodel') {
    // ML/NanoGPT модель .roymodel: кристалл с M
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="rmod" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#2dd4bf"/><stop offset="100%" stop-color="#a3e635"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#rmod)" stroke-width="1.3"/>
      <text x="8" y="11.2" text-anchor="middle" font-size="7.4" font-weight="800" fill="url(#rmod)" font-family="sans-serif">M</text>
    </svg>`;
  }
  if (ext === 'roydata') {
    // Датасет .roydata: кристалл с D
    return `<svg viewBox="0 0 16 16" width="15" height="15">
      <defs><linearGradient id="rdata" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#22d3ee"/></linearGradient></defs>
      <polygon points="8,1 14.5,5 12.5,14 3.5,14 1.5,5" fill="#131624" stroke="url(#rdata)" stroke-width="1.3"/>
      <text x="8" y="11.2" text-anchor="middle" font-size="7.8" font-weight="800" fill="url(#rdata)" font-family="sans-serif">D</text>
    </svg>`;
  }
  if (ext === 'lua' || ext === 'luau') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8.5" r="5.5" fill="#1e3a8a" stroke="#60a5fa" stroke-width="1.2"/><circle cx="10.2" cy="6.2" r="1.4" fill="#93c5fd"/><circle cx="13" cy="3.2" r="1.3" fill="#60a5fa"/></svg>`;
  }
  if (ext === 'py') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="2.5" fill="#1e3a5f" stroke="#38bdf8" stroke-width="1"/><text x="8" y="11.4" text-anchor="middle" font-size="7.5" font-weight="800" fill="#fde047" font-family="sans-serif">PY</text></svg>`;
  }
  if (ext === 'tmj' || ext === 'tmx' || ext === 'ldtk') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#34d399" stroke-width="1.2"><rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6" x2="14" y2="6"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="6" y1="2" x2="6" y2="14"/><line x1="10" y1="2" x2="10" y2="14"/></svg>`;
  }
  if (ext === 'glb' || ext === 'gltf' || ext === 'obj' || ext === 'mtl') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#22d3ee" stroke-width="1.25" stroke-linejoin="round"><polygon points="8,1.5 14,4.8 14,11.2 8,14.5 2,11.2 2,4.8"/><polyline points="2,4.8 8,8 14,4.8"/><line x1="8" y1="8" x2="8" y2="14.5"/></svg>`;
  }
  if (ext === 'glsl' || ext === 'frag' || ext === 'vert' || ext === 'wgsl' || ext === 'hlsl') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#fb923c" stroke-width="1.3" stroke-linecap="round"><polygon points="8,1.8 13.5,5.5 11.5,13.2 4.5,13.2 2.5,5.5"/><circle cx="8" cy="8.2" r="2.1" fill="#fb923c"/></svg>`;
  }
  if (ext === 'ttf' || ext === 'otf' || ext === 'woff' || ext === 'woff2' || ext === 'fnt') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1.5" y="2" width="13" height="12" rx="2" fill="#232733" stroke="#94a3b8" stroke-width="1.1"/><text x="8" y="11.3" text-anchor="middle" font-size="8.2" font-weight="700" fill="#e2e8f0" font-family="serif">Aa</text></svg>`;
  }
  if (ext === 'csv' || ext === 'jsonl') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#4ade80" stroke-width="1.25"><rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="5.5" x2="14" y2="5.5"/><line x1="2" y1="9.5" x2="14" y2="9.5"/><line x1="7" y1="5.5" x2="7" y2="14"/></svg>`;
  }
  if (ext === 'mp3' || ext === 'ogg' || ext === 'wav' || ext === 'flac' || ext === 'm4a' || ext === 'mid' || ext === 'midi') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#f472b6" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12V4.5l6.5-1.5v7.5"/><circle cx="4.3" cy="12" r="1.7" fill="#f472b6"/><circle cx="10.8" cy="10.5" r="1.7" fill="#f472b6"/></svg>`;
  }
  if (ext === 'webm' || ext === 'mp4') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#fb7185" stroke-width="1.3"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><polygon points="6.5,5.5 11,8 6.5,10.5" fill="#fb7185"/></svg>`;
  }
  if (ext === 'ini' || ext === 'cfg') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#94a3b8" stroke-width="1.3" stroke-linecap="round"><line x1="3" y1="4.5" x2="13" y2="4.5"/><circle cx="6.5" cy="4.5" r="1.4" fill="#94a3b8"/><line x1="3" y1="8.5" x2="13" y2="8.5"/><circle cx="10.5" cy="8.5" r="1.4" fill="#94a3b8"/><line x1="3" y1="12.5" x2="13" y2="12.5"/><circle cx="5.5" cy="12.5" r="1.4" fill="#94a3b8"/></svg>`;
  }
  if (ext === 'bat' || ext === 'ps1' || ext === 'sh') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#4ade80" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="#475569"/><polyline points="4.5,6 7,8.5 4.5,11"/><line x1="8.5" y1="11" x2="11.5" y2="11"/></svg>`;
  }
  if (ext === 'sql') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#38bdf8" stroke-width="1.25"><ellipse cx="8" cy="4.2" rx="5" ry="2"/><path d="M3 4.2v7.6c0 1.1 2.2 2 5 2s5-.9 5-2V4.2"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg>`;
  }
  if (ext === 'rs') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="2" fill="#2a1e17" stroke="#f97316" stroke-width="1"/><text x="8" y="11.4" text-anchor="middle" font-size="7.5" font-weight="800" fill="#fb923c" font-family="sans-serif">RS</text></svg>`;
  }
  if (ext === 'cs') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="2" fill="#2b1e3e" stroke="#a855f7" stroke-width="1"/><text x="8" y="11.4" text-anchor="middle" font-size="7.5" font-weight="800" fill="#e9d5ff" font-family="sans-serif">C#</text></svg>`;
  }
  if (ext === 'cpp' || ext === 'c' || ext === 'h' || ext === 'hpp') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="2" fill="#1b2b44" stroke="#60a5fa" stroke-width="1"/><text x="8" y="11.4" text-anchor="middle" font-size="7.2" font-weight="800" fill="#93c5fd" font-family="sans-serif">${ext === 'c' ? 'C' : (ext.startsWith('h') ? 'H' : 'C+')}</text></svg>`;
  }
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="2" fill="#f7df1e"/><text x="8" y="12" text-anchor="middle" font-size="8.5" font-weight="800" fill="#111" font-family="sans-serif">JS</text></svg>`;
  }
  if (ext === 'ts' || ext === 'tsx') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="2" fill="#3178c6"/><text x="8" y="12" text-anchor="middle" font-size="8.5" font-weight="800" fill="#fff" font-family="sans-serif">TS</text></svg>`;
  }
  if (ext === 'html' || ext === 'htm') {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#f97316" stroke-width="1.7" stroke-linecap="round"><polyline points="5.5,4 2,8 5.5,12"/><polyline points="10.5,4 14,8 10.5,12"/></svg>`;
  }
  if (ext === 'css') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><text x="8" y="12.5" text-anchor="middle" font-size="13" font-weight="800" fill="#38bdf8" font-family="monospace">#</text></svg>`;
  }
  if (ext === 'json') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><text x="8" y="12" text-anchor="middle" font-size="11" font-weight="800" fill="#eab308" font-family="monospace">{}</text></svg>`;
  }
  if (ext === 'md') {
    return `<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.2" fill="none" stroke="#60a5fa" stroke-width="1.4"/><text x="8" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="#60a5fa" font-family="sans-serif">i</text></svg>`;
  }
  if (isImageFile(path)) {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#c084fc" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.2" cy="6" r="1.1" fill="#c084fc"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#9ca3af" stroke-width="1.3"><path d="M4 1.5h5.5L13 5v9.5H4z"/><path d="M9.5 1.5V5H13"/></svg>`;
}

function setStatus(text, kind = 'ok') {
  el('buildStatus').textContent = text;
  const errs = state.diagnostics.filter(d => d.severity === 'error').length;
  const warns = state.diagnostics.filter(d => d.severity === 'warning').length;
  el('sbErrIcon').textContent = `✖ ${errs}`;
  el('sbWarnIcon').textContent = `⚠ ${warns}`;
  if (kind === 'err') el('buildStatus').style.color = '#fecaca';
  else if (kind === 'warn') el('buildStatus').style.color = '#fef08a';
  else el('buildStatus').style.color = '#ffffff';
}

function addLog(msg, kind = 'info') {
  state.logs.push({ msg, kind, t: new Date().toLocaleTimeString() });
  if (state.logs.length > 200) state.logs.shift();
  el('logCount').textContent = state.logs.length;
  const pane = el('consoleLogs') || el('consolePane');
  const row = document.createElement('div');
  row.className = `log-row ${kind}`;
  row.textContent = `[${state.logs[state.logs.length - 1].t}] ${msg}`;
  pane.appendChild(row);
  while (pane.children.length > 200) pane.firstElementChild.remove();
  pane.scrollTop = pane.scrollHeight;
}

function addCrashReport(d) {
  const pane = el('consoleLogs') || el('consolePane');
  const file = d.file || state.entryFile || 'main.roy';
  const line = Number(d.line) || 1;
  const msg = d.message || d.raw || 'Ошибка выполнения';
  state.logs.push({ msg, kind: 'err', t: new Date().toLocaleTimeString() });
  el('logCount').textContent = state.logs.length;

  const card = document.createElement('div');
  card.className = 'crash-card';
  const framesTxt = Array.isArray(d.digest) && d.digest.length
    ? d.digest.slice(-12).map(f => `frame #${f.frame ?? '?'}: dt=${Number(f.dt || 0).toFixed(4)} scene=${f.scene || 'main'} ents=${f.entities ?? 0}`).join('\n')
    : '';
  card.innerHTML = `
    <div class="crash-head">
      <span>💥 ${escapeHtml(msg)}</span>
      <button class="crash-loc" title="Перейти к строке">${escapeHtml(file)}:${line}</button>
    </div>
    ${framesTxt ? `<details><summary style="cursor:pointer;color:#94a3b8;font-size:11px;margin-top:4px;">Последние кадры (crashReport)</summary><pre class="crash-frames">${escapeHtml(framesTxt)}</pre></details>` : ''}
  `;
  card.querySelector('.crash-loc')?.addEventListener('click', () => {
    if (state.textFiles[file] != null) openFile(file, line);
    else if (editor) editor.revealLine(line);
  });
  pane.appendChild(card);
  pane.scrollTop = pane.scrollHeight;
  toggleBottomPanel(true);
  document.querySelector('.btab[data-tab="console"]')?.click();
}

function findManifestFile() {
  if (state.textFiles['game.royproj'] != null) return 'game.royproj';
  return Object.keys(state.textFiles).filter(k => !k.includes('/') && k.endsWith('.royproj')).sort()[0] || null;
}

function getProjectManifest() {
  const mf = findManifestFile();
  const base = {
    name: state.projectName || 'My Game',
    version: '0.1.0',
    entry: 'main.roy',
    size: { w: 800, h: 500 },
    fps: 60,
    bg: '#0b0f1a',
    author: '',
    description: '',
    icon: '',
    build: { target: 'html', outDir: 'dist', singleFile: true, icon: '', fullscreen: false, resizable: true }
  };
  if (!mf) return base;
  try {
    const parsed = RoyLang.parseRoyproj(state.textFiles[mf], { strict: false });
    const raw = parsed.raw || {};
    const b = (raw.build && typeof raw.build === 'object') ? raw.build : (parsed.export || {});
    return {
      ...base,
      name: parsed.name || base.name,
      version: parsed.version || base.version,
      entry: parsed.entry || base.entry,
      size: parsed.size || base.size,
      fps: Number(raw.fps) || base.fps,
      bg: String(raw.bg || base.bg),
      author: parsed.author || '',
      description: parsed.description || '',
      icon: parsed.icon || b.icon || '',
      build: {
        target: String(b.target || b.format || 'html'),
        outDir: String(b.outDir || 'dist'),
        singleFile: b.singleFile !== false,
        icon: String(b.icon || parsed.icon || ''),
        fullscreen: Boolean(b.fullscreen),
        resizable: b.resizable !== false
      }
    };
  } catch {
    return base;
  }
}

function getRoyOnlyFiles() {
  const roy = {};
  for (const [k, v] of Object.entries(state.textFiles)) {
    if (k.endsWith('.roy') || k.endsWith('.roylang')) roy[k] = v;
  }
  return roy;
}

function pickEntryFile() {
  const mf = findManifestFile();
  if (mf) {
    const m = getProjectManifest();
    if (m.entry && state.textFiles[m.entry] != null) return m.entry;
  }
  const roy = getRoyOnlyFiles();
  if (roy['main.roy'] != null) return 'main.roy';
  const rKeys = Object.keys(roy).sort();
  if (rKeys.length) return rKeys[0];
  if (state.textFiles['index.html'] != null) return 'index.html';
  return null;
}

function buildTreeModel(paths, dirs = []) {
  const root = { dirs: {}, files: [] };
  const ensureDir = (dirPath) => {
    const parts = dirPath.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const d = parts[i];
      if (!cur.dirs[d]) cur.dirs[d] = { dirs: {}, files: [], path: parts.slice(0, i + 1).join('/') };
      cur = cur.dirs[d];
    }
    return cur;
  };
  for (const d of dirs) ensureDir(d);
  for (const full of paths) {
    const parts = full.split('/');
    const parent = parts.length > 1 ? ensureDir(parts.slice(0, -1).join('/')) : root;
    parent.files.push({ name: parts[parts.length - 1], full });
  }
  return root;
}

function renderInlineRow(depth, mode, placeholder = '') {
  return `<div class="tree-inline-row" style="padding-left:${10 + depth * 14}px">
    <span class="ficon">${mode === 'dir' ? FOLDER_SVG : getFileIconSvg('file.roy')}</span>
    <input id="treeInlineInput" class="tree-inline-input" type="text" value="${escapeHtml(placeholder)}" placeholder="${mode === 'dir' ? 'имя_папки' : 'имя_файла.roy'}" />
  </div>`;
}

function renderTreeNode(node, depth, curDir = '') {
  let html = '';
  if (state.inlineEdit && (state.inlineEdit.kind === 'new-file' || state.inlineEdit.kind === 'new-dir') && state.inlineEdit.parentDir === curDir) {
    html += renderInlineRow(depth, state.inlineEdit.kind === 'new-dir' ? 'dir' : 'file');
  }
  const dirNames = Object.keys(node.dirs).sort();
  for (const d of dirNames) {
    const sub = node.dirs[d];
    const collapsed = state.collapsedDirs.has(sub.path);
    if (state.inlineEdit && state.inlineEdit.kind === 'rename' && state.inlineEdit.target === sub.path) {
      html += renderInlineRow(depth, 'dir', d);
    } else {
      html += `<div class="tree-folder" style="padding-left:${8 + depth * 14}px" data-dir="${escapeHtml(sub.path)}">
        <span>${collapsed ? '▸' : '▾'}</span>
        <span class="ficon">${FOLDER_SVG}</span>
        <span>${escapeHtml(d)}</span>
      </div>`;
    }
    if (!collapsed) html += renderTreeNode(sub, depth + 1, sub.path);
  }
  for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.inlineEdit && state.inlineEdit.kind === 'rename' && state.inlineEdit.target === f.full) {
      html += renderInlineRow(depth, 'file', f.name);
      continue;
    }
    const canOpen = isTextFile(f.full) || isImageFile(f.full);
    const isAct = f.full === state.activeFile;
    const isDirty = state.dirty.has(f.full);
    const cls = `tree-item ${canOpen ? '' : 'asset'} ${isAct ? 'active' : ''}`;
    html += `<div class="${cls}" style="padding-left:${14 + depth * 14}px" data-path="${escapeHtml(f.full)}">
      <span class="tree-label"><span class="ficon">${getFileIconSvg(f.full)}</span><span>${escapeHtml(f.name)}</span></span>
      ${isDirty ? '<span class="dirty-dot">●</span>' : ''}
    </div>`;
  }
  return html;
}

function renderTree() {
  const tree = el('fileTree');
  const fc = el('fileCount');
  if (fc) fc.textContent = state.allFiles.length;
  el('sideProjTitle').textContent = state.projectName.toUpperCase();
  const model = buildTreeModel(state.allFiles, state.allDirs);
  tree.innerHTML = renderTreeNode(model, 0, '');

  tree.querySelectorAll('.tree-folder').forEach(node => {
    node.addEventListener('click', () => {
      const d = node.dataset.dir;
      if (state.collapsedDirs.has(d)) state.collapsedDirs.delete(d);
      else state.collapsedDirs.add(d);
      renderTree();
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, node.dataset.dir, true);
    });
  });

  tree.querySelectorAll('.tree-item[data-path]').forEach(node => {
    node.addEventListener('click', () => {
      const p = node.dataset.path;
      if (isTextFile(p) || isImageFile(p) || isMediaFile(p)) openFile(p);
    });
    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, node.dataset.path, false);
    });
  });

  const inp = el('treeInlineInput');
  if (inp) {
    inp.focus();
    inp.select();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const val = inp.value.trim();
      const edit = state.inlineEdit;
      state.inlineEdit = null;
      if (val) await applyInlineTreeAction(edit, val);
      else renderTree();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { done = true; state.inlineEdit = null; renderTree(); }
    });
    inp.addEventListener('blur', commit);
  }
}

function renderTabs() {
  const bar = el('tabsBar');
  bar.innerHTML = state.openTabs.map(p => {
    const isAct = p === state.activeFile;
    const dot = state.dirty.has(p) ? '● ' : '';
    const short = p.split('/').pop();
    return `<div class="tab ${isAct ? 'active' : ''}" data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">
      <span class="tab-label"><span class="ficon">${getFileIconSvg(p)}</span><span>${dot}${escapeHtml(short)}</span></span>
      <span class="close" data-close="${escapeHtml(p)}">✕</span>
    </div>`;
  }).join('');

  bar.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      if (e.target.dataset.close) closeTab(e.target.dataset.close);
      else openFile(tab.dataset.path);
    });
  });
  el('bcFile').textContent = state.activeFile || '—';
}

function showImageTab(path) {
  const url = state.assetUrls[path];
  el('welcomeScreen')?.classList.add('hidden');
  el('editorSplitWrap')?.classList.add('hidden');
  el('imageViewer').classList.remove('hidden');
  el('ivStage').innerHTML = '<div class="iv-grid-wrap"><img id="ivImg" alt="Preview" /></div>';
  const img = el('ivImg');
  let zoom = 1;
  let gridSize = 0;
  const applyGrid = () => {
    renderImageGridOverlay(el('ivStage'), img, gridSize, (tile) => {
      const snippet = `${tile.x}, ${tile.y}, ${tile.w}, ${tile.h}`;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(snippet).catch(() => {});
      el('ivMeta').textContent = `${path} · ${img.naturalWidth}×${img.naturalHeight} · Тайл [${tile.col},${tile.row}] (${snippet}) скопирован`;
    });
  };
  img.onload = () => {
    el('ivMeta').textContent = `${path} · ${img.naturalWidth} × ${img.naturalHeight} px`;
    applyGrid();
  };
  img.src = url || '';
  el('ivMeta').textContent = path;
  el('ivControls').innerHTML = `
    <select id="ivGridSelect" title="Сетка тайлов для спрайтшитов">
      <option value="0">Сетка: Выкл</option>
      <option value="16">Сетка: 16×16</option>
      <option value="32">Сетка: 32×32</option>
      <option value="64">Сетка: 64×64</option>
    </select>
    <button id="ivZoomOut">−</button><span id="ivZoomValue">100%</span><button id="ivZoomIn">+</button><button id="ivZoomReset">Сбросить</button>
  `;
  const applyZoom = () => {
    img.style.transform = `scale(${zoom})`;
    el('ivZoomValue').textContent = `${Math.round(zoom * 100)}%`;
    setTimeout(applyGrid, 20);
  };
  el('ivGridSelect').onchange = (e) => { gridSize = Number(e.target.value) || 0; applyGrid(); };
  el('ivZoomOut').onclick = () => { zoom = Math.max(.2, zoom - .1); applyZoom(); };
  el('ivZoomIn').onclick = () => { zoom = Math.min(5, zoom + .1); applyZoom(); };
  el('ivZoomReset').onclick = () => { zoom = 1; applyZoom(); };
  document.querySelector('.sb-lang').textContent = 'Изображение';
}

function showAudioTab(path) {
  el('welcomeScreen')?.classList.add('hidden');
  el('editorSplitWrap')?.classList.add('hidden');
  el('imageViewer').classList.remove('hidden');
  const url = state.assetUrls[path];
  const ext = getExt(path);
  el('ivMeta').textContent = path;
  el('ivControls').innerHTML = '';
  if (ext === 'mid' || ext === 'midi') {
    el('ivStage').innerHTML = `<div class="audio-preview"><div class="audio-icon">🎹</div><div class="muted">MIDI файл (${escapeHtml(path)}) — используйте <code>parseMIDI()</code> в RoyLang</div></div>`;
    document.querySelector('.sb-lang').textContent = 'MIDI';
  } else {
    el('ivStage').innerHTML = `<div class="audio-preview"><div class="audio-icon">♫</div><audio controls src="${escapeHtml(url || '')}"></audio></div>`;
    document.querySelector('.sb-lang').textContent = 'Аудио';
  }
}

function showVideoTab(path) {
  el('welcomeScreen')?.classList.add('hidden');
  el('editorSplitWrap')?.classList.add('hidden');
  el('imageViewer').classList.remove('hidden');
  const url = state.assetUrls[path];
  el('ivMeta').textContent = path;
  el('ivControls').innerHTML = '';
  el('ivStage').innerHTML = `<div class="audio-preview"><video controls src="${escapeHtml(url || '')}" style="max-width:100%;max-height:70vh;border-radius:6px;"></video></div>`;
  document.querySelector('.sb-lang').textContent = 'Видео';
}

async function showFontTab(path) {
  el('welcomeScreen')?.classList.add('hidden');
  el('editorSplitWrap')?.classList.add('hidden');
  el('imageViewer').classList.remove('hidden');
  const url = state.assetUrls[path];
  el('ivMeta').textContent = `${path} · Предпросмотр шрифта`;
  el('ivControls').innerHTML = '';
  const familyName = 'RoyPreviewFont_' + path.replace(/[^a-zA-Z0-9]/g, '_');
  try {
    const face = new FontFace(familyName, `url(${url})`);
    await face.load();
    document.fonts.add(face);
  } catch {}
  const sampleDefault = 'Съешь ещё этих мягких французских булок · The quick brown fox · 0123456789';
  el('ivStage').innerHTML = `
    <div style="width:100%;max-width:720px;padding:18px;display:flex;flex-direction:column;gap:12px;color:#e2e8f0;">
      <input id="fontSampleInput" type="text" value="${escapeHtml(sampleDefault)}" style="background:#121212;color:#fff;border:1px solid #3c3c3c;border-radius:4px;padding:6px 10px;font-size:13px;" />
      <div id="fontSamplesList" style="font-family:'${escapeHtml(familyName)}', sans-serif;display:flex;flex-direction:column;gap:12px;background:#1f1f1f;border:1px solid #2b2b2b;border-radius:6px;padding:16px;">
        <div data-fs="14" style="font-size:14px;">${escapeHtml(sampleDefault)}</div>
        <div data-fs="20" style="font-size:20px;">${escapeHtml(sampleDefault)}</div>
        <div data-fs="28" style="font-size:28px;">${escapeHtml(sampleDefault)}</div>
        <div data-fs="40" style="font-size:40px;">${escapeHtml(sampleDefault)}</div>
      </div>
    </div>
  `;
  el('fontSampleInput')?.addEventListener('input', (e) => {
    const val = e.target.value || ' ';
    el('fontSamplesList')?.querySelectorAll('[data-fs]').forEach(d => { d.textContent = val; });
  });
  document.querySelector('.sb-lang').textContent = 'Шрифт';
}

function openFile(path, line = null, fromHistory = false) {
  const ext = getExt(path);
  const hasText = state.textFiles[path] != null;
  const isImg = isImageFile(path) && state.assetUrls[path] != null;
  const isAudio = ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'mid', 'midi'].includes(ext) && state.assetUrls[path] != null;
  const isVideo = ['webm', 'mp4'].includes(ext) && state.assetUrls[path] != null;
  const isFont = ['ttf', 'otf', 'woff', 'woff2'].includes(ext) && state.assetUrls[path] != null;
  if (!hasText && !isImg && !isAudio && !isVideo && !isFont) return;
  el('welcomeScreen')?.classList.add('hidden');
  if (!state.openTabs.includes(path)) state.openTabs.push(path);
  if (!fromHistory) {
    if (state.tabHistory[state.tabHistoryIdx] !== path) {
      state.tabHistory = state.tabHistory.slice(0, state.tabHistoryIdx + 1);
      state.tabHistory.push(path);
      if (state.tabHistory.length > 50) state.tabHistory.shift();
      state.tabHistoryIdx = state.tabHistory.length - 1;
    }
  }
  state.activeFile = path;
  rememberRecent({ rootPath: state.rootPath, name: state.projectName }, path);

  if (isImg && !hasText) {
    showImageTab(path);
  } else if (isVideo && !hasText) {
    showVideoTab(path);
  } else if (isFont && !hasText) {
    showFontTab(path);
  } else if (isAudio && !hasText) {
    showAudioTab(path);
  } else {
    el('imageViewer').classList.add('hidden');
    el('editorSplitWrap')?.classList.remove('hidden');
    el('editorHost').classList.remove('hidden');
    const lang = detectMonacoLang(path);
    if (editor) {
      editor.setLanguage(lang);
      editor.setValue(state.textFiles[path]);
      if (line) editor.revealLine(line);
    }
    const extBadge = {
      royscene: 'RoyScene',
      royprefab: 'RoyPrefab',
      royanim: 'RoyAnim',
      roymodel: 'RoyModel',
      roydata: 'RoyData',
      luau: 'Luau',
      lua: 'Lua',
      py: 'Python',
      glsl: 'GLSL',
      frag: 'GLSL',
      vert: 'GLSL',
      wgsl: 'WGSL',
      hlsl: 'HLSL',
      tmx: 'Tiled XML',
      ini: 'INI',
      cfg: 'Config',
      bat: 'Batch',
      ps1: 'PowerShell',
      sh: 'Shell',
      sql: 'SQL',
      rs: 'Rust',
      cs: 'C#',
      cpp: 'C++',
      c: 'C',
      h: 'C/C++ Header',
      hpp: 'C++ Header'
    }[ext];
    const langLabel =
      extBadge ||
      (lang === 'roy' ? `RoyLang ${RoyLang.VERSION || 'v6.9'}` :
      lang === 'royson' ? 'RoySON' :
      lang === 'royproj' ? 'RoyProj' : lang.toUpperCase());
    document.querySelector('.sb-lang').textContent = langLabel;
  }

  renderTree();
  renderTabs();
  renderOutline();
  runDiagnostics();
}

function renderOutline() {
  const box = el('outlineList');
  const cnt = el('outlineCount');
  if (!box || !cnt) return;
  const text = state.activeFile ? state.textFiles[state.activeFile] : null;
  if (!text) {
    cnt.textContent = '0';
    box.innerHTML = '<div class="muted pad-msg">Нет символов</div>';
    return;
  }
  const items = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^\s*(?:export\s+)?fn\s+([A-Za-z_$][\w$]*)/))) items.push({ kind: 'fn', name: m[1], line: i + 1 });
    else if ((m = l.match(/^\s*(?:export\s+)?entity\s+([A-Za-z_$][\w$]*)/))) items.push({ kind: 'ent', name: m[1], line: i + 1 });
    else if ((m = l.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/))) items.push({ kind: 'cls', name: m[1], line: i + 1 });
    else if ((m = l.match(/^\s*on\s+([a-zA-Z0-9_"\s]+)\{/))) items.push({ kind: 'on', name: m[1].trim(), line: i + 1 });
    else if ((m = l.match(/^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/))) items.push({ kind: 'fn', name: m[1], line: i + 1 });
  }
  cnt.textContent = items.length;
  if (!items.length) {
    box.innerHTML = '<div class="muted pad-msg">Символы не найдены</div>';
    return;
  }
  box.innerHTML = items.map(it =>
    `<div class="outline-item" data-line="${it.line}">
      <span><span class="outline-kind">${it.kind}</span>${escapeHtml(it.name)}</span>
      <span class="muted">:${it.line}</span>
    </div>`
  ).join('');
  box.querySelectorAll('.outline-item').forEach(node => {
    node.addEventListener('click', () => {
      if (editor) editor.revealLine(Number(node.dataset.line));
    });
  });
}

function closeTab(path) {
  state.openTabs = state.openTabs.filter(p => p !== path);
  if (state.activeFile === path) {
    const next = state.openTabs[state.openTabs.length - 1] || null;
    if (next) openFile(next, null, true);
    else {
      state.activeFile = null;
      el('imageViewer').classList.add('hidden');
      el('editorHost').classList.remove('hidden');
      if (editor) editor.setValue('');
    }
  }
  renderTabs();
  renderTree();
  renderOutline();
}

function closeAllTabs() {
  state.openTabs = [];
  state.activeFile = null;
  el('imageViewer').classList.add('hidden');
  el('editorHost').classList.remove('hidden');
  if (editor) editor.setValue('');
  renderTabs();
  renderTree();
  renderOutline();
}

function navTabHistory(delta) {
  const nextIdx = state.tabHistoryIdx + delta;
  if (nextIdx < 0 || nextIdx >= state.tabHistory.length) return;
  const path = state.tabHistory[nextIdx];
  if (state.textFiles[path] == null && state.assetUrls[path] == null) return;
  state.tabHistoryIdx = nextIdx;
  openFile(path, null, true);
}

function jumpDiagnostic(delta) {
  if (!state.diagnostics.length) {
    addLog('Ошибок и предупреждений нет', 'info');
    return;
  }
  const len = state.diagnostics.length;
  state.diagIdx = ((state.diagIdx + delta) % len + len) % len;
  const d = state.diagnostics[state.diagIdx];
  toggleBottomPanel(true);
  document.querySelector('.btab[data-tab="problems"]').click();
  if (d.file && state.textFiles[d.file] != null) openFile(d.file, d.line || 1);
  else if (editor && d.line) editor.revealLine(d.line);
}

function renderProblems() {
  el('probCount').textContent = state.diagnostics.length;
  const pane = el('problemsPane');
  if (!state.diagnostics.length) {
    pane.innerHTML = '<div class="muted">Ошибок и предупреждений нет.</div>';
    return;
  }
  pane.innerHTML = state.diagnostics.map((d, i) =>
    `<div class="diag-row ${d.severity}" data-idx="${i}">
      <span>${d.severity === 'error' ? '✖' : '⚠'}</span>
      <span>${escapeHtml(d.file || state.entryFile)}:${d.line || 1}</span>
      <span>${escapeHtml(d.message)}</span>
    </div>`
  ).join('');
  pane.querySelectorAll('.diag-row').forEach(row => {
    row.addEventListener('click', () => {
      const d = state.diagnostics[Number(row.dataset.idx)];
      toggleBottomPanel(true);
      document.querySelector('.btab[data-tab="problems"]')?.click();
      if (d.file && state.textFiles[d.file] != null) openFile(d.file, d.line || 1);
      else if (editor && d.line) editor.revealLine(d.line);
    });
  });
}

function runDiagnostics() {
  const royFiles = getRoyOnlyFiles();
  const entry = pickEntryFile();
  const diags = [];

  if (entry && (entry.endsWith('.roy') || entry.endsWith('.roylang'))) {
    state.entryFile = entry;
    if (typeof RoyLang.analyze === 'function') {
      try {
        const rep = RoyLang.analyze(royFiles[entry], royFiles, entry);
        updateRoyAnalysis(rep?.symbols || [], {
          getActiveFile: () => state.activeFile,
          onOpenFile: (rel, ln) => {
            if (state.textFiles[rel] != null) openFile(rel, ln || 1);
          }
        });
        for (const e of (rep?.errors || [])) {
          diags.push({ severity: 'error', message: e.message || String(e), line: e.line || 1, col: e.col || 1, file: e.file || entry });
        }
        for (const w of (rep?.warnings || [])) {
          diags.push({ severity: 'warning', message: w.message || String(w), line: w.line || 1, col: w.col || 1, file: w.file || entry });
        }
      } catch (err) {
        diags.push({ severity: 'error', message: err.message || String(err), line: err.royLine || err.line || 1, col: err.royCol || err.col || 1, file: err.royFile || err.fileName || entry });
      }
    } else {
      try {
        const res = RoyLang.compile(royFiles[entry], royFiles, entry);
        for (const w of (res.warnings || [])) {
          diags.push({ severity: 'warning', message: w.message || String(w), line: w.line || 1, col: w.col || 1, file: w.file || entry });
        }
      } catch (err) {
        diags.push({ severity: 'error', message: err.message || String(err), line: err.royLine || err.line || 1, col: err.royCol || err.col || 1, file: err.royFile || err.fileName || entry });
      }
    }
  }

  if (state.activeFile && state.textFiles[state.activeFile] != null) {
    const code = state.textFiles[state.activeFile];
    if (state.activeFile.endsWith('.royson') && typeof RoyLang.validateRoyson === 'function') {
      const v = RoyLang.validateRoyson(code);
      if (!v.ok) {
        for (const e of (v.errors || [])) {
          diags.push({ severity: 'error', message: e.message || String(e), line: e.line || 1, col: e.col || 1, file: state.activeFile });
        }
      } else if (typeof RoyLang.validateRoysonSchema === 'function') {
        try {
          const parsed = RoyLang.parseRoyson(code);
          const sv = RoyLang.validateRoysonSchema(parsed);
          if (sv && !sv.ok) {
            for (const e of (sv.errors || [])) {
              diags.push({ severity: 'warning', message: e.message || String(e), line: e.line || 1, col: e.col || 1, file: state.activeFile });
            }
          }
        } catch {}
      }
    } else if (state.activeFile.endsWith('.royproj') && typeof RoyLang.parseRoyproj === 'function') {
      try {
        RoyLang.parseRoyproj(code, { strict: true });
      } catch (err) {
        diags.push({
          severity: 'error',
          message: err.message || String(err),
          line: err.royLine || err.line || 1,
          col: err.royCol || err.col || 1,
          file: state.activeFile
        });
      }
    }
  }

  // Проверка битых путей ассетов в .roy файлах
  const knownFiles = new Set([
    ...state.allFiles,
    ...Object.keys(state.textFiles),
    ...Object.keys(state.assetUrls)
  ].map(p => String(p).replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase()));
  const assetCallRe = /\b(?:loadSprite|loadImage|loadSound|loadMusic|playMusic|loadFont|loadTilemap|loadModel3D|loadObj3D|loadJson|loadRoyson)\s*\(\s*["']([^"']+)["']/g;
  const assetExtRe = /\.(?:png|jpe?g|webp|avif|gif|svg|bmp|mp3|ogg|wav|flac|m4a|mid|midi|webm|mp4|json|jsonl|csv|royson|royscene|royprefab|royanim|roymodel|roydata|tmj|tmx|ldtk|obj|mtl|gltf|glb|ttf|otf|woff2?|fnt)$/i;
  for (const [file, code] of Object.entries(royFiles)) {
    const lines = String(code || '').split('\n');
    for (let li = 0; li < lines.length; li++) {
      assetCallRe.lastIndex = 0;
      let m;
      while ((m = assetCallRe.exec(lines[li])) !== null) {
        const rawPath = m[1].trim();
        if (!rawPath || /^(?:https?:|data:|blob:)/i.test(rawPath) || !assetExtRe.test(rawPath)) continue;
        const norm = rawPath.replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
        if (!knownFiles.has(norm)) {
          diags.push({
            severity: 'warning',
            message: `Ассет не найден в проекте: "${rawPath}"`,
            line: li + 1,
            col: m.index + 1,
            file
          });
        }
      }
    }
  }

  state.diagnostics = diags;
  const errCnt = diags.filter(d => d.severity === 'error').length;
  const warnCnt = diags.filter(d => d.severity === 'warning').length;
  if (errCnt) setStatus(`Ошибок: ${errCnt}`, 'err');
  else if (warnCnt) setStatus(`Предупреждения: ${warnCnt}`, 'warn');
  else setStatus('Компиляция OK', 'ok');

  renderProblems();
  if (editor) editor.setMarkers(diags.filter(d => !d.file || d.file === state.activeFile));
}

function collectProjectFilesForCompiler() {
  const out = {};
  for (const [rel, content] of Object.entries(state.textFiles)) {
    if (/^(dist|node_modules|\.git)\//i.test(rel)) continue;
    out[rel] = { type: 'text', content: String(content) };
  }
  for (const [rel, b64] of Object.entries(state.assetBase64 || {})) {
    if (/^(dist|node_modules|\.git)\//i.test(rel) || out[rel]) continue;
    out[rel] = {
      type: 'base64',
      content: b64,
      mime: typeof RoyLang.guessMime === 'function' ? RoyLang.guessMime(rel) : 'application/octet-stream'
    };
  }
  return out;
}

function buildStandaloneAssetMap() {
  const out = {};
  for (const [rel, b64] of Object.entries(state.assetBase64 || {})) {
    const mime = typeof RoyLang.guessMime === 'function' ? RoyLang.guessMime(rel) : 'application/octet-stream';
    out[rel] = `data:${mime};base64,${b64}`;
  }
  for (const [rel, url] of Object.entries(state.assetUrls || {})) {
    if (!out[rel] && typeof url === 'string' && !url.startsWith('http://asset.localhost')) {
      out[rel] = url;
    }
  }
  return out;
}

function injectAssetAndLogBridge(html, includeLogBridge = true, embedDataUrls = false) {
  const assetSource = embedDataUrls ? buildStandaloneAssetMap() : state.assetUrls;
  const safeAssets = JSON.stringify(assetSource).replace(/<\/script/gi, '<\\/script');
  const textMap = {};
  for (const [rel, txt] of Object.entries(state.textFiles)) {
    if (/\.(royson|royproj|json|txt|csv)$/i.test(rel)) textMap[rel] = txt;
  }
  const safeTexts = JSON.stringify(textMap).replace(/<\/script/gi, '<\\/script');
  const assetHook = `<script>
    (function(){
      var map = ${safeAssets};
      var tmap = ${safeTexts};
      function resolveAsset(u) {
        if (typeof u !== 'string') return u;
        var norm = u.replace(/^\\.\\//, '').replace(/^\\//, '');
        return map[u] || map[norm] || u;
      }
      var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (imgDesc && imgDesc.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          get: function(){ return imgDesc.get.call(this); },
          set: function(v){ return imgDesc.set.call(this, resolveAsset(v)); },
          configurable: true
        });
      }
      var audDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
      if (audDesc && audDesc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
          get: function(){ return audDesc.get.call(this); },
          set: function(v){ return audDesc.set.call(this, resolveAsset(v)); },
          configurable: true
        });
      }
      if (window.fetch) {
        var origFetch = window.fetch;
        window.fetch = function(input, init) {
          if (typeof input === 'string') {
            var norm = input.replace(/^\\.\\//, '').replace(/^\\//, '');
            if (Object.prototype.hasOwnProperty.call(tmap, input) || Object.prototype.hasOwnProperty.call(tmap, norm)) {
              var body = tmap[input] !== undefined ? tmap[input] : tmap[norm];
              return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
            }
            input = resolveAsset(input);
          }
          return origFetch.call(this, input, init);
        };
      }
    })();
  <\/script>`;

  const logHook = includeLogBridge ? `<script>
    (function(){
      var send = function(kind, args) {
        try { parent.postMessage({ __royLog: true, kind: kind, text: Array.from(args).map(String).join(' ') }, '*'); } catch {}
      };
      var oLog = console.log, oWarn = console.warn, oErr = console.error;
      console.log = function(){ send('info', arguments); oLog.apply(console, arguments); };
      console.warn = function(){ send('warn', arguments); oWarn.apply(console, arguments); };
      console.error = function(){ send('err', arguments); oErr.apply(console, arguments); };
      window.addEventListener('error', function(e){ send('err', [e.message + ' (' + e.lineno + ')']); });
      window.addEventListener('keydown', function(e){
        if (e.code === 'F5' || e.key === 'F5') {
          e.preventDefault();
          try { parent.postMessage({ type: 'roystudio-action', action: 'rerun' }, '*'); } catch {}
        }
      });
    })();
  <\/script>` : '';

  return html.replace('<head>', '<head>' + assetHook + logHook);
}

function buildHtmlProjectPreview(entryHtml) {
  let html = entryHtml;
  html = html.replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi, (m, href) => {
    const norm = href.replace(/^\.\//, '');
    return state.textFiles[norm] != null ? `<style>\n${state.textFiles[norm]}\n</style>` : m;
  });
  html = html.replace(/<script[^>]+src=["']([^"']+\.(?:js|mjs))["'][^>]*>\s*<\/script>/gi, (m, src) => {
    const norm = src.replace(/^\.\//, '');
    return state.textFiles[norm] != null ? `<script>\n${state.textFiles[norm]}\n<\/script>` : m;
  });
  return html;
}

function buildCompiledOutput(includeLogBridge = true, opts = {}) {
  const entry = (opts.entryOverride && state.textFiles[opts.entryOverride] != null)
    ? opts.entryOverride
    : pickEntryFile();
  if (!entry) return null;
  const manifest = getProjectManifest();
  const title = opts.titleOverride || manifest.name;
  const embedDataUrls = Boolean(opts.embedDataUrls);
  if (entry.endsWith('.roy') || entry.endsWith('.roylang')) {
    const projectFiles = collectProjectFilesForCompiler();
    const compileOpts = {
      release: Boolean(opts.release),
      minify: Boolean(opts.minify),
      treeShake: opts.treeShake !== false
    };
    const rawHtml = RoyLang.compileToHtml(state.textFiles[entry], { title }, projectFiles, entry, compileOpts);
    return {
      entry,
      count: Object.keys(getRoyOnlyFiles()).length,
      html: injectAssetAndLogBridge(rawHtml, includeLogBridge, embedDataUrls),
      projectFiles
    };
  }
  const rawHtml = buildHtmlProjectPreview(state.textFiles[entry]);
  return {
    entry,
    count: Object.keys(state.textFiles).length,
    html: injectAssetAndLogBridge(rawHtml, includeLogBridge, embedDataUrls),
    projectFiles: {}
  };
}

function compileAndRun() {
  runDiagnostics();
  try {
    const built = buildCompiledOutput(true);
    if (!built) return;
    el('previewFrame').srcdoc = built.html;
    addLog(`Запуск ${built.entry} (модулей: ${built.count}, ассетов: ${Object.keys(state.assetUrls).length})`, 'info');
  } catch (err) {
    addLog(`Ошибка сборки: ${err.message || err}`, 'err');
  }
}

async function saveActiveFile() {
  if (!state.activeFile || state.textFiles[state.activeFile] == null) return;
  await fsBridge.writeFile(state.activeFile, state.textFiles[state.activeFile]);
  state.dirty.delete(state.activeFile);
  if (state.activeFile.endsWith('.royproj')) {
    const manifest = getProjectManifest();
    if (manifest.name) state.projectName = manifest.name;
    el('projName').textContent = state.projectName;
    document.querySelector('.bc-proj').textContent = state.projectName;
    document.title = `${state.projectName} — RoyStudio Desktop`;
    const ri = el('runEntryInfo');
    if (ri) ri.textContent = `Входной файл: ${pickEntryFile() || '—'}`;
  }
  renderTree();
  renderTabs();
  addLog(`Сохранено: ${state.activeFile}`, 'info');

  const hotEnabled = el('chkHotSwap')?.checked && el('previewFrame')?.contentWindow;
  if (hotEnabled) {
    const f = state.activeFile;
    if (f.endsWith('.roy') || f.endsWith('.roylang')) {
      try {
        const royFiles = getRoyOnlyFiles();
        const entry = pickEntryFile() || f;
        const compiled = RoyLang.compile(royFiles[entry], royFiles, entry);
        if (compiled && compiled.jsCode) {
          sendStudioCmd(el('previewFrame'), { cmd: 'hotCode', code: compiled.jsCode });
          return;
        }
      } catch {}
    } else if (/\.(royson|royproj|royscene|royprefab|royanim|roydata|json)$/i.test(f)) {
      sendStudioCmd(el('previewFrame'), { cmd: 'hotData', path: f, content: state.textFiles[f] });
      return;
    }
  }
  compileAndRun();
}

async function saveAllFiles() {
  const dirtyList = [...state.dirty].filter(p => state.textFiles[p] != null);
  if (!dirtyList.length) {
    addLog('Все файлы уже сохранены', 'info');
    return;
  }
  for (const rel of dirtyList) {
    await fsBridge.writeFile(rel, state.textFiles[rel]);
    state.dirty.delete(rel);
  }
  renderTree();
  renderTabs();
  addLog(`Сохранено файлов: ${dirtyList.length}`, 'info');
  compileAndRun();
}

async function exportCurrentHtml() {
  try {
    const built = buildCompiledOutput(false, { embedDataUrls: true });
    if (!built) return;
    const ok = await fsBridge.exportHtml(`${state.projectName}.html`, built.html);
    if (ok) addLog(`Экспорт выполнен: ${state.projectName}.html`, 'info');
  } catch (err) {
    addLog(`Ошибка экспорта: ${err.message || err}`, 'err');
  }
}

function formatRoyprojManifest(data) {
  const safeName = String(data.name || 'My Game').replace(/"/g, '\\"');
  const obj = {
    version: String(data.version || '0.1.0'),
    entry: String(data.entry || 'main.roy'),
    size: { w: Math.max(200, Number(data.width) || 800), h: Math.max(200, Number(data.height) || 500) },
    fps: Math.max(1, Number(data.fps) || 60),
    bg: String(data.bg || '#0b0f1a'),
    ...(data.author ? { author: String(data.author) } : {}),
    ...(data.description ? { description: String(data.description) } : {}),
    ...(data.icon ? { icon: String(data.icon) } : {}),
    build: {
      target: String(data.target || 'html'),
      outDir: String(data.outDir || 'dist'),
      singleFile: data.singleFile !== false,
      includeSources: Boolean(data.includeSrc),
      icon: String(data.icon || ''),
      fullscreen: Boolean(data.fullscreen),
      resizable: data.resizable !== false
    }
  };
  const body = typeof RoyLang.stringifyRoyson === 'function'
    ? RoyLang.stringifyRoyson(obj, { indent: 2, pretty: true, unquotedKeys: true })
    : JSON.stringify(obj, null, 2);
  return `// Манифест проекта RoyLang v6.5\nproject "${safeName}" ${body}\n`;
}

async function handleNewProject() {
  try {
    const defaultName = 'MyRoyGame';
    const royprojText = formatRoyprojManifest({
      name: defaultName,
      version: '0.1.0',
      entry: 'main.roy',
      width: 800,
      height: 500,
      fps: 60,
      bg: '#0b0f1a'
    });
    const mainRoyText = [
      'game "MyRoyGame" {',
      '  size: 800x500',
      '  fps: 60',
      '  gamepad: "auto"',
      '}',
      '',
      'let x = 400',
      'let y = 250',
      '',
      'on update(dt) {',
      '  let spd = 240',
      '  if key("ArrowLeft") or key("KeyA") { x -= spd * dt }',
      '  if key("ArrowRight") or key("KeyD") { x += spd * dt }',
      '  if key("ArrowUp") or key("KeyW") { y -= spd * dt }',
      '  if key("ArrowDown") or key("KeyS") { y += spd * dt }',
      '  x = clamp(x, 24, 776)',
      '  y = clamp(y, 24, 476)',
      '}',
      '',
      'on draw {',
      '  cls("#090d16")',
      '  drawGrid(40, "rgba(56,189,248,0.08)")',
      '  drawGlow(x, y, 42, "#38bdf8", 0.35)',
      '  drawCircle(x, y, 16, "#38bdf8")',
      '  text("RoyLang v6.5 — Новый проект", 400, 36, "#e879f9", 18, "center")',
      '}',
      ''
    ].join('\n');
    const proj = await fsBridge.createNewProject(defaultName, royprojText, mainRoyText);
    if (proj) {
      loadProjectState(proj);
      addLog('Создан новый проект (game.royproj + main.roy)', 'info');
    }
  } catch (err) {
    addLog(`Ошибка создания проекта: ${err.message || err}`, 'err');
  }
}

async function handleOpenRoyproj() {
  try {
    const proj = await fsBridge.openRoyprojFile();
    if (proj) loadProjectState(proj);
  } catch (err) {
    addLog(`Ошибка открытия .royproj: ${err.message || err}`, 'err');
  }
}

function formatActiveDocument() {
  if (!state.activeFile || state.textFiles[state.activeFile] == null) return;
  const raw = state.textFiles[state.activeFile];
  try {
    let formatted = null;
    if ((state.activeFile.endsWith('.roy') || state.activeFile.endsWith('.roylang')) && typeof RoyLang.format === 'function') {
      formatted = RoyLang.format(raw);
    } else if (state.activeFile.endsWith('.royson') && typeof RoyLang.parseRoyson === 'function' && typeof RoyLang.stringifyRoyson === 'function') {
      const val = RoyLang.parseRoyson(raw, { strict: true });
      formatted = RoyLang.stringifyRoyson(val, { indent: 2, pretty: true, unquotedKeys: true }) + '\n';
    } else if (state.activeFile.endsWith('.json')) {
      const val = RoyLang.parseRoyson(raw, { strict: true });
      formatted = JSON.stringify(val, null, 2) + '\n';
    } else if (state.activeFile.endsWith('.royproj') && typeof RoyLang.parseRoyproj === 'function') {
      const p = RoyLang.parseRoyproj(raw, { strict: true });
      const rawObj = p.raw || {};
      formatted = formatRoyprojManifest({
        name: p.name,
        version: p.version,
        entry: p.entry,
        width: p.size?.w || 800,
        height: p.size?.h || 500,
        fps: rawObj.fps || 60,
        bg: rawObj.bg || '#0b0f1a',
        author: p.author,
        description: p.description,
        icon: p.icon || rawObj.build?.icon || '',
        target: rawObj.build?.target || p.export?.format || 'html',
        outDir: rawObj.build?.outDir || p.export?.outDir || 'dist',
        singleFile: rawObj.build?.singleFile !== false,
        includeSrc: Boolean(rawObj.build?.includeSources),
        fullscreen: Boolean(rawObj.build?.fullscreen),
        resizable: rawObj.build?.resizable !== false
      });
    } else {
      if (editor) editor.runAction('editor.action.formatDocument');
      return;
    }
    if (formatted != null) {
      state.textFiles[state.activeFile] = formatted;
      state.dirty.add(state.activeFile);
      if (editor) editor.setValue(formatted);
      renderTree();
      renderTabs();
      runDiagnostics();
      addLog(`Форматировано: ${state.activeFile}`, 'info');
    }
  } catch (err) {
    addLog(`Ошибка форматирования ${state.activeFile}: ${err.message || err}`, 'err');
  }
}

// Build / Export Modal (HTML / ZIP / EXE)
let buildModalTarget = 'html';
let lastBuildDirPath = null;

function setBuildLog(msg, isErr = false) {
  const node = el('buildLog');
  if (!node) return;
  node.textContent = msg;
  node.style.color = isErr ? '#fca5a5' : '#93c5fd';
  node.style.borderColor = isErr ? 'rgba(239,68,68,0.45)' : '';
}

function syncBuildTargetUi() {
  document.querySelectorAll('#buildTargets .bld-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === buildModalTarget);
  });
  const iconRow = document.querySelector('.build-icon-row');
  if (iconRow) iconRow.classList.toggle('hidden', buildModalTarget !== 'exe');
  const chkSingle = el('bldSingleFile')?.closest('.chk');
  const chkSrc = el('bldIncludeSrc')?.closest('.chk');
  const chkFull = el('bldFullscreen')?.closest('.chk');
  const chkRes = el('bldResizable')?.closest('.chk');
  if (chkSingle) chkSingle.classList.toggle('hidden', buildModalTarget === 'zip-src' || buildModalTarget === 'exe');
  if (chkSrc) chkSrc.classList.toggle('hidden', buildModalTarget !== 'zip');
  if (chkFull) chkFull.classList.toggle('hidden', buildModalTarget !== 'exe');
  if (chkRes) chkRes.classList.toggle('hidden', buildModalTarget !== 'exe');
  const labels = {
    html: '🌐 Экспортировать .html',
    zip: '🗜 Собрать .zip (Игра)',
    'zip-src': '📁 Собрать .zip (Исходники)',
    exe: '🪟 Собрать .exe (Windows)'
  };
  el('btnStartBuild').textContent = labels[buildModalTarget] || '🔨 Собрать';
}

function openBuildModal(presetTarget = null) {
  closeTopMenu();
  const mf = getProjectManifest();
  el('bldName').value = mf.name || state.projectName || 'My Game';
  el('bldVersion').value = mf.version || '0.1.0';
  el('bldAuthor').value = mf.author || '';
  el('bldEntry').value = pickEntryFile() || mf.entry || 'main.roy';
  el('bldWidth').value = mf.size?.w || 800;
  el('bldHeight').value = mf.size?.h || 500;
  el('bldBg').value = mf.bg || '#0b0f1a';
  el('bldOutDir').value = mf.build?.outDir || 'dist';
  el('bldIcon').value = mf.build?.icon || mf.icon || '';
  el('bldSingleFile').checked = mf.build?.singleFile !== false;
  el('bldIncludeSrc').checked = Boolean(mf.build?.includeSources);
  el('bldFullscreen').checked = Boolean(mf.build?.fullscreen);
  el('bldResizable').checked = mf.build?.resizable !== false;
  el('bldSaveManifest').checked = true;
  if (presetTarget && ['html', 'zip', 'zip-src', 'exe'].includes(presetTarget)) {
    buildModalTarget = presetTarget;
  } else if (['html', 'zip', 'zip-src', 'exe'].includes(mf.build?.target)) {
    buildModalTarget = mf.build.target;
  } else {
    buildModalTarget = 'html';
  }
  el('buildResultInfo').textContent = '—';
  el('btnOpenBuildDir').disabled = !lastBuildDirPath;
  setBuildLog('Готово к сборке. Выберите цель и нажмите «Собрать».');
  syncBuildTargetUi();
  el('buildModal').classList.remove('hidden');
}

function closeBuildModal() {
  el('buildModal').classList.add('hidden');
}

function isAbsBuildPath(p) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(p || '').trim());
}

function joinBuildPath(base, sub) {
  const b = String(base || '').replace(/[\\/]+$/, '');
  const s = String(sub || '').replace(/^[\\/]+/, '');
  return b ? `${b}/${s}` : s;
}

function formatBytesSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

async function runBuildPipeline() {
  const btn = el('btnStartBuild');
  btn.disabled = true;
  try {
    const name = el('bldName').value.trim() || state.projectName || 'RoyGame';
    const slug = name.replace(/[<>:"/\\|?*]+/g, '_').replace(/\s+/g, '_') || 'RoyGame';
    const version = el('bldVersion').value.trim() || '0.1.0';
    const author = el('bldAuthor').value.trim();
    const entry = el('bldEntry').value.trim() || pickEntryFile() || 'main.roy';
    const width = Math.max(200, Math.min(3840, Number(el('bldWidth').value) || 800));
    const height = Math.max(200, Math.min(2160, Number(el('bldHeight').value) || 500));
    const bg = el('bldBg').value.trim() || '#0b0f1a';
    const outDirRaw = el('bldOutDir').value.trim() || 'dist';
    const iconPath = el('bldIcon').value.trim();
    const release = el('bldRelease')?.checked !== false;
    const treeShake = el('bldTreeShake')?.checked !== false;
    const singleFile = el('bldSingleFile').checked;
    const includeSrc = el('bldIncludeSrc').checked;
    const fullscreen = el('bldFullscreen').checked;
    const resizable = el('bldResizable').checked;
    const saveManifest = el('bldSaveManifest').checked;

    if (saveManifest) {
      const prevMf = getProjectManifest();
      const mfPath = findManifestFile() || 'game.royproj';
      const mfText = formatRoyprojManifest({
        name, version, entry, width, height, fps: prevMf.fps || 60, bg, author,
        description: prevMf.description || '',
        icon: iconPath,
        target: buildModalTarget,
        outDir: outDirRaw,
        singleFile,
        includeSrc,
        fullscreen,
        resizable
      });
      state.textFiles[mfPath] = mfText;
      if (!state.allFiles.includes(mfPath)) {
        state.allFiles.push(mfPath);
        state.allFiles.sort();
      }
      if (state.rootPath) {
        await fsBridge.writeFile(mfPath, mfText);
        state.dirty.delete(mfPath);
      } else {
        state.dirty.add(mfPath);
      }
      state.projectName = name;
      el('projName').textContent = name;
      document.querySelector('.bc-proj').textContent = name;
      document.title = `${name} — RoyStudio Desktop`;
      renderTree();
      renderTabs();
    }

    if (buildModalTarget !== 'zip-src') {
      if (state.textFiles[entry] == null) {
        setBuildLog(`Входной файл не найден: ${entry}`, true);
        return;
      }
      if (entry.endsWith('.roy') || entry.endsWith('.roylang')) {
        const royFiles = getRoyOnlyFiles();
        try {
          RoyLang.compile(royFiles[entry], royFiles, entry);
        } catch (err) {
          runDiagnostics();
          setBuildLog(`Ошибка компиляции в ${err.royFile || err.fileName || entry}:${err.royLine || err.line || 1}: ${err.message || err}`, true);
          addLog(`Сборка отменена (ошибка компиляции): ${err.message || err}`, 'err');
          return;
        }
      }
    }

    const resolveOutDir = async () => {
      if (isAbsBuildPath(outDirRaw)) return outDirRaw;
      if (state.rootPath) return joinBuildPath(state.rootPath, outDirRaw);
      return fsBridge.pickDirectory('Выберите папку для сохранения сборки');
    };

    if (buildModalTarget === 'html') {
      setBuildLog('Компиляция HTML...');
      const built = buildCompiledOutput(false, { embedDataUrls: singleFile, entryOverride: entry, titleOverride: name, release, minify: release, treeShake });
      let outPath = null;
      if (isTauriEnv()) {
        if (isAbsBuildPath(outDirRaw)) outPath = joinBuildPath(outDirRaw, `${slug}.html`);
        else if (state.rootPath) outPath = joinBuildPath(joinBuildPath(state.rootPath, outDirRaw), `${slug}.html`);
        else outPath = await fsBridge.pickSaveFile(`${slug}.html`, 'HTML Game', 'html');
        if (!outPath) { setBuildLog('Сохранение отменено.'); return; }
      } else {
        outPath = `${slug}.html`;
      }
      const written = await fsBridge.writeTextAbsolute(outPath, built.html);
      lastBuildDirPath = isTauriEnv() ? (outPath.split(/[\\/]/).slice(0, -1).join('/') || outPath) : null;
      el('btnOpenBuildDir').disabled = !lastBuildDirPath;
      el('buildResultInfo').textContent = `${slug}.html · ${formatBytesSize(written || built.html.length)}`;
      setBuildLog(`Готово!\nФайл: ${outPath}\nРазмер: ${formatBytesSize(written || built.html.length)}`);
      addLog(`HTML собран: ${outPath}`, 'info');
    } else if (buildModalTarget === 'pwa') {
      if (typeof RoyLang.compileToPwaFiles !== 'function') throw new Error('compileToPwaFiles недоступен в текущей версии движка');
      setBuildLog('Компиляция PWA (manifest, sw.js, index.html)...');
      const projectFiles = collectProjectFilesForCompiler();
      const pwa = RoyLang.compileToPwaFiles(state.textFiles[entry], { title: name }, projectFiles, entry, { release, minify: release, treeShake });
      const pwaFiles = pwa?.files || pwa || {};
      const entries = Object.entries(pwaFiles).map(([p, content]) => ({
        path: p,
        is_base64: false,
        data: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
      }));
      if (isTauriEnv()) {
        const dir = await resolveOutDir();
        if (!dir) { setBuildLog('Сохранение отменено.'); return; }
        const outZip = joinBuildPath(dir, `${slug}-pwa.zip`);
        const bytes = await fsBridge.exportZipArchive(outZip, entries);
        lastBuildDirPath = dir;
        el('btnOpenBuildDir').disabled = false;
        el('buildResultInfo').textContent = `${slug}-pwa.zip · ${formatBytesSize(bytes)} (${entries.length} файл.)`;
        setBuildLog(`PWA-пакет собран!\nАрхив: ${outZip}\nФайлов: ${entries.length} · Размер: ${formatBytesSize(bytes)}`);
        addLog(`PWA собран: ${outZip}`, 'info');
      } else {
        setBuildLog(`PWA-пакет сгенерирован (${entries.length} файл.)`);
      }
    } else if (buildModalTarget === 'zip') {
      if (!isTauriEnv()) throw new Error('ZIP-сборка на диск доступна в настольном RoyStudio Desktop');
      setBuildLog('Сборка игры и упаковка ZIP...');
      const dir = await resolveOutDir();
      const outZip = dir ? joinBuildPath(dir, `${slug}.zip`) : await fsBridge.pickSaveFile(`${slug}.zip`, 'ZIP Archive', 'zip');
      if (!outZip) { setBuildLog('Сохранение отменено.'); return; }
      const built = buildCompiledOutput(false, { embedDataUrls: singleFile, entryOverride: entry, titleOverride: name, release, minify: release, treeShake });
      const entries = [{ path: 'index.html', is_base64: false, data: built.html }];
      const seen = new Set(['index.html']);
      if (!singleFile) {
        for (const [rel, b64] of Object.entries(state.assetBase64 || {})) {
          if (/^(dist|node_modules|\.git)\//i.test(rel) || seen.has(rel)) continue;
          seen.add(rel);
          entries.push({ path: rel, is_base64: true, data: b64 });
        }
        for (const [rel, txt] of Object.entries(state.textFiles)) {
          if (/\.(royson|royproj|json|txt|csv)$/i.test(rel) && !/^(dist|node_modules|\.git)\//i.test(rel) && !seen.has(rel)) {
            seen.add(rel);
            entries.push({ path: rel, is_base64: false, data: String(txt) });
          }
        }
      }
      if (includeSrc) {
        for (const [rel, txt] of Object.entries(state.textFiles)) {
          if (/^(dist|node_modules|\.git)\//i.test(rel)) continue;
          const p = `src/${rel}`;
          if (!seen.has(p)) { seen.add(p); entries.push({ path: p, is_base64: false, data: String(txt) }); }
        }
        for (const [rel, b64] of Object.entries(state.assetBase64 || {})) {
          if (/^(dist|node_modules|\.git)\//i.test(rel)) continue;
          const p = `src/${rel}`;
          if (!seen.has(p)) { seen.add(p); entries.push({ path: p, is_base64: true, data: b64 }); }
        }
      }
      const bytes = await fsBridge.exportZipArchive(outZip, entries);
       lastBuildDirPath = outZip.split(/[\\/]/).slice(0, -1).join('/');
      el('btnOpenBuildDir').disabled = false;
      el('buildResultInfo').textContent = `${slug}.zip · ${formatBytesSize(bytes)} (${entries.length} файл.)`;
      setBuildLog(`ZIP (Игра) собран!\nАрхив: ${outZip}\nФайлов: ${entries.length} · Размер: ${formatBytesSize(bytes)}`);
      addLog(`ZIP собран: ${outZip} (${formatBytesSize(bytes)})`, 'info');
    } else if (buildModalTarget === 'zip-src') {
      if (!isTauriEnv()) throw new Error('ZIP-архив исходников доступен в настольном RoyStudio Desktop');
      setBuildLog('Упаковка исходников проекта в ZIP...');
      const dir = await resolveOutDir();
      const outZip = dir ? joinBuildPath(dir, `${slug}-source.zip`) : await fsBridge.pickSaveFile(`${slug}-source.zip`, 'ZIP Archive', 'zip');
      if (!outZip) { setBuildLog('Сохранение отменено.'); return; }
      const entries = [];
      const seen = new Set();
      for (const [rel, txt] of Object.entries(state.textFiles)) {
        if (/^(dist|node_modules|\.git)\//i.test(rel) || seen.has(rel)) continue;
        seen.add(rel);
        entries.push({ path: rel, is_base64: false, data: String(txt) });
      }
      for (const [rel, b64] of Object.entries(state.assetBase64 || {})) {
        if (/^(dist|node_modules|\.git)\//i.test(rel) || seen.has(rel)) continue;
        seen.add(rel);
        entries.push({ path: rel, is_base64: true, data: b64 });
      }
      const bytes = await fsBridge.exportZipArchive(outZip, entries);
       lastBuildDirPath = outZip.split(/[\\/]/).slice(0, -1).join('/');
      el('btnOpenBuildDir').disabled = false;
      el('buildResultInfo').textContent = `${slug}-source.zip · ${formatBytesSize(bytes)} (${entries.length} файл.)`;
      setBuildLog(`ZIP исходников собран!\nАрхив: ${outZip}\nФайлов: ${entries.length} · Размер: ${formatBytesSize(bytes)}`);
      addLog(`ZIP исходников: ${outZip} (${formatBytesSize(bytes)})`, 'info');
    } else if (buildModalTarget === 'exe') {
      if (!isTauriEnv()) throw new Error('Сборка Windows .exe поддерживается только в настольном RoyStudio Desktop');
      const dir = await resolveOutDir();
      if (!dir) { setBuildLog('Сборка отменена: не выбрана папка вывода.'); return; }
      setBuildLog('Компиляция игры и сборка standalone Windows .exe...');
      const built = buildCompiledOutput(false, { embedDataUrls: true, entryOverride: entry, titleOverride: name, release, minify: release, treeShake });
      const cfgJson = JSON.stringify({ title: name, width, height, bg, fullscreen, resizable });
      const res = await fsBridge.buildStandaloneExe(state.rootPath, dir, slug, cfgJson, built.html, iconPath);
       lastBuildDirPath = dir;
      el('btnOpenBuildDir').disabled = false;
      el('buildResultInfo').textContent = `${slug}.exe · ${formatBytesSize(res.size_bytes)}`;
      setBuildLog(
        `Windows .exe собран!\nФайл: ${res.exe_path}\nРазмер: ${formatBytesSize(res.size_bytes)}` +
        `\nWebView2Loader.dll: ${res.copied_loader ? 'скопирован рядом' : 'рядом уже присутствует / встроен'}`
      );
      addLog(`.exe собран: ${res.exe_path} (${formatBytesSize(res.size_bytes)})`, 'info');
    }
  } catch (err) {
    setBuildLog(`Ошибка сборки: ${err.message || err}`, true);
    addLog(`Ошибка сборки: ${err.message || err}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

const SESSION_KEY_PREFIX = 'roystudio.session.v1:';
function getSessionKey(rootPath = state.rootPath) {
  return SESSION_KEY_PREFIX + (rootPath || '__demo__');
}
function saveIdeSession() {
  try {
    const drafts = {};
    for (const rel of state.dirty) {
      if (state.textFiles[rel] != null && state.textFiles[rel].length <= 200000) {
        drafts[rel] = state.textFiles[rel];
      }
    }
    const pos = editor && typeof editor.getPosition === 'function' ? editor.getPosition() : { line: 1, col: 1 };
    const payload = {
      openTabs: state.openTabs.slice(0, 30),
      activeFile: state.activeFile,
      cursor: pos,
      drafts
    };
    localStorage.setItem(getSessionKey(), JSON.stringify(payload));
  } catch {}
}
function restoreIdeSession(rootPath, skipActiveOpen = false) {
  try {
    const raw = localStorage.getItem(getSessionKey(rootPath));
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return false;
    if (s.drafts && typeof s.drafts === 'object') {
      for (const [rel, txt] of Object.entries(s.drafts)) {
        if (typeof txt === 'string' && state.textFiles[rel] != null && state.textFiles[rel] !== txt) {
          state.textFiles[rel] = txt;
          state.dirty.add(rel);
        }
      }
    }
    const validTabs = (Array.isArray(s.openTabs) ? s.openTabs : []).filter(
      p => state.textFiles[p] != null || state.assetUrls[p] != null
    );
    if (!validTabs.length) return false;
    state.openTabs = validTabs;
    if (!skipActiveOpen) {
      const target = (s.activeFile && validTabs.includes(s.activeFile)) ? s.activeFile : validTabs[0];
      openFile(target);
      if (editor && typeof editor.setPosition === 'function' && s.cursor) {
        editor.setPosition(s.cursor.line, s.cursor.col);
      }
    } else {
      renderTree();
      renderTabs();
    }
    return true;
  } catch {
    return false;
  }
}
window.addEventListener('beforeunload', () => saveIdeSession());

function loadProjectState(proj, opts = {}) {
  lastWatcherSig = null;
  state.rootPath = proj.rootPath || null;
  state.allFiles = proj.files;
  state.allDirs = proj.dirs || [];
  state.textFiles = proj.textFiles;
  state.assetUrls = proj.assetUrls || {};
  state.assetBase64 = proj.assetBase64 || {};
  state.dirty.clear();
  state.collapsedDirs.clear();
  state.openTabs = [];
  state.tabHistory = [];
  state.tabHistoryIdx = -1;
  state.diagIdx = -1;
  state.activeFile = null;
  state.projectName = proj.name;
  rememberRecent(proj);
  renderRecent();
  const mf = findManifestFile();
  if (mf) {
    const manifest = getProjectManifest();
    if (manifest.name) state.projectName = manifest.name;
  }
  el('projName').textContent = state.projectName;
  document.querySelector('.bc-proj').textContent = state.projectName;
  document.title = `${state.projectName} — RoyStudio Desktop`;
  const entry = pickEntryFile() || Object.keys(state.textFiles).sort()[0];
  const ri = el('runEntryInfo');
  if (ri) ri.textContent = `Входной файл: ${entry || '—'}`;
  const restored = opts.skipSessionRestore ? false : restoreIdeSession(state.rootPath, Boolean(opts.skipDefaultOpen));
  if (!restored && !opts.skipDefaultOpen) {
    if (entry) openFile(entry);
    else { renderTree(); renderTabs(); renderOutline(); }
  }
  compileAndRun();
  if (state.activeView === 'git') renderGitPane();
}

let lastWatcherSig = null;
let isWatchingRefresh = false;

async function refreshFromDisk() {
  if (isWatchingRefresh) return;
  isWatchingRefresh = true;
  try {
    const proj = await fsBridge.refreshFolder();
    if (!proj) return;
    const prevOpen = [...state.openTabs];
    const prevActive = state.activeFile;
    const dirtyCopy = {};
    for (const rel of state.dirty) {
      if (state.textFiles[rel] != null) dirtyCopy[rel] = state.textFiles[rel];
    }
    state.rootPath = proj.rootPath || state.rootPath;
    state.allFiles = proj.files;
    state.allDirs = proj.dirs || [];
    state.textFiles = { ...proj.textFiles, ...dirtyCopy };
    state.assetUrls = proj.assetUrls || {};
    state.assetBase64 = proj.assetBase64 || {};
    state.openTabs = prevOpen.filter(p => state.textFiles[p] != null || state.assetUrls[p] != null);
    state.activeFile = state.openTabs.includes(prevActive) ? prevActive : (state.openTabs[0] || null);
    const entries = await fsBridge.scanProjectEntries().catch(() => []);
    if (entries.length) {
      lastWatcherSig = entries.map(e => `${e.path}:${e.size}`).sort().join('|');
    }
    renderTree();
    renderTabs();
    renderOutline();
    if (state.activeView === 'git') renderGitPane();
  } catch (err) {
    addLog(err.message || String(err), 'err');
  } finally {
    isWatchingRefresh = false;
  }
}

async function applyInlineTreeAction(edit, val) {
  try {
    if (edit.kind === 'new-file') {
      const name = val.includes('.') ? val : `${val}.roy`;
      const rel = edit.parentDir ? `${edit.parentDir}/${name}` : name;
      const content = rel.endsWith('.json')
        ? '{\n  \n}\n'
        : rel.endsWith('.royson')
          ? '// Конфигурация RoySON\n{\n  version: 1\n  size: 800x500\n}\n'
          : rel.endsWith('.royproj')
            ? formatRoyprojManifest({ name: state.projectName || 'My Game' })
            : (rel.endsWith('.roy') ? '// Новый модуль RoyLang v6.5\n' : '');
      await fsBridge.writeFile(rel, content);
      state.textFiles[rel] = content;
      if (!state.allFiles.includes(rel)) state.allFiles.push(rel);
      state.allFiles.sort();
      openFile(rel);
    } else if (edit.kind === 'new-dir') {
      const rel = edit.parentDir ? `${edit.parentDir}/${val}` : val;
      await fsBridge.createDir(rel);
      if (!state.allDirs.includes(rel)) state.allDirs.push(rel);
      state.allDirs.sort();
      state.collapsedDirs.delete(rel);
      renderTree();
    } else if (edit.kind === 'rename') {
      const parts = edit.target.split('/');
      parts[parts.length - 1] = val;
      const newRel = parts.join('/');
      if (newRel === edit.target) return renderTree();
      await fsBridge.renameEntry(edit.target, newRel);
      await refreshFromDisk();
      if (state.textFiles[newRel] != null) openFile(newRel);
    }
  } catch (err) {
    addLog(err.message || String(err), 'err');
    renderTree();
  }
}

function startInlineCreate(kind, parentDir = '') {
  if (parentDir) state.collapsedDirs.delete(parentDir);
  state.inlineEdit = { kind, parentDir };
  renderTree();
}

// Context Menu
let ctxTarget = null;
function openCtxMenu(x, y, rel, isDir) {
  ctxTarget = { rel, isDir };
  const menu = el('ctxMenu');
  menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 150) + 'px';
  menu.classList.remove('hidden');
}
function closeCtxMenu() { el('ctxMenu').classList.add('hidden'); }
window.addEventListener('click', closeCtxMenu);
el('ctxMenu').querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    closeCtxMenu();
    if (!ctxTarget) return;
    const act = btn.dataset.act;
    const parentDir = ctxTarget.isDir ? ctxTarget.rel : (ctxTarget.rel.includes('/') ? ctxTarget.rel.split('/').slice(0, -1).join('/') : '');
    if (act === 'new-file') startInlineCreate('new-file', parentDir);
    else if (act === 'new-dir') startInlineCreate('new-dir', parentDir);
    else if (act === 'pack-atlas') {
      try {
        await packFolderToSpriteAtlas(parentDir, { state, RoyLang, fsBridge, refreshFromDisk, addLog, openFile });
      } catch (err) {
        addLog(`Ошибка упаковки атласа: ${err.message || err}`, 'err');
      }
    }
    else if (act === 'rename') { state.inlineEdit = { kind: 'rename', target: ctxTarget.rel }; renderTree(); }
    else if (act === 'delete') {
      if (!confirm(`Удалить "${ctxTarget.rel}"?`)) return;
      try {
        await fsBridge.deleteEntry(ctxTarget.rel);
        closeTab(ctxTarget.rel);
        await refreshFromDisk();
      } catch (err) {
        addLog(err.message || String(err), 'err');
      }
    }
  });
});

// Git / Source Control
async function renderGitPane() {
  const pane = el('gitPane');
  try {
    const st = await fsBridge.gitStatus();
    if (st.needFolder) {
      pane.innerHTML = `<div class="muted">Откройте папку проекта с диска, чтобы использовать Git.</div>
        <button id="btnGitOpenFolder" class="primary full-btn">📂 Открыть папку</button>`;
      el('btnGitOpenFolder').addEventListener('click', handleOpenFolder);
      return;
    }
    if (st.unsupported) {
      pane.innerHTML = '<div class="muted">Git доступен в настольном приложении RoyStudio Desktop.</div>';
      return;
    }
    if (!st.is_repo) {
      pane.innerHTML = `<div class="muted">В этой папке ещё нет Git-репозитория.</div>
        <button id="btnGitInit" class="primary full-btn">Initialize Repository</button>`;
      el('btnGitInit').addEventListener('click', async () => {
        try { await fsBridge.gitInit(); renderGitPane(); } catch (e) { addLog(e.message || String(e), 'err'); }
      });
      return;
    }
    const listHtml = st.changes.length
      ? st.changes.map(c => `<div class="git-row" data-file="${escapeHtml(c.path)}"><span>${escapeHtml(c.path)}</span><span class="git-code">${escapeHtml(c.code)}</span></div>`).join('')
      : '<div class="muted">Нет изменённых файлов.</div>';
    pane.innerHTML = `<div class="muted">Ветка: <strong style="color:#fff">${escapeHtml(st.branch)}</strong></div>
      <input id="gitCommitMsg" class="git-msg" type="text" placeholder="Сообщение коммита..." />
      <button id="btnGitCommit" class="primary full-btn">✓ Commit (${st.changes.length})</button>
      <div>${listHtml}</div>`;
    el('btnGitCommit').addEventListener('click', async () => {
      try {
        const msg = el('gitCommitMsg').value;
        await fsBridge.gitCommit(msg);
        addLog('Git commit выполнен', 'info');
        renderGitPane();
      } catch (e) { addLog(e.message || String(e), 'err'); }
    });
    pane.querySelectorAll('.git-row').forEach(r => {
      r.addEventListener('click', () => openFile(r.dataset.file));
    });
  } catch (err) {
    pane.innerHTML = `<div class="muted">${escapeHtml(err.message || String(err))}</div>`;
  }
}

// Activity Bar switching
function toggleSidebar(forceShow = null) {
  const sidebar = el('sidebar');
  const hidden = forceShow === true ? false : (forceShow === false ? true : !sidebar.classList.contains('hidden'));
  sidebar.classList.toggle('hidden', hidden);
  el('resizerLeft').classList.toggle('hidden', hidden);
  el('btnToggleSidebar').classList.toggle('active', !hidden);
  if (hidden) {
    document.querySelectorAll('.act-btn').forEach(b => b.classList.remove('active'));
  } else {
    document.querySelectorAll('.act-btn').forEach(b => b.classList.toggle('active', b.dataset.view === state.activeView));
  }
}

function switchSideView(view, forceOpen = false) {
  const sidebar = el('sidebar');
  if (!forceOpen && state.activeView === view && !sidebar.classList.contains('hidden')) {
    toggleSidebar(false);
    return;
  }
  state.activeView = view;
  ['explorer', 'search', 'git', 'run', 'apis'].forEach(v => el(`view-${v}`).classList.toggle('hidden', v !== view));
  toggleSidebar(true);
  if (view === 'search') el('searchFilesInput').focus();
  if (view === 'apis') el('searchApiInput').focus();
  if (view === 'git') renderGitPane();
}

document.querySelectorAll('.act-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSideView(btn.dataset.view));
});

// Project-wide search & replace
function runProjectSearch() {
  const qRaw = el('searchFilesInput')?.value || '';
  const q = qRaw.trim().toLowerCase();
  const out = el('searchResults');
  if (!out) return;
  if (!q) {
    out.innerHTML = '<div class="muted pad-msg">Введите текст для поиска по всем файлам проекта.</div>';
    return;
  }
  const hits = [];
  for (const [file, text] of Object.entries(state.textFiles)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ file, line: i + 1, text: lines[i].trim() });
        if (hits.length >= 120) break;
      }
    }
    if (hits.length >= 120) break;
  }
  if (!hits.length) {
    out.innerHTML = '<div class="muted pad-msg">Ничего не найдено.</div>';
    return;
  }
  out.innerHTML = hits.map(h =>
    `<div class="search-hit" data-file="${escapeHtml(h.file)}" data-line="${h.line}">
      <div class="search-hit-file">${escapeHtml(h.file)}:${h.line}</div>
      <div class="search-hit-line">${escapeHtml(h.text)}</div>
    </div>`
  ).join('');
  out.querySelectorAll('.search-hit').forEach(node => {
    node.addEventListener('click', () => openFile(node.dataset.file, Number(node.dataset.line)));
  });
}

el('searchFilesInput').addEventListener('input', runProjectSearch);

el('btnReplaceAllFiles')?.addEventListener('click', () => {
  const needle = el('searchFilesInput')?.value || '';
  const repl = el('replaceFilesInput')?.value ?? '';
  if (!needle) return;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'gi');
  let totalCount = 0;
  const touched = [];
  for (const [file, text] of Object.entries(state.textFiles)) {
    const matches = text.match(re);
    if (matches && matches.length) {
      totalCount += matches.length;
      touched.push({ file, next: text.replace(re, repl) });
    }
  }
  if (!totalCount) {
    addLog(`Совпадений для "${needle}" не найдено`, 'warn');
    return;
  }
  if (!confirm(`Заменить ${totalCount} вхожд. "${needle}" на "${repl}" в ${touched.length} файл.?`)) return;
  for (const item of touched) {
    state.textFiles[item.file] = item.next;
    state.dirty.add(item.file);
    if (item.file === state.activeFile && editor) editor.setValue(item.next);
  }
  renderTree();
  renderTabs();
  runProjectSearch();
  runDiagnostics();
  saveIdeSession();
  addLog(`Заменено ${totalCount} вхожд. в ${touched.length} файл.`, 'info');
});

// API Reference browser
function renderApiList(filter = '') {
  const q = filter.trim().toLowerCase();
  const eng = getEngineState();
  const apis = eng.apis || [];
  const items = q ? apis.filter(a => a.toLowerCase().includes(q)) : apis;
  el('apiTotalCount').textContent = items.length;
  el('apiList').innerHTML = items.slice(0, 200).map(name => {
    const doc = eng.docsByName?.get(name);
    const tip = doc ? `${doc.sig}\n${doc.desc}` : `Клик — вставить ${name}() в редактор`;
    return `<div class="api-row" data-api="${escapeHtml(name)}" title="${escapeHtml(tip)}">
      <span>${escapeHtml(name)}()</span>
      <span>вставить</span>
    </div>`;
  }).join('');
  el('apiList').querySelectorAll('.api-row').forEach(row => {
    row.addEventListener('click', () => {
      if (editor) editor.insertText(`${row.dataset.api}()`);
    });
  });
}
el('searchApiInput').addEventListener('input', (e) => renderApiList(e.target.value));

// Resizers
function initResizer(barEl, onDrag, vertical = true) {
  barEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    barEl.classList.add('dragging');
    document.body.classList.add('resizing');
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    const start = vertical ? e.clientX : e.clientY;
    const onMove = (ev) => onDrag((vertical ? ev.clientX : ev.clientY) - start);
    const onUp = () => {
      barEl.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

let startSideW = 245, startPrevW = 460, startBotH = 165;
el('resizerLeft').addEventListener('mousedown', () => { startSideW = el('sidebar').offsetWidth; });
initResizer(el('resizerLeft'), (dx) => { el('sidebar').style.width = Math.max(170, Math.min(460, startSideW + dx)) + 'px'; }, true);

el('resizerRight').addEventListener('mousedown', () => { startPrevW = el('previewCol').offsetWidth; });
initResizer(el('resizerRight'), (dx) => { el('previewCol').style.width = Math.max(280, Math.min(820, startPrevW - dx)) + 'px'; }, true);

el('resizerBottom').addEventListener('mousedown', () => { startBotH = el('bottomPanel').offsetHeight; });
initResizer(el('resizerBottom'), (dy) => { el('bottomPanel').style.height = Math.max(80, Math.min(480, startBotH - dy)) + 'px'; }, false);

// Toggle Preview / Bottom Panel
el('btnTogglePreview').addEventListener('click', () => {
  const hidden = el('previewCol').classList.toggle('hidden');
  el('resizerRight').classList.toggle('hidden', hidden);
  el('btnTogglePreview').classList.toggle('active', !hidden);
});

let nativeFsActive = false;
function setPreviewFullscreen(enable) {
  const previewCol = el('previewCol');
  const btn = el('btnFullscreenPreview');
  if (enable) {
    previewCol.classList.remove('hidden');
    el('resizerRight').classList.remove('hidden');
    el('btnTogglePreview').classList.add('active');
    previewCol.classList.add('is-fullscreen');
    if (btn) {
      btn.textContent = '✕ Свернуть';
      btn.title = 'Выйти из полного экрана (Esc)';
    }
    try {
      if (document.fullscreenElement !== previewCol && previewCol.requestFullscreen) {
        const res = previewCol.requestFullscreen();
        if (res && typeof res.catch === 'function') res.catch(() => {});
      }
    } catch {}
  } else {
    previewCol.classList.remove('is-fullscreen');
    if (btn) {
      btn.textContent = '⛶';
      btn.title = 'Полный экран превью (F11 / Esc)';
    }
    try {
      if (document.fullscreenElement === previewCol && document.exitFullscreen) {
        const res = document.exitFullscreen();
        if (res && typeof res.catch === 'function') res.catch(() => {});
      }
    } catch {}
  }
}

function togglePreviewFullscreen() {
  setPreviewFullscreen(!el('previewCol').classList.contains('is-fullscreen'));
}

document.addEventListener('fullscreenchange', () => {
  const previewCol = el('previewCol');
  if (document.fullscreenElement === previewCol) {
    nativeFsActive = true;
  } else if (nativeFsActive) {
    nativeFsActive = false;
    if (previewCol.classList.contains('is-fullscreen')) {
      setPreviewFullscreen(false);
    }
  }
});
function toggleBottomPanel(forceShow = null) {
  const p = el('bottomPanel');
  const hidden = forceShow === true ? false : (forceShow === false ? true : !p.classList.contains('hidden'));
  p.classList.toggle('hidden', hidden);
  el('resizerBottom').classList.toggle('hidden', hidden);
  el('btnToggleBottom').classList.toggle('active', !hidden);
}
el('btnToggleBottom').addEventListener('click', () => toggleBottomPanel());
el('sbProblems').addEventListener('click', () => {
  toggleBottomPanel(true);
  document.querySelector('.btab[data-tab="problems"]').click();
});

// Command Palette
const COMMANDS = [
  { label: 'Новый проект (.royproj + main.roy)...', hint: '', run: () => handleNewProject() },
  { label: 'Открыть папку проекта...', hint: 'Ctrl+O', run: () => handleOpenFolder() },
  { label: 'Открыть манифест (.royproj)...', hint: '', run: () => handleOpenRoyproj() },
  { label: 'Создать новый файл (.roy / .royson / .royproj / .html / .css / .js / .json)', hint: 'Ctrl+N', run: () => { switchSideView('explorer', true); startInlineCreate('new-file', ''); } },
  { label: 'Создать новую папку', hint: '', run: () => { switchSideView('explorer', true); startInlineCreate('new-dir', ''); } },
  { label: 'Сохранить активный файл', hint: 'Ctrl+S', run: saveActiveFile },
  { label: 'Сохранить все файлы', hint: 'Ctrl+Shift+S', run: saveAllFiles },
  { label: 'Форматировать активный файл (.royson / .royproj / .json)', hint: '', run: formatActiveDocument },
  { label: 'Запустить / перезапустить игру', hint: 'F5', run: compileAndRun },
  { label: 'Превью игры на весь экран', hint: 'F11', run: () => togglePreviewFullscreen() },
  { label: 'Сборка и экспорт проекта (HTML / ZIP / EXE)...', hint: 'Ctrl+Shift+B', run: () => openBuildModal() },
  { label: 'Быстрый экспорт игры в .html...', hint: '', run: exportCurrentHtml },
  { label: 'Показать / скрыть боковую панель', hint: 'Ctrl+B', run: () => toggleSidebar() },
  { label: 'Показать / скрыть превью игры', hint: '', run: () => el('btnTogglePreview').click() },
  { label: 'Показать / скрыть нижнюю панель', hint: 'Ctrl+`', run: () => toggleBottomPanel() },
  { label: 'Поиск по файлам проекта', hint: 'Ctrl+Shift+F', run: () => switchSideView('search', true) },
  { label: 'Source Control (Git)', hint: 'Ctrl+Shift+G', run: () => switchSideView('git', true) },
  { label: 'Справочник API RoyLang', hint: '', run: () => switchSideView('apis', true) },
  { label: 'Проверить обновления (IDE и движок RoyLang)...', hint: '', run: () => openUpdateModal() },
  { label: 'Переключить / обновить движок RoyLang...', hint: '', run: () => openUpdateModal() },
  { label: 'Переключить перенос строк (Word Wrap)', hint: 'Alt+Z', run: () => editor && editor.toggleWordWrap() },
  { label: 'Горячие клавиши...', hint: '', run: () => showShortcutsModal() }
];

let cmdPaletteMode = 'all';
function openCmdPalette(mode = 'all') {
  cmdPaletteMode = mode;
  closeTopMenu();
  el('cmdModal').classList.remove('hidden');
  el('cmdInput').value = '';
  el('cmdInput').placeholder = mode === 'files' ? 'Введите имя файла проекта...' : 'Введите команду или имя файла...';
  renderCmdList('');
  el('cmdInput').focus();
}
function closeCmdPalette() { el('cmdModal').classList.add('hidden'); }
function renderCmdList(q) {
  const s = q.trim().toLowerCase();
  const fileItems = Object.keys(state.textFiles).concat(Object.keys(state.assetUrls).filter(k => state.textFiles[k] == null)).map(f => ({
    label: `Файл: ${f}`, hint: 'открыть', run: () => openFile(f)
  }));
  const source = cmdPaletteMode === 'files' ? fileItems : [...COMMANDS, ...fileItems];
  const fuzzy = (text, query) => {
    let score = 0, pos = 0;
    for (const ch of query) { const at = text.indexOf(ch, pos); if (at < 0) return -1; score += at === pos ? 3 : 1; pos = at + 1; }
    return score - (text.length - query.length) * .01;
  };
  const all = source.map((c, idx) => ({ c, idx, score: !s ? 0 : fuzzy(c.label.toLowerCase(), s) })).filter(x => x.score >= 0).sort((a, b) => b.score - a.score).map(x => x.c);
  el('cmdList').innerHTML = all.slice(0, 25).map((c, i) =>
    `<div class="cmd-item ${i === 0 ? 'sel' : ''}" data-i="${i}"><span>${escapeHtml(c.label)}</span><span>${escapeHtml(c.hint)}</span></div>`
  ).join('');
  el('cmdList').querySelectorAll('.cmd-item').forEach((row, idx) => {
    row.addEventListener('click', () => { closeCmdPalette(); all[idx].run(); });
  });
}
el('btnCmdPalette').addEventListener('click', () => openCmdPalette('all'));
el('cmdInput').addEventListener('input', (e) => renderCmdList(e.target.value));
el('cmdModal').addEventListener('click', (e) => { if (e.target === el('cmdModal')) closeCmdPalette(); });

// Top Menu Bar (VS Code style)
function showInfoModal(title, html) {
  closeTopMenu();
  el('infoTitle').textContent = title;
  el('infoBody').innerHTML = html;
  el('infoModal').classList.remove('hidden');
}
function closeInfoModal() { el('infoModal').classList.add('hidden'); }
el('btnCloseInfo').addEventListener('click', closeInfoModal);
el('infoModal').addEventListener('click', (e) => { if (e.target === el('infoModal')) closeInfoModal(); });

function showShortcutsModal() {
  const rows = [
    ['Новый файл', 'Ctrl+N'],
    ['Открыть папку проекта', 'Ctrl+O'],
    ['Сохранить / Сохранить все', 'Ctrl+S / Ctrl+Shift+S'],
    ['Сборка и экспорт (HTML / ZIP / EXE)', 'Ctrl+Shift+B'],
    ['Закрыть вкладку', 'Ctrl+W'],
    ['Палитра команд / Быстрый файл', 'Ctrl+Shift+P / Ctrl+P'],
    ['Проводник / Поиск / Git / Запуск', 'Ctrl+Shift+E / F / G / D'],
    ['Назад / Вперёд по вкладкам', 'Alt+← / Alt+→'],
    ['Боковая панель / Нижняя панель', 'Ctrl+B / Ctrl+`'],
    ['Панель «Проблемы» / След. проблема', 'Ctrl+Shift+M / F8'],
    ['Запустить игру / Полный экран превью', 'F5 / F11'],
    ['Перенос строк / Поиск / Замена', 'Alt+Z / Ctrl+F / Ctrl+H']
  ];
  const grid = rows.map(([a, b]) => `<div>${escapeHtml(a)}</div><kbd>${escapeHtml(b)}</kbd>`).join('');
  showInfoModal('Горячие клавиши RoyStudio', `<div class="kbd-grid">${grid}</div>`);
}

function showAboutModal() {
  const eng = getEngineState();
  const ver = eng.version || 'v6.9';
  const ideVer = updState.appVersion || '1.1.0';
  const modeStr = isTauriEnv() ? 'Настольное приложение (Desktop)' : 'Веб-режим (Browser)';
  showInfoModal('О программе RoyStudio Desktop', `
    <p><strong>RoyStudio Desktop v${escapeHtml(ideVer)}</strong> — интегрированная среда разработки для языка и игрового движка <strong>RoyLang</strong>.</p>
    <p>Версия движка: <strong style="color:#f97316">${escapeHtml(ver)}</strong> · Режим: <strong>${modeStr}</strong></p>
    <p><strong>Форматы RoyLang:</strong></p>
    <ul class="muted" style="margin:4px 0 8px 18px;line-height:1.45;">
      <li><code>.roy</code>, <code>.roylang</code> — исходный код на RoyLang</li>
      <li><code>.royson</code> — конфиги, данные и сейвы (v6.5)</li>
      <li><code>.royproj</code> — манифест проекта (v6.5)</li>
      <li><code>.royscene</code>, <code>.royprefab</code>, <code>.royanim</code> — сцены, префабы и таймлайн-анимации (v6.6)</li>
      <li><code>.roymodel</code>, <code>.roydata</code> — обученные ИИ/ML/NanoGPT-модели (вкл. Int8) и датасеты (v6.7)</li>
    </ul>
    <p><strong>3D, карты, шейдеры, шрифты, медиа и скрипты:</strong></p>
    <p class="muted" style="line-height:1.45;">
      <code>.ttf</code>, <code>.otf</code>, <code>.woff</code>, <code>.woff2</code>, <code>.fnt</code> (шрифты с предпросмотром) ·
      <code>.csv</code>, <code>.jsonl</code> · <code>.tmj</code>/<code>.tmx</code>/<code>.tsx</code> (Tiled), <code>.ldtk</code> ·
      <code>.glb</code>, <code>.gltf</code>, <code>.obj</code>, <code>.mtl</code> ·
      <code>.glsl</code>, <code>.frag</code>, <code>.vert</code>, <code>.wgsl</code>, <code>.hlsl</code>, <code>.svg</code> ·
      <code>.mid</code>/<code>.midi</code>, <code>.webm</code>, <code>.mp4</code>, <code>.wav</code>, <code>.mp3</code>, <code>.ogg</code>, <code>.flac</code>, <code>.m4a</code>, <code>.png</code>, <code>.jpg</code>, <code>.webp</code>, <code>.avif</code> ·
      <code>.ini</code>, <code>.cfg</code>, <code>.bat</code>, <code>.ps1</code>, <code>.sh</code>, <code>.sql</code>, <code>.lua</code>, <code>.luau</code>, <code>.py</code>, <code>.rs</code>, <code>.cs</code>, <code>.cpp</code>, <code>.h</code>, <code>.md</code>, <code>.js</code>, <code>.ts</code>, <code>.html</code>, <code>.css</code>, <code>.json</code>.<br/>
      Экспорт: HTML, PWA, ZIP и Windows <code>.exe</code>.
    </p>
  `);
}

function buildMenus() {
  const opts = editor ? editor.getOptionsState() : { minimap: true, wordWrap: false, fontSize: 13 };
  return {
    file: [
      { label: 'Новый проект (.royproj)...', hint: '', run: handleNewProject },
      { label: 'Новый файл', hint: 'Ctrl+N', run: () => { switchSideView('explorer', true); startInlineCreate('new-file', ''); } },
      { label: 'Новая папка', hint: '', run: () => { switchSideView('explorer', true); startInlineCreate('new-dir', ''); } },
      { sep: true },
      { label: 'Открыть папку...', hint: 'Ctrl+O', run: handleOpenFolder },
      { label: 'Открыть манифест .royproj...', hint: '', run: handleOpenRoyproj },
      { label: 'Обновить дерево с диска', hint: '', run: refreshFromDisk },
      { sep: true },
      { label: 'Сохранить', hint: 'Ctrl+S', run: saveActiveFile },
      { label: 'Сохранить все', hint: 'Ctrl+Shift+S', run: saveAllFiles },
      { label: 'Сборка и экспорт (HTML / ZIP / EXE)...', hint: 'Ctrl+Shift+B', run: () => openBuildModal() },
      { label: 'Быстрый экспорт в .html...', hint: '', run: exportCurrentHtml },
      { sep: true },
      { label: 'Автосохранение', checked: state.autoSave, run: () => { state.autoSave = !state.autoSave; addLog(`Автосохранение: ${state.autoSave ? 'ВКЛ' : 'ВЫКЛ'}`, 'info'); } },
      { sep: true },
      { label: 'Закрыть вкладку', hint: 'Ctrl+W', run: () => { if (state.activeFile) closeTab(state.activeFile); } },
      { label: 'Закрыть все вкладки', hint: '', run: closeAllTabs }
    ],
    edit: [
      { label: 'Отменить', hint: 'Ctrl+Z', run: () => editor && editor.trigger('undo') },
      { label: 'Повторить', hint: 'Ctrl+Y', run: () => editor && editor.trigger('redo') },
      { sep: true },
      { label: 'Вырезать', hint: 'Ctrl+X', run: () => editor && editor.execClipboard('cut') },
      { label: 'Копировать', hint: 'Ctrl+C', run: () => editor && editor.execClipboard('copy') },
      { label: 'Вставить', hint: 'Ctrl+V', run: () => editor && editor.execClipboard('paste') },
      { sep: true },
      { label: 'Найти в файле', hint: 'Ctrl+F', run: () => editor && editor.runAction('actions.find') },
      { label: 'Заменить в файле', hint: 'Ctrl+H', run: () => editor && editor.runAction('editor.action.startFindReplaceAction') },
      { label: 'Найти в файлах', hint: 'Ctrl+Shift+F', run: () => switchSideView('search', true) },
      { sep: true },
      { label: 'Форматировать (.royson / .royproj / .json)', hint: '', run: formatActiveDocument },
      { label: 'Переключить комментарий строки', hint: 'Ctrl+/', run: () => editor && editor.runAction('editor.action.commentLine') },
      { label: 'Блочный комментарий', hint: 'Shift+Alt+A', run: () => editor && editor.runAction('editor.action.blockComment') }
    ],
    selection: [
      { label: 'Выделить всё', hint: 'Ctrl+A', run: () => editor && editor.runAction('editor.action.selectAll') },
      { label: 'Расширить выделение', hint: 'Shift+Alt+→', run: () => editor && editor.runAction('editor.action.smartSelect.expand') },
      { label: 'Сузить выделение', hint: 'Shift+Alt+←', run: () => editor && editor.runAction('editor.action.smartSelect.shrink') },
      { sep: true },
      { label: 'Копировать строку вверх', hint: 'Shift+Alt+↑', run: () => editor && editor.runAction('editor.action.copyLinesUpAction') },
      { label: 'Копировать строку вниз', hint: 'Shift+Alt+↓', run: () => editor && editor.runAction('editor.action.copyLinesDownAction') },
      { label: 'Переместить строку вверх', hint: 'Alt+↑', run: () => editor && editor.runAction('editor.action.moveLinesUpAction') },
      { label: 'Переместить строку вниз', hint: 'Alt+↓', run: () => editor && editor.runAction('editor.action.moveLinesDownAction') },
      { sep: true },
      { label: 'Курсор выше', hint: 'Ctrl+Alt+↑', run: () => editor && editor.runAction('editor.action.insertCursorAbove') },
      { label: 'Курсор ниже', hint: 'Ctrl+Alt+↓', run: () => editor && editor.runAction('editor.action.insertCursorBelow') },
      { label: 'Следующее совпадение', hint: 'Ctrl+D', run: () => editor && editor.runAction('editor.action.addSelectionToNextFindMatch') },
      { label: 'Выделить все совпадения', hint: 'Ctrl+Shift+L', run: () => editor && editor.runAction('editor.action.selectHighlights') }
    ],
    view: [
      { label: 'Палитра команд', hint: 'Ctrl+Shift+P', run: () => openCmdPalette('all') },
      { sep: true },
      { label: 'Проводник', hint: 'Ctrl+Shift+E', run: () => switchSideView('explorer', true) },
      { label: 'Поиск по файлам', hint: 'Ctrl+Shift+F', run: () => switchSideView('search', true) },
      { label: 'Source Control (Git)', hint: 'Ctrl+Shift+G', run: () => switchSideView('git', true) },
      { label: 'Run and Debug', hint: 'Ctrl+Shift+D', run: () => switchSideView('run', true) },
      { label: 'Справочник RoyLang API', hint: '', run: () => switchSideView('apis', true) },
      { sep: true },
      { label: 'Проблемы', hint: 'Ctrl+Shift+M', run: () => { toggleBottomPanel(true); document.querySelector('.btab[data-tab="problems"]').click(); } },
      { label: 'Консоль игры', hint: 'Ctrl+`', run: () => { toggleBottomPanel(true); document.querySelector('.btab[data-tab="console"]').click(); } },
      { label: 'Превью игры', hint: '', run: () => el('btnTogglePreview').click() },
      { label: 'Превью на весь экран', hint: 'F11', run: () => togglePreviewFullscreen() },
      { sep: true },
      { label: 'Боковая панель', hint: 'Ctrl+B', run: () => toggleSidebar() },
      { label: 'Мини-карта редактора', checked: opts.minimap, run: () => editor && editor.toggleMinimap() },
      { label: 'Перенос строк (Word Wrap)', hint: 'Alt+Z', checked: opts.wordWrap, run: () => editor && editor.toggleWordWrap() },
      { label: 'Увеличить шрифт', hint: 'Ctrl+=', run: () => editor && editor.adjustFontSize(1) },
      { label: 'Уменьшить шрифт', hint: 'Ctrl+-', run: () => editor && editor.adjustFontSize(-1) }
    ],
    go: [
      { label: 'Назад по вкладкам', hint: 'Alt+←', run: () => navTabHistory(-1) },
      { label: 'Вперёд по вкладкам', hint: 'Alt+→', run: () => navTabHistory(1) },
      { sep: true },
      { label: 'Перейти к файлу...', hint: 'Ctrl+P', run: () => openCmdPalette('files') },
      { label: 'Перейти к строке...', hint: 'Ctrl+G', run: () => editor && editor.runAction('editor.action.gotoLine') },
      { label: 'К парной скобке', hint: 'Ctrl+Shift+\\', run: () => editor && editor.runAction('editor.action.jumpToBracket') },
      { sep: true },
      { label: 'Следующая проблема', hint: 'F8', run: () => jumpDiagnostic(1) },
      { label: 'Предыдущая проблема', hint: 'Shift+F8', run: () => jumpDiagnostic(-1) }
    ],
    run: [
      { label: 'Запустить / перезапустить игру', hint: 'F5', run: compileAndRun },
      { label: 'Превью на весь экран', hint: 'F11', run: () => togglePreviewFullscreen() },
      { sep: true },
      { label: 'Проверить код (компиляция)', hint: '', run: runDiagnostics },
      { label: 'Сборка и экспорт (HTML / ZIP / EXE)...', hint: 'Ctrl+Shift+B', run: () => openBuildModal() },
      { label: 'Очистить консоль игры', hint: '', run: () => el('btnClearLog').click() }
    ],
    help: [
      { label: 'Все команды...', hint: 'Ctrl+Shift+P', run: () => openCmdPalette('all') },
      { label: `Справочник RoyLang API (${getEngineState().apis.length})`, hint: '', run: () => switchSideView('apis', true) },
      { label: 'Горячие клавиши...', hint: '', run: showShortcutsModal },
      { sep: true },
      { label: 'Проверить обновления...', hint: '', run: () => openUpdateModal() },
      { label: 'О программе RoyStudio Desktop', hint: '', run: showAboutModal }
    ]
  };
}

let activeMenuKey = null;
function closeTopMenu() {
  activeMenuKey = null;
  el('menuDropdown').classList.add('hidden');
  document.querySelectorAll('.menu-btn').forEach(b => b.classList.remove('open'));
}

function openTopMenu(key, anchorEl) {
  const menus = buildMenus();
  const items = menus[key];
  if (!items) return;
  activeMenuKey = key;
  document.querySelectorAll('.menu-btn').forEach(b => b.classList.toggle('open', b.dataset.menu === key));

  const dd = el('menuDropdown');
  dd.innerHTML = items.map((it, idx) => {
    if (it.sep) return '<div class="menu-sep"></div>';
    const check = it.checked ? '✓' : '';
    return `<button class="menu-item" data-idx="${idx}">
      <span class="menu-item-left"><span class="menu-check">${check}</span><span>${escapeHtml(it.label)}</span></span>
      ${it.hint ? `<span class="menu-hint">${escapeHtml(it.hint)}</span>` : ''}
    </button>`;
  }).join('');

  const rect = anchorEl.getBoundingClientRect();
  dd.classList.remove('hidden');
  dd.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  dd.style.top = (rect.bottom + 2) + 'px';

  dd.querySelectorAll('.menu-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = items[Number(btn.dataset.idx)];
      closeTopMenu();
      if (item && item.run) item.run();
    });
  });
}

document.querySelectorAll('.menu-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = btn.dataset.menu;
    if (activeMenuKey === key) closeTopMenu();
    else openTopMenu(key, btn);
  });
  btn.addEventListener('mouseenter', () => {
    if (activeMenuKey && activeMenuKey !== btn.dataset.menu) {
      openTopMenu(btn.dataset.menu, btn);
    }
  });
});
window.addEventListener('click', () => closeTopMenu());

// Bottom tabs & buttons
let previewPaused = false;
const speedSteps = [0.25, 0.5, 1, 2];
let speedIdx = 2;

function renderTelemetryToDebugPane(d) {
  const fpsEl = el('previewFps');
  if (fpsEl && d.fps != null) {
    const ms = d.prof && d.prof.total != null ? ` · ${Number(d.prof.total).toFixed(1)}ms` : '';
    fpsEl.textContent = `${Math.round(Number(d.fps) || 0)} FPS${ms}`;
  }
  const sel = el('dbgSceneSelect');
  if (sel && Array.isArray(d.scenes)) {
    const cur = d.scene || 'main';
    const sig = d.scenes.join('|');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = d.scenes.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    }
    if (sel.value !== cur) sel.value = cur;
  }
  const wt = d.watchTweak || {};
  const tweaks = Array.isArray(wt.tweaks) ? wt.tweaks : (Array.isArray(d.tweaks) ? d.tweaks : []);
  const watches = Array.isArray(wt.watches) ? wt.watches : (Array.isArray(d.watches) ? d.watches : []);
  const badge = el('dbgBadge');
  if (badge) badge.textContent = String(tweaks.length + watches.length);

  const tList = el('tweakList');
  if (tList) {
    if (!tweaks.length) {
      if (!tList.dataset.empty) {
        tList.dataset.empty = '1';
        delete tList.dataset.sig;
        tList.innerHTML = '<div class="muted">Вызови tweak("speed", 200, 50, 500) в игре</div>';
      }
    } else {
      delete tList.dataset.empty;
      const sig = tweaks.map(t => `${t.label}:${t.min}:${t.max}:${t.step}`).join('|');
      if (tList.dataset.sig !== sig) {
        tList.dataset.sig = sig;
        tList.innerHTML = tweaks.map(t => `
          <div class="tweak-row">
            <span title="${escapeHtml(t.label)}">${escapeHtml(t.label)}</span>
            <input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${t.value}" data-tweak="${escapeHtml(t.label)}" />
            <span class="tweak-val">${t.value}</span>
          </div>
        `).join('');
        tList.querySelectorAll('input[data-tweak]').forEach(inp => {
          inp.addEventListener('input', () => {
            const val = Number(inp.value);
            inp.nextElementSibling.textContent = String(val);
            sendStudioCmd(el('previewFrame'), { cmd: 'setTweak', label: inp.dataset.tweak, value: val });
          });
        });
      } else {
        for (const t of tweaks) {
          const inp = Array.from(tList.querySelectorAll('input[data-tweak]')).find(x => x.dataset.tweak === t.label);
          if (inp && document.activeElement !== inp) {
            inp.value = String(t.value);
            if (inp.nextElementSibling) inp.nextElementSibling.textContent = String(t.value);
          }
        }
      }
    }
  }

  const wList = el('watchList');
  if (wList) {
    if (!watches.length) {
      wList.innerHTML = '<div class="muted">Вызови watch("hp", () =&gt; player.hp) в игре</div>';
    } else {
      wList.innerHTML = watches.map(w => `
        <div class="watch-row"><span class="watch-k">${escapeHtml(w.label)}</span><span class="watch-v">${escapeHtml(typeof w.value === 'object' ? JSON.stringify(w.value) : String(w.value))}</span></div>
      `).join('');
    }
  }
}

function renderEntityInspector(d) {
  const box = el('entityInspector');
  if (!box) return;
  const activeTag = document.activeElement;
  if (activeTag && box.contains(activeTag) && (activeTag.tagName === 'INPUT' || activeTag.tagName === 'SELECT')) {
    return;
  }
  const entities = Array.isArray(d.entities) ? d.entities : [];
  const selected = d.selected || null;
  if (!entities.length && !selected) {
    box.innerHTML = '<div class="muted">Сущностей в сцене пока нет</div>';
    return;
  }
  const selIdx = selected ? selected.idx : -1;
  const optsHtml = entities.map((ent, i) => {
    const idx = ent.idx !== undefined ? ent.idx : i;
    const label = ent.tag || ent.name || `ent_${idx}`;
    return `<option value="${idx}" ${idx === selIdx ? 'selected' : ''}>#${idx} ${escapeHtml(label)}</option>`;
  }).join('');

  const props = Array.isArray(selected?.props) ? selected.props : [];
  const propsHtml = props.length
    ? props.map(p => {
        if (p.type === 'boolean') {
          return `<label class="ent-prop-row"><span>${escapeHtml(p.key)}</span><input type="checkbox" data-eprop="${escapeHtml(p.key)}" ${p.val ? 'checked' : ''} /></label>`;
        }
        const inputType = p.type === 'number' ? 'number' : 'text';
        return `<label class="ent-prop-row"><span>${escapeHtml(p.key)}</span><input type="${inputType}" step="any" data-eprop="${escapeHtml(p.key)}" value="${escapeHtml(String(p.val ?? ''))}" /></label>`;
      }).join('')
    : '<div class="muted">Кликните по объекту в игре (🎯)</div>';

  box.innerHTML = `
    <select id="entSelect" class="dbg-select">
      <option value="-1">— Выбрать сущность (${entities.length}) —</option>
      ${optsHtml}
    </select>
    ${propsHtml}
  `;
  el('entSelect')?.addEventListener('change', (ev) => {
    sendStudioCmd(el('previewFrame'), { cmd: 'selectEntity', idx: Number(ev.target.value) });
  });
  box.querySelectorAll('[data-eprop]').forEach(inp => {
    const evName = inp.type === 'checkbox' ? 'change' : 'input';
    inp.addEventListener(evName, () => {
      const value = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? Number(inp.value) : inp.value);
      sendStudioCmd(el('previewFrame'), { cmd: 'setProp', key: inp.dataset.eprop, value });
    });
  });
}

window.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.__royLog) {
    addLog(e.data.text, e.data.kind);
  } else if (e.data.type === 'roystudio-console') {
    const lvl = e.data.level === 'error' ? 'err' : e.data.level === 'warn' ? 'warn' : 'info';
    addLog(e.data.text, lvl);
  } else if (e.data.type === 'roystudio-action' && e.data.action === 'rerun') {
    compileAndRun();
  } else if (e.data.type === 'roystudio-telemetry') {
    renderTelemetryToDebugPane(e.data);
  } else if (e.data.type === 'roystudio-inspector') {
    renderEntityInspector(e.data);
  } else if (e.data.type === 'roystudio-error') {
    addCrashReport(e.data);
  } else if (e.data.type === 'roystudio-eval-result') {
    if (e.data.ok) addLog(`<= ${typeof e.data.value === 'string' ? e.data.value : JSON.stringify(e.data.value)}`, 'info');
    else addLog(`<= Ошибка: ${e.data.error}`, 'err');
  } else if (e.data.type === 'roystudio-hot-code-ack') {
    if (e.data.ok) addLog(`Hot-Code Swap OK (сцена: ${e.data.scene}, сущностей: ${e.data.entities})`, 'info');
    else { addLog(`Hot-Code Swap откат (${e.data.error}), полный перезапуск...`, 'warn'); compileAndRun(); }
  } else if (e.data.type === 'roystudio-hot-ack') {
    addLog(`Hot Reload данных: ${e.data.path}`, 'info');
  } else if (e.data.type === 'roystudio-state-ack') {
    addLog(`${e.data.op === 'save' ? 'Quick Save' : 'Quick Load'}: ${e.data.ok ? 'OK' : (e.data.error || 'ошибка')}`, e.data.ok ? 'info' : 'warn');
  }
});
document.querySelectorAll('.btab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btab').forEach(b => b.classList.toggle('active', b === btn));
    el('problemsPane').classList.toggle('hidden', btn.dataset.tab !== 'problems');
    el('consolePane').classList.toggle('hidden', btn.dataset.tab !== 'console');
    el('debugPane')?.classList.toggle('hidden', btn.dataset.tab !== 'debug');
  });
});
el('btnClearLog').addEventListener('click', () => {
  state.logs = [];
  el('logCount').textContent = '0';
  if (el('consoleLogs')) el('consoleLogs').innerHTML = '';
});

async function handleOpenFolder() {
  try {
    const proj = await fsBridge.openFolder();
    if (proj) loadProjectState(proj);
  } catch (err) {
    addLog(err.message || String(err), 'err');
  }
}

el('btnNavBack').addEventListener('click', () => navTabHistory(-1));
el('btnNavForward').addEventListener('click', () => navTabHistory(1));
el('btnToggleSidebar').addEventListener('click', () => toggleSidebar());
el('btnSideOpen').addEventListener('click', handleOpenFolder);
el('btnSideNew').addEventListener('click', () => startInlineCreate('new-file', ''));
el('btnTreeNewFile').addEventListener('click', () => startInlineCreate('new-file', ''));
el('btnTreeNewDir').addEventListener('click', () => startInlineCreate('new-dir', ''));
el('btnTreeRefresh').addEventListener('click', refreshFromDisk);
el('btnTreeCollapse').addEventListener('click', () => {
  state.allDirs.forEach(d => state.collapsedDirs.add(d));
  renderTree();
});
el('btnGitRefresh').addEventListener('click', renderGitPane);
el('btnRunPanelStart').addEventListener('click', compileAndRun);
el('btnRunPanelFullscreen').addEventListener('click', togglePreviewFullscreen);
el('btnRunPanelExport').addEventListener('click', () => openBuildModal());
el('btnRun').addEventListener('click', compileAndRun);
el('btnReloadPreview').addEventListener('click', compileAndRun);
el('btnFullscreenPreview').addEventListener('click', togglePreviewFullscreen);
el('btnBuildModal').addEventListener('click', () => openBuildModal());
el('btnRecentClear')?.addEventListener('click', () => { localStorage.removeItem(RECENT_KEY); renderRecent(); });

el('btnCloseBuild').addEventListener('click', closeBuildModal);
el('buildModal').addEventListener('click', (e) => { if (e.target === el('buildModal')) closeBuildModal(); });
document.querySelectorAll('#buildTargets .bld-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    buildModalTarget = btn.dataset.target;
    syncBuildTargetUi();
  });
});
el('btnPickOutDir').addEventListener('click', async () => {
  const picked = await fsBridge.pickDirectory('Выберите папку вывода сборки');
  if (picked) el('bldOutDir').value = picked;
});
el('btnPickBuildIcon').addEventListener('click', async () => {
  const picked = await fsBridge.pickIconFile();
  if (picked) el('bldIcon').value = picked;
});
el('btnStartBuild').addEventListener('click', runBuildPipeline);
el('btnOpenBuildDir').addEventListener('click', () => {
  if (lastBuildDirPath) fsBridge.openInExplorer(lastBuildDirPath);
});

// =====================================================================
// Two-Level Updater UI (Level 1: IDE + Level 2: RoyLang Engine)
// =====================================================================
const updState = {
  appVersion: '1.0.0',
  ide: null,
  ideError: '',
  releases: [],
  releasesError: '',
  installed: { active: null, engines: [] },
  selectedTag: null,
  checking: false,
  busy: false
};

function syncEngineBadges(eng = getEngineState()) {
  const ver = eng.version || eng.tag || 'v6.5';
  const badge = el('engineVer');
  if (badge) badge.textContent = eng.isBuiltin ? ver : `${eng.tag}`;
  const sbLang = document.querySelector('.sb-lang');
  if (sbLang) sbLang.textContent = `RoyLang ${ver}`;
  const activeLbl = el('updEngActive');
  if (activeLbl) {
    activeLbl.textContent = eng.isBuiltin
      ? `${ver} (встроенный)`
      : `${eng.tag} ${eng.hasCustomDocs ? '(установлен + docs)' : '(установлен, built-in docs)'}`;
  }
  updateRoyLanguageMeta(eng);
  renderApiList(el('searchApiInput')?.value || '');
}

onEngineChange((eng) => {
  syncEngineBadges(eng);
  if (editor) {
    runDiagnostics();
    compileAndRun();
  }
});

function updateStatusbarUpdateBadge() {
  const btn = el('sbUpdateBtn');
  if (!btn) return;
  const ideAvail = Boolean(updState.ide?.available);
  const curEng = getEngineState().version || 'v6.5';
  const newestEng = updState.releases[0]?.tag || '';
  const engAvail = Boolean(newestEng && compareSemver(newestEng, curEng) > 0);

  if (ideAvail || engAvail) {
    const parts = [];
    if (ideAvail) parts.push(`IDE v${updState.ide.latest_version}`);
    if (engAvail) parts.push(`RoyLang ${newestEng}`);
    btn.classList.add('has-update');
    btn.textContent = `⬆ Обновление: ${parts[0]}`;
    btn.title = `Доступны обновления: ${parts.join(', ')}`;
  } else {
    btn.classList.remove('has-update');
    btn.textContent = '⟳ Обновления';
    btn.title = `Актуально: IDE v${updState.appVersion} · RoyLang ${curEng}`;
  }
}

function setEngProgress(visible, pct = 0, text = '') {
  const wrap = el('updEngProgWrap');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !visible);
  if (el('updEngProgFill')) el('updEngProgFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (el('updEngProgText')) el('updEngProgText').textContent = text;
}

function setIdeProgress(visible, pct = 0, text = '') {
  const wrap = el('updIdeProgWrap');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !visible);
  if (el('updIdeProgFill')) el('updIdeProgFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (el('updIdeProgText')) el('updIdeProgText').textContent = text;
}

function renderUpdaterModal() {
  const curEng = getEngineState();
  syncEngineBadges(curEng);
  if (el('updIdeCur')) el('updIdeCur').textContent = `v${updState.appVersion}`;

  const btnCheck = el('btnCheckUpdatesNow');
  if (btnCheck) btnCheck.disabled = updState.checking || updState.busy;

  // Level 1 IDE Card
  const ideStatus = el('updIdeStatus');
  const btnIde = el('btnIdeUpdate');
  const ideNotes = el('updIdeNotes');
  if (updState.checking && !updState.ide) {
    ideStatus.textContent = 'Проверка обновлений RoyStudio Desktop...';
    btnIde.disabled = true;
    btnIde.textContent = 'Проверка...';
    ideNotes.classList.add('hidden');
  } else if (updState.ide?.available) {
    ideStatus.innerHTML = `<span style="color:#34d399;font-weight:700">Доступна новая версия IDE: v${escapeHtml(updState.ide.latest_version)}</span> (установлена v${escapeHtml(updState.appVersion)})`;
    btnIde.disabled = updState.busy;
    btnIde.textContent = '⬇ Обновить и перезапустить';
    if (updState.ide.notes) {
      ideNotes.textContent = updState.ide.notes;
      ideNotes.classList.remove('hidden');
    } else {
      ideNotes.classList.add('hidden');
    }
  } else if (updState.ide && !updState.ide.pubkey_configured) {
    ideStatus.textContent = updState.ide.message || 'Ключ подписи (pubkey) ещё не настроен в tauri.conf.json.';
    btnIde.disabled = true;
    btnIde.textContent = 'Не настроено';
    if (updState.ide.notes) {
      ideNotes.textContent = `Последний релиз GitHub (${updState.ide.latest_version || ''}):\n${updState.ide.notes}`;
      ideNotes.classList.remove('hidden');
    } else {
      ideNotes.classList.add('hidden');
    }
  } else if (updState.ideError) {
    ideStatus.textContent = updState.ideError.includes('404') || updState.ideError.toLowerCase().includes('latest.json')
      ? `У вас актуальная локальная сборка v${updState.appVersion} (опубликованный latest.json пока не найден).`
      : `Не удалось проверить обновления IDE: ${updState.ideError}`;
    btnIde.disabled = updState.checking || updState.busy;
    btnIde.textContent = 'Повторить';
    ideNotes.classList.add('hidden');
  } else {
    ideStatus.innerHTML = `<span style="color:#34d399">✔ У вас последняя версия RoyStudio Desktop (v${escapeHtml(updState.appVersion)})</span>`;
    btnIde.disabled = updState.checking || updState.busy;
    btnIde.textContent = 'Актуально';
    ideNotes.classList.add('hidden');
  }

  // Level 2 Engine List (merge remote + locally cached, semver desc)
  const byTag = new Map();
  for (const r of updState.releases) {
    byTag.set(r.tag, { ...r });
  }
  for (const loc of (updState.installed?.engines || [])) {
    if (!byTag.has(loc.tag)) {
      byTag.set(loc.tag, {
        tag: loc.tag,
        title: `RoyLang ${loc.tag} (локальный кэш)`,
        body: '',
        published_at: '',
        html_url: '',
        is_release: false
      });
    }
  }
  const merged = sortSemverDesc(Array.from(byTag.values()), r => r.tag);
  const installedMap = new Map((updState.installed?.engines || []).map(e => [e.tag, e]));
  const activeInstalledTag = updState.installed?.active || null;

  if (!updState.selectedTag || !merged.some(r => r.tag === updState.selectedTag)) {
    updState.selectedTag = activeInstalledTag || merged[0]?.tag || null;
  }

  const listEl = el('updEngList');
  if (!merged.length) {
    listEl.innerHTML = updState.checking
      ? '<div class="muted" style="padding:8px">Загрузка релизов RoyWals/RoyLang...</div>'
      : `<div class="muted" style="padding:8px">${escapeHtml(updState.releasesError || 'Не удалось загрузить теги RoyWals/RoyLang. Нажмите «Проверить сейчас».')}</div>`;
  } else {
    listEl.innerHTML = merged.map(rel => {
      const loc = installedMap.get(rel.tag);
      const isAct = activeInstalledTag === rel.tag && !curEng.isBuiltin;
      const isSel = updState.selectedTag === rel.tag;
      const dateStr = rel.published_at ? rel.published_at.slice(0, 10) : (rel.is_release ? 'Release' : 'Git tag');
      const subText = loc
        ? `${dateStr} · ${(loc.size_bytes / 1024).toFixed(0)} КБ · ${loc.has_docs ? '+docs' : 'built-in docs'}`
        : `${dateStr} · ${rel.title || 'GitHub'}`;
      return `<div class="upd-eng-row ${isSel ? 'selected' : ''}" data-tag="${escapeHtml(rel.tag)}">
        <div class="upd-eng-meta">
          <div class="upd-eng-tag">
            <span>${escapeHtml(rel.tag)}</span>
            ${isAct ? '<span class="upd-pill act">Активна</span>' : ''}
            ${loc ? '<span class="upd-pill loc">Скачана</span>' : ''}
            ${rel.is_release ? '<span class="upd-pill rel">Release</span>' : ''}
          </div>
          <div class="upd-eng-sub">${escapeHtml(subText)}</div>
        </div>
        <div class="upd-eng-btns">
          ${loc && !isAct ? `<button data-eng-act="use" data-tag="${escapeHtml(rel.tag)}">Применить</button>` : ''}
          <button data-eng-act="dl" data-tag="${escapeHtml(rel.tag)}" class="${!loc ? 'primary' : ''}">${loc ? '↻' : 'Установить'}</button>
          ${loc && !isAct ? `<button data-eng-act="del" data-tag="${escapeHtml(rel.tag)}" title="Удалить кэш">🗑</button>` : ''}
        </div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.upd-eng-row').forEach(row => {
      row.addEventListener('click', () => {
        updState.selectedTag = row.dataset.tag;
        renderUpdaterModal();
      });
    });
    listEl.querySelectorAll('button[data-eng-act]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (updState.busy) return;
        const act = b.dataset.engAct;
        const tag = b.dataset.tag;
        if (act === 'dl') handleDownloadAndActivateEngine(tag);
        else if (act === 'use') handleActivateInstalledEngine(tag);
        else if (act === 'del') handleDeleteInstalledEngine(tag);
      });
    });
  }

  const selRel = merged.find(r => r.tag === updState.selectedTag);
  const notesTitle = el('updEngNotesTitle');
  const notesBody = el('updEngNotes');
  if (selRel) {
    notesTitle.textContent = selRel.title ? `${selRel.tag} — ${selRel.title}` : `RoyLang ${selRel.tag}`;
    if (selRel.body && selRel.body.trim()) {
      notesBody.textContent = selRel.body;
    } else if (!selRel.is_release) {
      notesBody.textContent = `Тег ${selRel.tag} из репозитория RoyWals/RoyLang (описание changelog не оформлено).\nПри установке скачаются доступные файлы (roylang.js, roy-gamepad.js, roylang-docs.js), при отсутствии roylang-docs.js используются встроенные справки и парсеры .royson/.royproj.`;
    } else {
      notesBody.textContent = 'Описание изменений не указано.';
    }
  } else {
    notesTitle.textContent = 'Changelog (GitHub Releases)';
    notesBody.textContent = updState.releasesError || 'Выберите версию слева.';
  }

  if (el('btnEngResetBuiltin')) {
    el('btnEngResetBuiltin').disabled = updState.busy || curEng.isBuiltin;
  }
}

async function refreshAllUpdates(silent = false) {
  if (updState.checking) return;
  updState.checking = true;
  updState.ideError = '';
  updState.releasesError = '';
  if (!silent) renderUpdaterModal();
  try {
    const [verRes, ideRes, relRes, instRes] = await Promise.allSettled([
      fsBridge.getAppVersion(),
      fsBridge.checkIdeUpdate(),
      fsBridge.fetchRoylangReleases(),
      fsBridge.listInstalledEngines()
    ]);

    if (verRes.status === 'fulfilled' && verRes.value) updState.appVersion = verRes.value;
    if (ideRes.status === 'fulfilled') {
      updState.ide = ideRes.value;
    } else {
      updState.ide = null;
      updState.ideError = ideRes.reason?.message || String(ideRes.reason || 'Ошибка сети');
    }
    if (relRes.status === 'fulfilled' && Array.isArray(relRes.value)) {
      updState.releases = sortSemverDesc(relRes.value, r => r.tag);
    } else if (relRes.status === 'rejected') {
      updState.releasesError = relRes.reason?.message || String(relRes.reason || 'Нет связи с GitHub');
    }
    if (instRes.status === 'fulfilled' && instRes.value) {
      updState.installed = instRes.value;
    }
  } finally {
    updState.checking = false;
    updateStatusbarUpdateBadge();
    if (!el('updateModal').classList.contains('hidden')) {
      renderUpdaterModal();
    }
  }
}

async function handleActivateInstalledEngine(tag) {
  if (updState.busy) return;
  updState.busy = true;
  renderUpdaterModal();
  try {
    setEngProgress(true, 60, `Активация ${tag}...`);
    const bundle = await fsBridge.readInstalledEngine(tag);
    const loaded = await loadEngineFromBundle(tag, bundle.roylang_js, bundle.roylang_docs_js);
    await fsBridge.setActiveEngine(tag);
    updState.installed = await fsBridge.listInstalledEngines();
    updState.selectedTag = tag;
    addLog(`Движок переключён на RoyLang ${loaded.version} (${loaded.apis.length} API)`, 'info');
  } catch (err) {
    addLog(`Не удалось загрузить движок ${tag}: ${err.message || err}`, 'err');
  } finally {
    updState.busy = false;
    setEngProgress(false);
    updateStatusbarUpdateBadge();
    renderUpdaterModal();
  }
}

async function handleDownloadAndActivateEngine(tag) {
  if (updState.busy) return;
  updState.busy = true;
  updState.selectedTag = tag;
  renderUpdaterModal();
  try {
    setEngProgress(true, 10, `Скачивание ${tag}...`);
    let bundle;
    if (isTauriEnv()) {
      await fsBridge.downloadRoylangEngine(tag);
      setEngProgress(true, 92, `Проверка ${tag}...`);
      bundle = await fsBridge.readInstalledEngine(tag);
    } else {
      bundle = await fsBridge.downloadWebEngineBundle(tag);
    }
    const loaded = await loadEngineFromBundle(tag, bundle.roylang_js, bundle.roylang_docs_js);
    await fsBridge.setActiveEngine(tag);
    updState.installed = await fsBridge.listInstalledEngines();
    setEngProgress(true, 100, `Готово: ${loaded.version}`);
    addLog(`Установлен и активирован RoyLang ${loaded.version} (${loaded.apis.length} API${loaded.hasCustomDocs ? ', +roylang-docs.js' : ''})`, 'info');
  } catch (err) {
    addLog(`Ошибка обновления движка ${tag}: ${err.message || err}`, 'err');
    if (el('updEngNotesTitle')) el('updEngNotesTitle').textContent = `Ошибка загрузки ${tag}`;
    if (el('updEngNotes')) el('updEngNotes').textContent = String(err.message || err);
  } finally {
    updState.busy = false;
    setTimeout(() => setEngProgress(false), 650);
    updateStatusbarUpdateBadge();
    renderUpdaterModal();
  }
}

async function handleDeleteInstalledEngine(tag) {
  if (updState.busy) return;
  updState.busy = true;
  try {
    await fsBridge.deleteInstalledEngine(tag);
    updState.installed = await fsBridge.listInstalledEngines();
    addLog(`Удалён кэш движка ${tag}`, 'info');
  } catch (err) {
    addLog(`Ошибка удаления ${tag}: ${err.message || err}`, 'err');
  } finally {
    updState.busy = false;
    renderUpdaterModal();
  }
}

async function handleResetBuiltinEngine() {
  if (updState.busy) return;
  updState.busy = true;
  try {
    await fsBridge.setActiveEngine(null);
    const eng = resetToBuiltin();
    updState.installed = await fsBridge.listInstalledEngines();
    addLog(`Возврат к встроенному движку RoyLang ${eng.version}`, 'info');
  } catch (err) {
    addLog(`Ошибка сброса движка: ${err.message || err}`, 'err');
  } finally {
    updState.busy = false;
    updateStatusbarUpdateBadge();
    renderUpdaterModal();
  }
}

async function handleInstallIdeUpdate() {
  if (updState.busy) return;
  if (!updState.ide?.available) {
    await refreshAllUpdates(false);
    return;
  }
  updState.busy = true;
  renderUpdaterModal();
  setIdeProgress(true, 5, 'Подготовка загрузки...');
  try {
    await fsBridge.installIdeUpdate();
  } catch (err) {
    setIdeProgress(false);
    updState.ideError = err.message || String(err);
    addLog(`Ошибка обновления IDE: ${updState.ideError}`, 'err');
  } finally {
    updState.busy = false;
    renderUpdaterModal();
  }
}

function openUpdateModal() {
  closeTopMenu();
  el('updateModal').classList.remove('hidden');
  renderUpdaterModal();
  if (!updState.checking && (!updState.releases.length || !updState.ide)) {
    refreshAllUpdates(false);
  }
}

function closeUpdateModal() {
  el('updateModal').classList.add('hidden');
}

el('engineVer').addEventListener('click', openUpdateModal);
el('sbUpdateBtn').addEventListener('click', openUpdateModal);
el('btnCloseUpdate').addEventListener('click', closeUpdateModal);
el('btnCheckUpdatesNow').addEventListener('click', () => refreshAllUpdates(false));
el('btnIdeUpdate').addEventListener('click', handleInstallIdeUpdate);
el('btnEngResetBuiltin').addEventListener('click', handleResetBuiltinEngine);
el('updateModal').addEventListener('click', (e) => { if (e.target === el('updateModal')) closeUpdateModal(); });

window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (el('previewCol').classList.contains('is-fullscreen')) setPreviewFullscreen(false);
    closeTopMenu();
    closeInfoModal();
    closeBuildModal();
    closeUpdateModal();
    closeCmdPalette();
    return;
  }
  if (e.code === 'F5' || e.key === 'F5') { e.preventDefault(); compileAndRun(); return; }
  if (e.code === 'F11') { e.preventDefault(); togglePreviewFullscreen(); return; }
  if (e.code === 'F8') { e.preventDefault(); jumpDiagnostic(e.shiftKey ? -1 : 1); return; }
  if (e.altKey && !ctrl && e.code === 'ArrowLeft') { e.preventDefault(); navTabHistory(-1); return; }
  if (e.altKey && !ctrl && e.code === 'ArrowRight') { e.preventDefault(); navTabHistory(1); return; }
  if (e.altKey && !ctrl && !e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); if (editor) editor.toggleWordWrap(); return; }
  if (!ctrl) return;

  if (e.shiftKey && e.code === 'KeyP') { e.preventDefault(); openCmdPalette('all'); }
  else if (!e.shiftKey && e.code === 'KeyP') { e.preventDefault(); openCmdPalette('files'); }
  else if (e.shiftKey && e.code === 'KeyB') { e.preventDefault(); openBuildModal(); }
  else if (e.shiftKey && e.code === 'KeyS') { e.preventDefault(); saveAllFiles(); }
  else if (!e.shiftKey && e.code === 'KeyS') { e.preventDefault(); saveActiveFile(); }
  else if (!e.shiftKey && e.code === 'KeyO') { e.preventDefault(); handleOpenFolder(); }
  else if (!e.shiftKey && e.code === 'KeyN') { e.preventDefault(); switchSideView('explorer', true); startInlineCreate('new-file', ''); }
  else if (!e.shiftKey && e.code === 'KeyW') { e.preventDefault(); if (state.activeFile) closeTab(state.activeFile); }
  else if (!e.shiftKey && e.code === 'KeyB') { e.preventDefault(); toggleSidebar(); }
  else if (e.shiftKey && e.code === 'KeyF') { e.preventDefault(); switchSideView('search', true); }
  else if (e.shiftKey && e.code === 'KeyE') { e.preventDefault(); switchSideView('explorer', true); }
  else if (e.shiftKey && e.code === 'KeyG') { e.preventDefault(); switchSideView('git', true); }
  else if (e.shiftKey && e.code === 'KeyD') { e.preventDefault(); switchSideView('run', true); }
  else if (e.shiftKey && e.code === 'KeyM') { e.preventDefault(); toggleBottomPanel(true); document.querySelector('.btab[data-tab="problems"]').click(); }
  else if (e.code === 'Backslash') { e.preventDefault(); toggleSplitEditor(); }
  else if (e.code === 'Backquote') { e.preventDefault(); toggleBottomPanel(); }
});

// === Preview Controls, Debug Pane, REPL, Tests, Split View, Welcome Screen ===
let inspectModeOn = false;
el('btnInspectMode')?.addEventListener('click', () => {
  inspectModeOn = !inspectModeOn;
  el('btnInspectMode').classList.toggle('is-active', inspectModeOn);
  sendStudioCmd(el('previewFrame'), { cmd: 'inspectMode', enabled: inspectModeOn });
  if (inspectModeOn) {
    toggleBottomPanel(true);
    document.querySelector('.btab[data-tab="debug"]')?.click();
  }
});

el('previewPreset')?.addEventListener('change', (e) => {
  const vp = el('previewViewport');
  if (!vp) return;
  vp.classList.remove('preset-auto', 'preset-16x9', 'preset-9x16', 'preset-4x3');
  const map = { 'auto': 'preset-auto', '16:9': 'preset-16x9', '9:16': 'preset-9x16', '4:3': 'preset-4x3' };
  vp.classList.add(map[e.target.value] || 'preset-auto');
});

el('btnPreviewPause')?.addEventListener('click', () => {
  previewPaused = !previewPaused;
  el('btnPreviewPause').classList.toggle('is-active', previewPaused);
  el('btnPreviewPause').textContent = previewPaused ? '▶' : '⏸';
  sendStudioCmd(el('previewFrame'), { cmd: previewPaused ? 'pause' : 'resume' });
});
el('btnPreviewStep')?.addEventListener('click', () => {
  previewPaused = true;
  el('btnPreviewPause')?.classList.add('is-active');
  if (el('btnPreviewPause')) el('btnPreviewPause').textContent = '▶';
  sendStudioCmd(el('previewFrame'), { cmd: 'step', frames: 1 });
});
el('btnPreviewSpeed')?.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % speedSteps.length;
  const val = speedSteps[speedIdx];
  el('btnPreviewSpeed').textContent = `${val}x`;
  sendStudioCmd(el('previewFrame'), { cmd: 'timeScale', value: val });
});
el('btnQuickSave')?.addEventListener('click', () => sendStudioCmd(el('previewFrame'), { cmd: 'saveState', slot: 'quick' }));
el('btnQuickLoad')?.addEventListener('click', () => sendStudioCmd(el('previewFrame'), { cmd: 'loadState', slot: 'quick' }));
el('btnScreenshot')?.addEventListener('click', async () => {
  try {
    const win = el('previewFrame')?.contentWindow;
    const canvas = win?.document?.getElementById('royCanvas') || win?.document?.querySelector('canvas');
    if (!canvas) { addLog('Canvas не найден для скриншота', 'warn'); return; }
    const dataUrl = canvas.toDataURL('image/png');
    const fileName = `screenshot-${Date.now()}.png`;
    if (isTauriEnv()) {
      const outPath = await fsBridge.pickSaveFile(fileName, 'PNG Image', 'png');
      if (!outPath) return;
      const b64 = dataUrl.split(',')[1];
      await fsBridge.writeBase64Absolute(outPath, b64);
      addLog(`Скриншот сохранён: ${outPath}`, 'info');
    } else {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = fileName;
      a.click();
      addLog('Скриншот кадра сохранён', 'info');
    }
  } catch (err) {
    addLog(`Ошибка скриншота: ${err.message || err}`, 'err');
  }
});

document.querySelectorAll('input[data-dl]').forEach(chk => {
  chk.addEventListener('change', () => {
    const flags = {};
    document.querySelectorAll('input[data-dl]').forEach(c => { flags[c.dataset.dl] = c.checked; });
    sendStudioCmd(el('previewFrame'), { cmd: 'debugLayers', flags });
    if (chk.dataset.dl === 'fps') sendStudioCmd(el('previewFrame'), { cmd: 'debugOverlay', enabled: chk.checked });
  });
});
el('dbgSceneSelect')?.addEventListener('change', (e) => {
  if (e.target.value) sendStudioCmd(el('previewFrame'), { cmd: 'gotoScene', scene: e.target.value });
});

const replHistory = [];
let replHistIdx = 0;
let replEvalSeq = 1;
el('replInput')?.addEventListener('keydown', (e) => {
  const inp = e.target;
  if (e.key === 'Enter') {
    const code = inp.value.trim();
    if (!code) return;
    replHistory.push(code);
    replHistIdx = replHistory.length;
    addLog(`> ${code}`, 'info');
    sendStudioCmd(el('previewFrame'), { cmd: 'eval', id: replEvalSeq++, code });
    inp.value = '';
  } else if (e.key === 'ArrowUp') {
    if (replHistIdx > 0) { replHistIdx--; inp.value = replHistory[replHistIdx] || ''; e.preventDefault(); }
  } else if (e.key === 'ArrowDown') {
    if (replHistIdx < replHistory.length - 1) { replHistIdx++; inp.value = replHistory[replHistIdx] || ''; }
    else { replHistIdx = replHistory.length; inp.value = ''; }
    e.preventDefault();
  }
});

el('btnRunTests')?.addEventListener('click', () => {
  const pane = el('testResultsPane');
  const royFiles = getRoyOnlyFiles();
  const entry = pickEntryFile();
  if (!entry || !royFiles[entry]) {
    if (pane) pane.innerHTML = '<div class="test-row fail">Нет .roy файла для запуска тестов</div>';
    return;
  }
  try {
    const compiled = RoyLang.compile(royFiles[entry], royFiles, entry);
    const results = [];
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.sandbox = 'allow-scripts allow-same-origin';
    document.body.appendChild(frame);
    const logs = [];
    const onMsg = (ev) => {
      if (ev.source !== frame.contentWindow || !ev.data) return;
      if (ev.data.type === 'roystudio-console') logs.push({ level: ev.data.level, text: String(ev.data.text || '') });
    };
    window.addEventListener('message', onMsg);
    const html = RoyLang.compileToHtml(royFiles[entry], { title: 'RoyTestRunner' }, royFiles, entry);
    frame.srcdoc = html;
    setTimeout(() => {
      window.removeEventListener('message', onMsg);
      frame.remove();
      for (const l of logs) {
        const isPass = /PASS|OK|✓|успешно|passed/i.test(l.text);
        const isFail = l.level === 'error' || /FAIL|ERROR|✗|ошибка|failed/i.test(l.text);
        if (isPass || isFail || /test|sim|monteCarlo/i.test(l.text)) {
          results.push({ pass: !isFail, text: l.text });
        }
      }
      if (!results.length) {
        results.push({ pass: true, text: `Компиляция и старт "${entry}" прошли без ошибок (${compiled.warnings?.length || 0} преды). Добавь test() или sim.run() для отчёта.` });
      }
      if (pane) {
        pane.innerHTML = results.map(r => `<div class="test-row ${r.pass ? 'pass' : 'fail'}">${r.pass ? '✓' : '✗'} ${escapeHtml(r.text)}</div>`).join('');
      }
      addLog(`Тесты/симуляции (${entry}): ${results.filter(r => r.pass).length} pass, ${results.filter(r => !r.pass).length} fail`, results.some(r => !r.pass) ? 'err' : 'info');
    }, 650);
  } catch (err) {
    if (pane) pane.innerHTML = `<div class="test-row fail">✗ ${escapeHtml(err.message || String(err))}</div>`;
  }
});

let secondaryEditor = null;
let splitFilePath = null;
function refreshSplitFileSelect() {
  const sel = el('splitFileSelect');
  if (!sel) return;
  const files = Object.keys(state.textFiles).sort();
  sel.innerHTML = files.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  if (!splitFilePath || state.textFiles[splitFilePath] == null) {
    splitFilePath = files.find(f => f !== state.activeFile) || files[0] || null;
  }
  if (splitFilePath) sel.value = splitFilePath;
}
async function openSplitFile(path) {
  splitFilePath = path;
  if (!secondaryEditor || path == null || state.textFiles[path] == null) return;
  secondaryEditor.setLanguage(detectMonacoLang(path));
  secondaryEditor.setValue(state.textFiles[path]);
}
async function toggleSplitEditor(forceState = null) {
  const right = el('editorRightPane');
  const btn = el('btnToggleSplit');
  if (!right) return;
  const open = forceState !== null ? forceState : right.classList.contains('hidden');
  right.classList.toggle('hidden', !open);
  btn?.classList.toggle('active', open);
  if (open) {
    el('welcomeScreen')?.classList.add('hidden');
    el('editorSplitWrap')?.classList.remove('hidden');
    refreshSplitFileSelect();
    if (!secondaryEditor) {
      secondaryEditor = await createSecondaryEditor(el('editorHostRight'), {
        onChange: (val) => {
          if (!splitFilePath || state.textFiles[splitFilePath] == null) return;
          state.textFiles[splitFilePath] = val;
          state.dirty.add(splitFilePath);
          if (splitFilePath === state.activeFile && editor) editor.setValue(val);
          renderTree();
          renderTabs();
        },
        onSave: saveAllFiles,
        onRun: compileAndRun
      });
    }
    if (splitFilePath) openSplitFile(splitFilePath);
  }
}
el('btnToggleSplit')?.addEventListener('click', () => toggleSplitEditor());
el('btnCloseSplit')?.addEventListener('click', () => toggleSplitEditor(false));
el('splitFileSelect')?.addEventListener('change', (e) => openSplitFile(e.target.value));

async function createProjectFromTemplate(tpl) {
  let targetDir = null;
  if (isTauriEnv()) {
    targetDir = await fsBridge.pickDirectory(`Выберите папку для проекта "${tpl.title}"`).catch(() => null);
  }
  el('welcomeScreen')?.classList.add('hidden');
  el('editorSplitWrap')?.classList.remove('hidden');

  if (targetDir) {
    try { localStorage.removeItem(getSessionKey(targetDir)); } catch {}
    await fsBridge.openFolderPath(targetDir);
    for (const [rel, txt] of Object.entries(tpl.files)) {
      await fsBridge.writeFile(rel, txt);
    }
    const proj = await fsBridge.openFolderPath(targetDir);
    if (proj) {
      loadProjectState(proj, { skipSessionRestore: true, skipDefaultOpen: true });
      openFile(state.textFiles['main.roy'] != null ? 'main.roy' : Object.keys(state.textFiles)[0]);
      compileAndRun();
      addLog(`Создан проект по шаблону "${tpl.title}"`, 'info');
      return;
    }
  }
  try { localStorage.removeItem(getSessionKey(null)); } catch {}
  const files = Object.keys(tpl.files).sort();
  loadProjectState({
    name: tpl.title.replace(/^[^\s]+\s*/, ''),
    rootPath: null,
    files,
    dirs: [],
    textFiles: { ...tpl.files },
    assetUrls: {},
    assetBase64: {}
  }, { skipSessionRestore: true, skipDefaultOpen: true });
  openFile(state.textFiles['main.roy'] != null ? 'main.roy' : files[0]);
  compileAndRun();
  addLog(`Открыт шаблон "${tpl.title}"`, 'info');
}

function showWelcomeScreen() {
  const ws = el('welcomeScreen');
  if (!ws) return;
  el('imageViewer')?.classList.add('hidden');
  el('editorSplitWrap')?.classList.add('hidden');
  ws.classList.remove('hidden');

  const recent = readRecent();
  ws.innerHTML = `
    <div class="welcome-hero">
      <h2>◆ RoyStudio Desktop · RoyLang ${escapeHtml(RoyLang.VERSION || 'v6.9')}</h2>
      <p>Выберите готовый шаблон, откройте папку проекта (или перетащите её прямо в окно) либо продолжите недавний проект.</p>
    </div>
    <div class="welcome-grid">
      ${PROJECT_TEMPLATES.map(t => `
        <button class="tpl-card" data-tpl="${t.id}">
          <strong>${escapeHtml(t.title)}</strong>
          <span>${escapeHtml(t.desc)}</span>
        </button>
      `).join('')}
    </div>
    <div class="welcome-actions">
      <button id="wsOpenFolder" class="primary">📂 Открыть папку проекта</button>
      <button id="wsBackToEditor">📝 Вернуться в редактор</button>
    </div>
    <div class="welcome-recent">
      <h3>Недавние проекты</h3>
      <div class="welcome-recent-list">
        ${recent.length ? recent.slice(0, 8).map((r, i) => `
          <button class="welcome-recent-item" data-ridx="${i}">
            <span>📁 ${escapeHtml(r.name || r.rootPath)}</span>
            <span class="muted">${escapeHtml(r.rootPath || '')}</span>
          </button>
        `).join('') : '<div class="muted">Недавних проектов пока нет.</div>'}
      </div>
    </div>
  `;
  ws.querySelectorAll('.tpl-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const tpl = PROJECT_TEMPLATES.find(t => t.id === btn.dataset.tpl);
      if (tpl) createProjectFromTemplate(tpl);
    });
  });
  el('wsOpenFolder')?.addEventListener('click', handleOpenFolder);
  el('wsBackToEditor')?.addEventListener('click', () => {
    ws.classList.add('hidden');
    el('editorSplitWrap')?.classList.remove('hidden');
  });
  ws.querySelectorAll('.welcome-recent-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = recent[Number(btn.dataset.ridx)];
      if (r && r.rootPath) {
        const proj = await fsBridge.openFolderPath(r.rootPath).catch(() => null);
        if (proj) loadProjectState(proj);
      }
    });
  });
}
el('btnWelcomeTab')?.addEventListener('click', showWelcomeScreen);

async function openLaunchFilePath(launchFile) {
  if (!launchFile) return false;
  try {
    const ext = getExt(launchFile);
    const projectRoot = await fsBridge.getParentDir(launchFile);
    let proj = await fsBridge.openFolderPath(projectRoot).catch(() => null);
    const baseName = launchFile.split(/[\\/]/).pop();
    let rel = projectRoot
      ? launchFile.slice(projectRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      : baseName;
    if (!rel || rel === launchFile.replace(/\\/g, '/')) rel = baseName;

    if (!proj) {
      const extFile = await fsBridge.openExternalFile(launchFile).catch(() => null);
      if (extFile && extFile.text != null) {
        proj = {
          name: baseName,
          rootPath: projectRoot || null,
          files: [baseName],
          dirs: [],
          textFiles: { [baseName]: extFile.text },
          assetUrls: {},
          assetBase64: {}
        };
        rel = baseName;
      }
    }

    if (proj) {
      loadProjectState(proj, { skipDefaultOpen: true });
      let targetKey = Object.keys(state.textFiles).find(k => k.toLowerCase() === rel.toLowerCase())
        || Object.keys(state.textFiles).find(k => k.split('/').pop().toLowerCase() === baseName.toLowerCase());
      if (!targetKey) {
        const extFile = await fsBridge.openExternalFile(launchFile).catch(() => null);
        if (extFile && extFile.text != null) {
          state.textFiles[baseName] = extFile.text;
          if (!state.allFiles.includes(baseName)) state.allFiles.push(baseName);
          targetKey = baseName;
        }
      }
      if (targetKey) {
        openFile(targetKey);
        compileAndRun();
      } else if (state.assetUrls[rel] != null) {
        openFile(rel);
      } else {
        addLog(`Файл выбран в Проводнике, но не загружен: .${ext}`, 'warn');
      }
      return true;
    }
  } catch (err) {
    addLog(`Не удалось открыть файл из Проводника: ${err.message || err}`, 'err');
  }
  return false;
}

function startProjectFileWatcher() {
  const checkChanges = async () => {
    if (!isTauriEnv() || !state.rootPath || isWatchingRefresh) return;
    try {
      const entries = await fsBridge.scanProjectEntries();
      const sig = entries.map(e => `${e.path}:${e.size}`).sort().join('|');
      if (lastWatcherSig === null) {
        lastWatcherSig = sig;
        return;
      }
      if (sig !== lastWatcherSig) {
        lastWatcherSig = sig;
        await refreshFromDisk();
        addLog('Дерево файлов обновлено с диска', 'info');
      }
    } catch {}
  };
  setInterval(checkChanges, 3500);
  window.addEventListener('focus', checkChanges);
}

async function boot() {
  updState.appVersion = await fsBridge.getAppVersion().catch(() => '1.1.0');
  fsBridge.onTauriEvent('open-launch-file', (p) => { if (p) openLaunchFilePath(p); });
  fsBridge.onTauriEvent('engine-download-progress', (p) => {
    if (!p) return;
    const pct = p.total ? Math.round((p.downloaded / p.total) * 100) : 50;
    setEngProgress(true, pct, `${p.file || ''}: ${(p.downloaded / 1024).toFixed(0)} КБ`);
  });
  fsBridge.onTauriEvent('ide-update-progress', (p) => {
    if (!p) return;
    const pct = p.total ? Math.round((p.downloaded / p.total) * 100) : 50;
    const mb = (p.downloaded / (1024 * 1024)).toFixed(1);
    const tot = p.total ? ` / ${(p.total / (1024 * 1024)).toFixed(1)} МБ` : ' МБ';
    setIdeProgress(true, p.finished ? 100 : pct, `${pct}% · ${mb}${tot}`);
  });

  if (isTauriEnv()) {
    try {
      const inst = await fsBridge.listInstalledEngines();
      updState.installed = inst;
      if (inst && inst.active) {
        try {
          const bundle = await fsBridge.readInstalledEngine(inst.active);
          await loadEngineFromBundle(inst.active, bundle.roylang_js, bundle.roylang_docs_js);
        } catch (err) {
          addLog(`Ошибка загрузки кэшированного движка ${inst.active}, откат на встроенный: ${err.message || err}`, 'warn');
          await fsBridge.setActiveEngine(null).catch(() => {});
          resetToBuiltin();
        }
      }
    } catch {}
  }

  syncEngineBadges();
  updateStatusbarUpdateBadge();
  el('envBadge').textContent = isTauriEnv() ? '◆ RoyStudio Desktop' : '◆ RoyStudio Web';
  editor = await createRoyEditor(el('editorHost'), {
    onChange: (val) => {
      if (!state.activeFile || state.textFiles[state.activeFile] == null) return;
      state.textFiles[state.activeFile] = val;
      state.dirty.add(state.activeFile);
      renderTree();
      renderTabs();
      clearTimeout(diagTimer);
      diagTimer = setTimeout(() => { renderOutline(); runDiagnostics(); saveIdeSession(); }, 320);
      if (state.autoSave) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => saveActiveFile(), 1200);
      }
    },
    onSave: saveActiveFile,
    onRun: compileAndRun,
    onCursor: (ln, col) => { el('sbCursor').textContent = `Стр ${ln}, Стб ${col}`; },
    onCmdPalette: () => openCmdPalette('all')
  });

  installDropHandlers();
  const launchFile = await fsBridge.getLaunchFile().catch(() => null);
  const openedLaunch = launchFile ? await openLaunchFilePath(launchFile) : false;
  if (!openedLaunch) {
    loadProjectState(await fsBridge.openDemo());
  }
  startProjectFileWatcher();
  setTimeout(() => refreshAllUpdates(true), 3000);
}

boot();
