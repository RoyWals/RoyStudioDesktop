// Единый мост к файловой системе: Tauri v2 (нативный диск) или Браузер (File System Access API / демо-режим)

const DEMO_FILES = {
  'main.roy': `game "RoyStudio Demo" {
  size: 480x640
  fps: 60
  gamepad: "auto"
}

let x = 240
let y = 320

on update(dt) {
  let spd = 220
  if key("ArrowLeft") or key("KeyA") { x -= spd * dt }
  if key("ArrowRight") or key("KeyD") { x += spd * dt }
  if key("ArrowUp") or key("KeyW") { y -= spd * dt }
  if key("ArrowDown") or key("KeyS") { y += spd * dt }
  x = x |> clamp(_, 24, 456)
  y = y |> clamp(_, 24, 616)
}

on draw {
  cls("#090d16")
  drawGrid(40, "rgba(56,189,248,0.08)")
  drawGlow(x, y, 42, "#38bdf8", 0.35)
  drawCircle(x, y, 16, "#38bdf8")
  text("RoyStudio Desktop v6.5", 240, 32, "#e879f9", 18, "center")
  text("Стрелки / WASD — движение", 240, 60, "#94a3b8", 13, "center")
}
`
};

const TEXT_EXTS = new Set([
  'roy', 'roylang', 'royson', 'royproj', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'json', 'md', 'txt', 'csv', 'toml', 'yaml', 'yml', 'env', 'svg', 'xml', 'rules'
]);

const MEDIA_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav'
};

export function getExt(path) {
  const base = path.split('/').pop();
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
}

export function isTextFile(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base.startsWith('.env')) return true;
  return TEXT_EXTS.has(getExt(path));
}

export function isImageFile(path) {
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg'].includes(getExt(path));
}

export function isMediaFile(path) {
  return Boolean(MEDIA_MIME[getExt(path)]);
}

export function isTauriEnv() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

async function tauriInvoke(cmd, args) {
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function createFsBridge() {
  let mode = 'demo';
  let rootPath = null;
  let dirHandle = null;
  const webHandles = new Map();
  let memoryFiles = { ...DEMO_FILES };

  async function walkWebDir(handle, prefix, filesOut, dirsOut) {
    for await (const [name, entry] of handle.entries()) {
      if (name.startsWith('.') || name === 'node_modules' || name === 'target') continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        dirsOut.push(rel);
        await walkWebDir(entry, rel, filesOut, dirsOut);
      } else {
        webHandles.set(rel, entry);
        filesOut.push(rel);
      }
    }
  }

  async function loadCurrentFolder() {
    if (mode === 'demo') {
      const names = Object.keys(memoryFiles).sort();
      return { name: 'Демо-проект', rootPath: null, files: names, dirs: [], textFiles: { ...memoryFiles }, assetUrls: {}, assetBase64: {} };
    }
    if (mode === 'tauri' && rootPath) {
      const entries = await tauriInvoke('scan_project', { root: rootPath });
      const files = entries.filter(e => !e.is_dir).map(e => e.path);
      const dirs = entries.filter(e => e.is_dir).map(e => e.path);
      const textFiles = {};
      const assetUrls = {};
      const assetBase64 = {};
      for (const rel of files) {
        const ext = getExt(rel);
        if (isTextFile(rel)) {
          try {
            textFiles[rel] = await tauriInvoke('read_project_file', { root: rootPath, rel });
          } catch {}
        }
        if (MEDIA_MIME[ext]) {
          try {
            const b64 = await tauriInvoke('read_project_file_base64', { root: rootPath, rel });
            assetBase64[rel] = b64;
            assetUrls[rel] = `data:${MEDIA_MIME[ext]};base64,${b64}`;
          } catch {}
        }
      }
      const name = rootPath.split(/[\\/]/).pop() || rootPath;
      return { name, rootPath, files, dirs, textFiles, assetUrls, assetBase64 };
    }
    if (mode === 'web-fs' && dirHandle) {
      webHandles.clear();
      const files = [];
      const dirs = [];
      await walkWebDir(dirHandle, '', files, dirs);
      files.sort();
      dirs.sort();
      const textFiles = {};
      const assetUrls = {};
      const assetBase64 = {};
      for (const rel of files) {
        const ext = getExt(rel);
        const f = await webHandles.get(rel).getFile();
        if (isTextFile(rel)) textFiles[rel] = await f.text();
        if (MEDIA_MIME[ext]) {
          const buf = await f.arrayBuffer();
          const b64 = arrayBufferToBase64(buf);
          assetBase64[rel] = b64;
          assetUrls[rel] = `data:${MEDIA_MIME[ext]};base64,${b64}`;
        }
      }
      return { name: dirHandle.name, rootPath: null, files, dirs, textFiles, assetUrls, assetBase64 };
    }
    return null;
  }

  return {
    getMode: () => mode,
    getRootPath: () => rootPath,

    async openDemo() {
      mode = 'demo';
      rootPath = null;
      dirHandle = null;
      return loadCurrentFolder();
    },

    async refreshFolder() {
      return loadCurrentFolder();
    },

    async openFolder() {
      if (isTauriEnv()) {
        const selected = await tauriInvoke('plugin:dialog|open', {
          options: { directory: true, multiple: false, title: 'Выберите папку проекта' }
        });
        if (!selected) return null;
        mode = 'tauri';
        rootPath = Array.isArray(selected) ? selected[0] : selected;
        return loadCurrentFolder();
      }

      if (!window.showDirectoryPicker) {
        throw new Error('Браузер не поддерживает showDirectoryPicker — запустите RoyStudio Desktop или Edge/Chrome');
      }
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      mode = 'web-fs';
      return loadCurrentFolder();
    },

    async openFolderPath(path) {
      if (!isTauriEnv() || !path) return null;
      mode = 'tauri';
      rootPath = path;
      dirHandle = null;
      return loadCurrentFolder();
    },

    async getLaunchFile() {
      if (!isTauriEnv()) return null;
      return tauriInvoke('get_launch_file');
    },

    async getParentDir(filePath) {
      if (!isTauriEnv()) return null;
      return tauriInvoke('get_parent_dir', { filePath });
    },

    async createDir(rel) {
      if (mode === 'demo') return;
      if (mode === 'tauri') {
        await tauriInvoke('create_project_dir', { root: rootPath, rel });
        return;
      }
      if (mode === 'web-fs' && dirHandle) {
        let cur = dirHandle;
        for (const p of rel.split('/').filter(Boolean)) {
          cur = await cur.getDirectoryHandle(p, { create: true });
        }
      }
    },

    async renameEntry(oldRel, newRel) {
      if (mode === 'demo') {
        if (memoryFiles[oldRel] != null) {
          memoryFiles[newRel] = memoryFiles[oldRel];
          delete memoryFiles[oldRel];
        }
        return;
      }
      if (mode === 'tauri') {
        await tauriInvoke('rename_project_entry', { root: rootPath, oldRel, newRel });
        return;
      }
      throw new Error('Переименование доступно в настольном приложении RoyStudio Desktop');
    },

    async deleteEntry(rel) {
      if (mode === 'demo') {
        delete memoryFiles[rel];
        return;
      }
      if (mode === 'tauri') {
        await tauriInvoke('delete_project_entry', { root: rootPath, rel });
        return;
      }
      if (mode === 'web-fs' && dirHandle) {
        const parts = rel.split('/');
        let cur = dirHandle;
        for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
        await cur.removeEntry(parts[parts.length - 1], { recursive: true });
      }
    },

    async gitStatus() {
      if (!isTauriEnv()) return { is_repo: false, branch: '', changes: [], unsupported: true };
      if (mode !== 'tauri' || !rootPath) return { is_repo: false, branch: '', changes: [], needFolder: true };
      return tauriInvoke('git_status', { root: rootPath });
    },

    async gitInit() {
      if (mode !== 'tauri' || !rootPath) throw new Error('Git доступен при открытии папки проекта в RoyStudio Desktop');
      return tauriInvoke('git_init', { root: rootPath });
    },

    async gitCommit(message) {
      if (mode !== 'tauri' || !rootPath) throw new Error('Git доступен при открытии папки проекта в RoyStudio Desktop');
      return tauriInvoke('git_commit', { root: rootPath, message });
    },

    async writeFile(rel, content) {
      if (mode === 'demo') {
        memoryFiles[rel] = content;
        return;
      }
      if (mode === 'tauri') {
        await tauriInvoke('write_project_file', { root: rootPath, rel, content });
        return;
      }
      if (mode === 'web-fs') {
        let handle = webHandles.get(rel);
        if (!handle) {
          const parts = rel.split('/');
          let cur = dirHandle;
          for (let i = 0; i < parts.length - 1; i++) {
            cur = await cur.getDirectoryHandle(parts[i], { create: true });
          }
          handle = await cur.getFileHandle(parts[parts.length - 1], { create: true });
          webHandles.set(rel, handle);
        }
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
      }
    },

    async importDroppedFile(file, relPath = null) {
      if (!file) throw new Error('Файл не выбран');
      const rel = String(relPath || file.name).replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..').join('/');
      if (!rel) throw new Error('Не удалось определить имя файла');
      const ext = getExt(rel);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mode === 'tauri' && rootPath) {
        const data = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
        await tauriInvoke('write_project_file_base64', { root: rootPath, rel, content: data });
      } else if (mode === 'web-fs' && dirHandle) {
        const parts = rel.split('/');
        let parent = dirHandle;
        for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create: true });
        const handle = await parent.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await handle.createWritable();
        await writable.write(file);
        await writable.close();
        webHandles.set(rel, handle);
      } else if (mode === 'demo') {
        if (!isTextFile(rel)) throw new Error('В демо-проекте можно открыть только текстовые файлы');
        memoryFiles[rel] = await file.text();
      } else {
        throw new Error('Сначала открой папку проекта, чтобы добавить в неё файл');
      }
      if (!isTextFile(rel) && !isImageFile(rel)) throw new Error(`Формат .${ext || '?'} нельзя открыть в редакторе`);
      if (isTextFile(rel)) return { path: rel, text: await file.text(), assetUrl: null, base64: null };
      if (MEDIA_MIME[ext]) return { path: rel, text: null, assetUrl: URL.createObjectURL(file), base64: arrayBufferToBase64(bytes) };
      return { path: rel, text: null, assetUrl: null, base64: null };
    },

    async openExternalFile(filePath) {
      if (!isTauriEnv()) throw new Error('Перетаскивание файлов из системы поддерживается в настольном приложении');
      const data = await tauriInvoke('read_external_file', { filePath });
      const name = filePath.split(/[\\/]/).pop();
      const ext = getExt(name);
      if (isTextFile(name)) return { path: name, text: new TextDecoder().decode(Uint8Array.from(atob(data), c => c.charCodeAt(0))) };
      if (MEDIA_MIME[ext]) return { path: name, text: null, assetUrl: `data:${MEDIA_MIME[ext]};base64,${data}`, base64: data };
      throw new Error(`Формат .${ext || '?'} нельзя открыть в редакторе`);
    },

    async copyExternalFile(filePath, relPath) {
      if (!isTauriEnv() || mode !== 'tauri' || !rootPath) throw new Error('Сначала открой папку проекта');
      await tauriInvoke('copy_external_file', { root: rootPath, filePath, rel: relPath });
      return this.openExternalFile(filePath);
    },

    async exportHtml(defaultName, html) {
      if (isTauriEnv()) {
        const outPath = await tauriInvoke('plugin:dialog|save', {
          options: { defaultPath: defaultName, filters: [{ name: 'HTML', extensions: ['html'] }] }
        });
        if (!outPath) return false;
        await tauriInvoke('export_html_file', { outPath, html });
        return true;
      }
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    },

    async openRoyprojFile() {
      if (isTauriEnv()) {
        const selected = await tauriInvoke('plugin:dialog|open', {
          options: {
            directory: false,
            multiple: false,
            title: 'Открыть манифест .royproj',
            filters: [{ name: 'RoyLang Project', extensions: ['royproj'] }]
          }
        });
        if (!selected) return null;
        const filePath = Array.isArray(selected) ? selected[0] : selected;
        rootPath = await tauriInvoke('get_parent_dir', { filePath });
        mode = 'tauri';
        return loadCurrentFolder();
      }
      return this.openFolder();
    },

    async createNewProject(projectName, royprojText, mainRoyText) {
      const opened = await this.openFolder();
      if (!opened) return null;
      await this.writeFile('game.royproj', royprojText);
      if (opened.textFiles['main.roy'] == null) {
        await this.writeFile('main.roy', mainRoyText);
      }
      return loadCurrentFolder();
    },

    async pickDirectory(title = 'Выберите папку') {
      if (!isTauriEnv()) return null;
      const selected = await tauriInvoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, title }
      });
      return selected ? (Array.isArray(selected) ? selected[0] : selected) : null;
    },

    async pickIconFile() {
      if (!isTauriEnv()) return null;
      const selected = await tauriInvoke('plugin:dialog|open', {
        options: {
          directory: false,
          multiple: false,
          title: 'Выберите иконку (.ico)',
          filters: [{ name: 'Windows Icon', extensions: ['ico'] }]
        }
      });
      return selected ? (Array.isArray(selected) ? selected[0] : selected) : null;
    },

    async pickSaveFile(defaultPath, filterName, ext) {
      if (!isTauriEnv()) return null;
      return tauriInvoke('plugin:dialog|save', {
        options: { defaultPath, filters: [{ name: filterName, extensions: [ext] }] }
      });
    },

    async writeTextAbsolute(outPath, content) {
      if (isTauriEnv()) {
        return tauriInvoke('write_text_absolute', { outPath, content });
      }
      const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outPath.split(/[\\/]/).pop() || 'game.html';
      a.click();
      URL.revokeObjectURL(url);
      return content.length;
    },

    async exportZipArchive(outPath, entries) {
      if (!isTauriEnv()) throw new Error('ZIP-экспорт на диск доступен в RoyStudio Desktop');
      return tauriInvoke('export_zip_archive', { outPath, entries });
    },

    async buildStandaloneExe(projectRoot, outDir, exeName, configJson, html, iconPath) {
      if (!isTauriEnv()) throw new Error('Сборка .exe доступна в RoyStudio Desktop');
      return tauriInvoke('build_standalone_exe', {
        outDir,
        exeName,
        configJson,
        html,
        iconPath: iconPath || null,
        projectRoot: projectRoot || null
      });
    },

    async openInExplorer(path) {
      if (isTauriEnv() && path) {
        if (typeof path !== 'string') throw new Error('Некорректный путь сборки');
        await tauriInvoke('open_in_explorer', { path });
      }
    },

    async getAppVersion() {
      if (isTauriEnv()) return tauriInvoke('get_app_version');
      return '1.0.0';
    },

    async fetchRoylangReleases() {
      if (isTauriEnv()) {
        return tauriInvoke('fetch_roylang_releases');
      }
      const [relRes, tagRes] = await Promise.allSettled([
        fetch('https://api.github.com/repos/RoyWals/RoyLang/releases?per_page=30'),
        fetch('https://api.github.com/repos/RoyWals/RoyLang/tags?per_page=30')
      ]);
      const byTag = new Map();
      if (relRes.status === 'fulfilled' && relRes.value.ok) {
        for (const r of await relRes.value.json()) {
          if (r && !r.draft && /^v\d/i.test(r.tag_name || '')) {
            byTag.set(r.tag_name, {
              tag: r.tag_name,
              title: r.name || `RoyLang ${r.tag_name}`,
              body: r.body || '',
              published_at: r.published_at || '',
              html_url: r.html_url || '',
              is_release: true,
              prerelease: Boolean(r.prerelease)
            });
          }
        }
      }
      if (tagRes.status === 'fulfilled' && tagRes.value.ok) {
        for (const t of await tagRes.value.json()) {
          if (t && /^v\d/i.test(t.name || '') && !byTag.has(t.name)) {
            byTag.set(t.name, {
              tag: t.name,
              title: `RoyLang ${t.name}`,
              body: '',
              published_at: '',
              html_url: `https://github.com/RoyWals/RoyLang/releases/tag/${t.name}`,
              is_release: false,
              prerelease: false
            });
          }
        }
      }
      if (!byTag.size) throw new Error('Не удалось получить список версий RoyWals/RoyLang');
      return Array.from(byTag.values());
    },

    async downloadWebEngineBundle(tag) {
      const base = `https://raw.githubusercontent.com/RoyWals/RoyLang/${encodeURIComponent(tag)}`;
      const coreRes = await fetch(`${base}/roylang.js`);
      if (!coreRes.ok) throw new Error(`Ошибка загрузки roylang.js (${tag}): HTTP ${coreRes.status}`);
      const roylang_js = await coreRes.text();
      let roylang_docs_js = null;
      try {
        const dRes = await fetch(`${base}/roylang-docs.js`);
        if (dRes.ok) roylang_docs_js = await dRes.text();
      } catch {}
      return { tag, roylang_js, roylang_docs_js, roy_gamepad_js: null };
    },

    async listInstalledEngines() {
      if (!isTauriEnv()) return { active: null, engines: [] };
      return tauriInvoke('list_installed_engines');
    },

    async downloadRoylangEngine(tag) {
      if (!isTauriEnv()) throw new Error('Кэширование движка доступно в RoyStudio Desktop');
      return tauriInvoke('download_roylang_engine', { tag });
    },

    async readInstalledEngine(tag) {
      if (!isTauriEnv()) return this.downloadWebEngineBundle(tag);
      return tauriInvoke('read_installed_engine', { tag });
    },

    async setActiveEngine(tag) {
      if (!isTauriEnv()) return;
      return tauriInvoke('set_active_engine', { tag: tag || null });
    },

    async deleteInstalledEngine(tag) {
      if (!isTauriEnv()) return;
      return tauriInvoke('delete_installed_engine', { tag });
    },

    async checkIdeUpdate() {
      if (!isTauriEnv()) {
        return { current_version: '1.0.0', available: false, pubkey_configured: false, latest_version: null, notes: '', message: 'Обновление IDE доступно в RoyStudio Desktop.' };
      }
      return tauriInvoke('check_ide_update');
    },

    async installIdeUpdate() {
      if (!isTauriEnv()) throw new Error('Установка обновления IDE доступна в RoyStudio Desktop.');
      return tauriInvoke('install_ide_update');
    },

    async relaunchApp() {
      if (isTauriEnv()) await tauriInvoke('relaunch_app');
    },

    async onTauriEvent(eventName, handler) {
      if (!isTauriEnv() || !window.__TAURI_INTERNALS__?.transformCallback) return () => {};
      const id = window.__TAURI_INTERNALS__.transformCallback((evt) => {
        try { handler(evt?.payload ?? evt); } catch {}
      });
      await tauriInvoke('plugin:event|listen', {
        event: eventName,
        target: { kind: 'Any' },
        handler: id
      });
      return () => {
        try { tauriInvoke('plugin:event|unlisten', { event: eventName, eventId: id }); } catch {}
      };
    }
  };
}
