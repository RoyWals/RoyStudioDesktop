import BuiltinRoyLang from './roylang.js';
import BuiltinDocs from './roylang-docs.js';

export function parseSemver(tag) {
  const clean = String(tag || '').trim().replace(/^v/i, '');
  const [core, pre = ''] = clean.split('-', 2);
  const parts = core.split('.');
  const num = (s) => {
    const m = /^\d+/.exec(String(s || ''));
    return m ? Number(m[0]) : 0;
  };
  return {
    maj: num(parts[0]),
    min: num(parts[1]),
    patch: num(parts[2]),
    pre
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.maj !== pb.maj) return pa.maj - pb.maj;
  if (pa.min !== pb.min) return pa.min - pb.min;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

export function sortSemverDesc(list, keyFn = (x) => String(x)) {
  return [...list].sort((a, b) => compareSemver(keyFn(b), keyFn(a)));
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bytes).toString('base64');
}

async function importEsmCode(code, label = 'module') {
  const src = String(code || '');
  if (!src.trim()) throw new Error(`Пустой модуль ${label}`);
  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const blob = new Blob([src], { type: 'text/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      return await import(/* @vite-ignore */ url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const dataUrl = `data:text/javascript;base64,${utf8ToBase64(src)}`;
  return import(/* @vite-ignore */ dataUrl);
}

function extractSetArrayFromSource(sourceCode, varName) {
  if (typeof sourceCode !== 'string' || !sourceCode) return null;
  const re = new RegExp(`var\\s+${varName}\\s*=[^\\n;]*new\\s+Set\\(\\s*(\\[[\\s\\S]*?\\])\\s*\\)`);
  const m = re.exec(sourceCode);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.map(String) : null;
  } catch {
    return null;
  }
}

const FALLBACK_HOST_KEYS = [
  'parseRoyson',
  'parseRoysonWithIncludes',
  'validateRoyson',
  'validateRoysonSchema',
  'stringifyRoyson',
  'parseRoyproj',
  'stringifyRoyproj',
  'guessMime'
];

function wrapEngine(raw) {
  const wrapped = Object.create(null);
  for (const key of Object.keys(raw)) {
    wrapped[key] = raw[key];
  }
  for (const key of FALLBACK_HOST_KEYS) {
    if (typeof wrapped[key] !== 'function' && typeof BuiltinRoyLang[key] === 'function') {
      wrapped[key] = BuiltinRoyLang[key];
    }
  }
  return wrapped;
}

function buildDocsMeta(rawEngine, sourceCode, docsMod, tag, isBuiltin) {
  const hasCustomDocs = Boolean(
    docsMod && (Array.isArray(docsMod.ROY_DOCS_INDEX) || Array.isArray(docsMod.ROYLANG_V3_DOCS))
  );
  const effDocs = hasCustomDocs ? docsMod : BuiltinDocs;

  const keywords = Array.isArray(rawEngine.KEYWORDS) && rawEngine.KEYWORDS.length
    ? [...rawEngine.KEYWORDS]
    : extractSetArrayFromSource(sourceCode, 'KEYWORDS') || [...(effDocs.ROY_KEYWORDS || [])];

  const runtimeList = Array.isArray(rawEngine.RUNTIME_APIS) && rawEngine.RUNTIME_APIS.length
    ? rawEngine.RUNTIME_APIS
    : extractSetArrayFromSource(sourceCode, 'KNOWN_RUNTIME_GLOBALS') || effDocs.ROY_RUNTIME_APIS || [];

  const apiSet = new Set(runtimeList.map(String));
  if (Array.isArray(effDocs.ROY_RUNTIME_APIS)) {
    for (const a of effDocs.ROY_RUNTIME_APIS) apiSet.add(String(a));
  }

  const docsByName = new Map();
  const docsList = [];
  for (const item of (effDocs.ROY_DOCS_INDEX || [])) {
    if (!item || !item.name) continue;
    const name = String(item.name);
    const entry = {
      name,
      kind: String(item.kind || 'Функция'),
      cat: String(item.cat || 'core'),
      ver: String(item.ver || rawEngine.VERSION || 'v6.5'),
      sig: String(item.sig || `${name}()`),
      desc: String(item.desc || '')
    };
    if (!docsByName.has(name)) {
      docsByName.set(name, entry);
      docsList.push(entry);
    }
  }
  if (effDocs.ROY_SIGNATURE_HINTS && typeof effDocs.ROY_SIGNATURE_HINTS === 'object') {
    for (const [name, hint] of Object.entries(effDocs.ROY_SIGNATURE_HINTS)) {
      if (!hint) continue;
      const sigStr = typeof hint === 'string'
        ? hint
        : Array.isArray(hint.params)
          ? `${name}(${hint.params.join(', ')})`
          : String(hint.sig || hint.label || `${name}()`);
      const descStr = typeof hint === 'object' ? String(hint.desc || hint.tip || '') : '';
      if (!docsByName.has(name)) {
        const entry = {
          name,
          kind: 'Функция',
          cat: 'api',
          ver: String(rawEngine.VERSION || 'v6.5'),
          sig: sigStr,
          desc: descStr
        };
        docsByName.set(name, entry);
        docsList.push(entry);
      } else {
        const prev = docsByName.get(name);
        if (!prev.desc && descStr) prev.desc = descStr;
        if (!prev.sig && sigStr) prev.sig = sigStr;
      }
    }
  }

  const apis = Array.from(apiSet).sort((a, b) => a.localeCompare(b));
  return {
    tag: tag || rawEngine.VERSION || BuiltinRoyLang.VERSION || 'v6.5',
    version: rawEngine.VERSION || tag || BuiltinRoyLang.VERSION || 'v6.5',
    isBuiltin,
    hasCustomDocs,
    keywords,
    apis,
    docsByName,
    docsList
  };
}

let activeEngine = wrapEngine(BuiltinRoyLang);
let activeState = buildDocsMeta(BuiltinRoyLang, '', BuiltinDocs, BuiltinRoyLang.VERSION || 'v6.5', true);
const listeners = new Set();

function notifyListeners() {
  if (typeof window !== 'undefined') {
    window.RoyLang = RoyLang;
  }
  for (const cb of listeners) {
    try { cb(getEngineState()); } catch {}
  }
}

export const RoyLang = new Proxy({}, {
  get(_, prop) {
    return activeEngine[prop];
  },
  has(_, prop) {
    return prop in activeEngine;
  },
  ownKeys() {
    return Reflect.ownKeys(activeEngine);
  },
  getOwnPropertyDescriptor(_, prop) {
    return Reflect.getOwnPropertyDescriptor(activeEngine, prop);
  }
});

if (typeof window !== 'undefined') {
  window.RoyLang = RoyLang;
}

export function getEngineState() {
  return {
    tag: activeState.tag,
    version: activeState.version,
    isBuiltin: activeState.isBuiltin,
    hasCustomDocs: activeState.hasCustomDocs,
    keywords: activeState.keywords,
    apis: activeState.apis,
    docsByName: activeState.docsByName,
    docsList: activeState.docsList
  };
}

export function onEngineChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function loadEngineFromBundle(tag, roylangCode, docsCode = null) {
  const mod = await importEsmCode(roylangCode, `${tag}/roylang.js`);
  const raw = mod?.RoyLang || mod?.default;
  if (!raw || typeof raw.compile !== 'function' || typeof raw.compileToHtml !== 'function') {
    throw new Error(`Модуль ${tag}/roylang.js не экспортирует корректный компилятор RoyLang`);
  }

  const smoke = raw.compile('game "SmokeCheck" {\n  size: 320x240\n}\non draw {\n  cls("#000")\n}\n');
  if (!smoke || (typeof smoke.jsCode !== 'string' && typeof smoke.js !== 'string')) {
    throw new Error(`Движок ${tag} не прошёл тестовую компиляцию`);
  }

  let docsMod = null;
  if (docsCode && typeof docsCode === 'string' && docsCode.trim()) {
    try {
      const dm = await importEsmCode(docsCode, `${tag}/roylang-docs.js`);
      const cand = dm?.default || dm;
      if (cand && (Array.isArray(cand.ROYLANG_V3_DOCS) || Array.isArray(cand.ROY_RUNTIME_APIS))) {
        docsMod = cand;
      }
    } catch {
      docsMod = null;
    }
  }

  activeEngine = wrapEngine(raw);
  activeState = buildDocsMeta(raw, roylangCode, docsMod, tag, false);
  notifyListeners();
  return getEngineState();
}

export function resetToBuiltin() {
  activeEngine = wrapEngine(BuiltinRoyLang);
  activeState = buildDocsMeta(BuiltinRoyLang, '', BuiltinDocs, BuiltinRoyLang.VERSION || 'v6.5', true);
  notifyListeners();
  return getEngineState();
}
