import {
  RoyLang,
  getEngineState,
  onEngineChange,
  loadEngineFromBundle,
  resetToBuiltin,
  compareSemver,
  sortSemverDesc
} from './core/engine-manager.js';
import { createFsBridge, isTauriEnv, isTextFile, isImageFile, getExt } from './fs-bridge.js';
import { createRoyEditor, detectMonacoLang, updateRoyLanguageMeta } from './editor/monaco-roy.js';

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

const el = id => document.getElementById(id);
let editor = null;
let diagTimer = null;
let autoSaveTimer = null;

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
  const pane = el('consolePane');
  pane.innerHTML = state.logs.map(l =>
    `<div class="log-row ${l.kind}">[${l.t}] ${escapeHtml(l.msg)}</div>`
  ).join('');
  pane.scrollTop = pane.scrollHeight;
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
      if (isTextFile(p) || isImageFile(p)) openFile(p);
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
  el('editorHost').classList.add('hidden');
  el('imageViewer').classList.remove('hidden');
  const img = el('ivImg');
  img.onload = () => {
    el('ivMeta').textContent = `${path} · ${img.naturalWidth} × ${img.naturalHeight} px`;
  };
  img.src = url || '';
  el('ivMeta').textContent = path;
  document.querySelector('.sb-lang').textContent = 'Изображение';
}

function openFile(path, line = null, fromHistory = false) {
  const hasText = state.textFiles[path] != null;
  const isImg = isImageFile(path) && state.assetUrls[path] != null;
  if (!hasText && !isImg) return;
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

  if (isImg && !hasText) {
    showImageTab(path);
  } else {
    el('imageViewer').classList.add('hidden');
    el('editorHost').classList.remove('hidden');
    const lang = detectMonacoLang(path);
    if (editor) {
      editor.setLanguage(lang);
      editor.setValue(state.textFiles[path]);
      if (line) editor.revealLine(line);
    }
    const langLabel =
      lang === 'roy' ? `RoyLang ${RoyLang.VERSION || 'v6.5'}` :
      lang === 'royson' ? 'RoySON' :
      lang === 'royproj' ? 'RoyProj' : lang.toUpperCase();
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
    try {
      const res = RoyLang.compile(royFiles[entry], royFiles, entry);
      for (const w of (res.warnings || [])) {
        diags.push({ severity: 'warning', message: w.message || String(w), line: w.line || 1, col: w.col || 1, file: w.file || entry });
      }
    } catch (err) {
      diags.push({ severity: 'error', message: err.message || String(err), line: err.royLine || err.line || 1, col: err.royCol || err.col || 1, file: err.royFile || err.fileName || entry });
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
    const rawHtml = RoyLang.compileToHtml(state.textFiles[entry], { title }, projectFiles, entry);
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
    if (state.activeFile.endsWith('.royson') && typeof RoyLang.parseRoyson === 'function' && typeof RoyLang.stringifyRoyson === 'function') {
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
      const built = buildCompiledOutput(false, { embedDataUrls: singleFile, entryOverride: entry, titleOverride: name });
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
      lastBuildDirPath = isTauriEnv() ? outPath : null;
      el('btnOpenBuildDir').disabled = !lastBuildDirPath;
      el('buildResultInfo').textContent = `${slug}.html · ${formatBytesSize(written || built.html.length)}`;
      setBuildLog(`Готово!\nФайл: ${outPath}\nРазмер: ${formatBytesSize(written || built.html.length)}`);
      addLog(`HTML собран: ${outPath}`, 'info');
    } else if (buildModalTarget === 'zip') {
      if (!isTauriEnv()) throw new Error('ZIP-сборка на диск доступна в настольном RoyStudio Desktop');
      setBuildLog('Сборка игры и упаковка ZIP...');
      const dir = await resolveOutDir();
      const outZip = dir ? joinBuildPath(dir, `${slug}.zip`) : await fsBridge.pickSaveFile(`${slug}.zip`, 'ZIP Archive', 'zip');
      if (!outZip) { setBuildLog('Сохранение отменено.'); return; }
      const built = buildCompiledOutput(false, { embedDataUrls: singleFile, entryOverride: entry, titleOverride: name });
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
      lastBuildDirPath = outZip;
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
      lastBuildDirPath = outZip;
      el('btnOpenBuildDir').disabled = false;
      el('buildResultInfo').textContent = `${slug}-source.zip · ${formatBytesSize(bytes)} (${entries.length} файл.)`;
      setBuildLog(`ZIP исходников собран!\nАрхив: ${outZip}\nФайлов: ${entries.length} · Размер: ${formatBytesSize(bytes)}`);
      addLog(`ZIP исходников: ${outZip} (${formatBytesSize(bytes)})`, 'info');
    } else if (buildModalTarget === 'exe') {
      if (!isTauriEnv()) throw new Error('Сборка Windows .exe поддерживается только в настольном RoyStudio Desktop');
      const dir = await resolveOutDir();
      if (!dir) { setBuildLog('Сборка отменена: не выбрана папка вывода.'); return; }
      setBuildLog('Компиляция игры и сборка standalone Windows .exe...');
      const built = buildCompiledOutput(false, { embedDataUrls: true, entryOverride: entry, titleOverride: name });
      const cfgJson = JSON.stringify({ title: name, width, height, bg, fullscreen, resizable });
      const res = await fsBridge.buildStandaloneExe(state.rootPath, dir, slug, cfgJson, built.html, iconPath);
      lastBuildDirPath = res.exe_path;
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

function loadProjectState(proj) {
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
  if (entry) openFile(entry);
  else { renderTree(); renderTabs(); renderOutline(); }
  compileAndRun();
  if (state.activeView === 'git') renderGitPane();
}

async function refreshFromDisk() {
  try {
    const proj = await fsBridge.refreshFolder();
    if (!proj) return;
    const prevOpen = [...state.openTabs];
    const prevActive = state.activeFile;
    state.rootPath = proj.rootPath || state.rootPath;
    state.allFiles = proj.files;
    state.allDirs = proj.dirs || [];
    state.textFiles = proj.textFiles;
    state.assetUrls = proj.assetUrls || {};
    state.assetBase64 = proj.assetBase64 || {};
    state.openTabs = prevOpen.filter(p => state.textFiles[p] != null || state.assetUrls[p] != null);
    state.activeFile = state.openTabs.includes(prevActive) ? prevActive : (state.openTabs[0] || null);
    renderTree();
    renderTabs();
    renderOutline();
    if (state.activeView === 'git') renderGitPane();
  } catch (err) {
    addLog(err.message || String(err), 'err');
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

// Project-wide search
el('searchFilesInput').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const out = el('searchResults');
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
  const source = cmdPaletteMode === 'files' ? [...fileItems, ...COMMANDS] : [...COMMANDS, ...fileItems];
  const all = source.filter(c => !s || c.label.toLowerCase().includes(s));
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
  const ver = eng.version || 'v6.5';
  const modeStr = isTauriEnv() ? 'Настольное приложение (Desktop)' : 'Веб-режим (Browser)';
  showInfoModal('О программе RoyStudio Desktop', `
    <p><strong>RoyStudio Desktop</strong> — интегрированная среда разработки для языка и игрового движка <strong>RoyLang</strong>.</p>
    <p>Версия движка: <strong style="color:#f97316">${escapeHtml(ver)}</strong></p>
    <p>Режим запуска: <strong>${modeStr}</strong></p>
    <p class="muted">Поддержка .roy, .royson, .royproj, .html, .css, .js, .json и графических/аудио ассетов проекта. Экспорт в HTML, ZIP и Windows .exe.</p>
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
window.addEventListener('message', (e) => {
  if (e.data && e.data.__royLog) addLog(e.data.text, e.data.kind);
});
document.querySelectorAll('.btab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btab').forEach(b => b.classList.toggle('active', b === btn));
    el('problemsPane').classList.toggle('hidden', btn.dataset.tab !== 'problems');
    el('consolePane').classList.toggle('hidden', btn.dataset.tab !== 'console');
  });
});
el('btnClearLog').addEventListener('click', () => {
  state.logs = [];
  el('logCount').textContent = '0';
  el('consolePane').innerHTML = '';
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
  else if (e.code === 'Backquote') { e.preventDefault(); toggleBottomPanel(); }
});

async function boot() {
  updState.appVersion = await fsBridge.getAppVersion().catch(() => '1.0.0');
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
      diagTimer = setTimeout(() => { renderOutline(); runDiagnostics(); }, 320);
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
  const demo = await fsBridge.openDemo();
  loadProjectState(demo);
  setTimeout(() => refreshAllUpdates(true), 3000);
}

boot();
