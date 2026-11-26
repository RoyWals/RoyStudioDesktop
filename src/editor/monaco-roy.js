import { getEngineState } from '../core/engine-manager.js';

const MONACO_BASE = './vendor/monaco/vs';

let monacoInstance = null;
let liveMeta = {
  version: 'v7.0',
  keywords: [],
  apis: [],
  docsByName: new Map()
};

let liveAnalysis = {
  symbols: [],
  byName: new Map(),
  getActiveFile: () => null,
  getProjectFiles: () => ({}),
  onApplyProjectFiles: null,
  onOpenFile: null
};

export function updateRoyAnalysis(symbols, helpers = null) {
  const list = Array.isArray(symbols) ? symbols : [];
  const byName = new Map();
  for (const s of list) {
    if (!s || !s.name) continue;
    if (!byName.has(s.name)) byName.set(s.name, s);
  }
  liveAnalysis.symbols = list;
  liveAnalysis.byName = byName;
  if (helpers) {
    if (typeof helpers.getActiveFile === 'function') liveAnalysis.getActiveFile = helpers.getActiveFile;
    if (typeof helpers.getProjectFiles === 'function') liveAnalysis.getProjectFiles = helpers.getProjectFiles;
    if (typeof helpers.onApplyProjectFiles === 'function') liveAnalysis.onApplyProjectFiles = helpers.onApplyProjectFiles;
    if (typeof helpers.onOpenFile === 'function') liveAnalysis.onOpenFile = helpers.onOpenFile;
  }
}

function syncMetaFromEngine(meta) {
  const src = meta || getEngineState();
  liveMeta = {
    version: src.version || 'v7.0',
    keywords: Array.isArray(src.keywords) ? src.keywords : [],
    apis: Array.isArray(src.apis) ? src.apis : [],
    docsByName: src.docsByName instanceof Map ? src.docsByName : new Map()
  };
}
syncMetaFromEngine();

export function updateRoyLanguageMeta(meta) {
  syncMetaFromEngine(meta);
  if (monacoInstance) {
    applyRoyMonarchTokens(monacoInstance);
  }
}

function loadMonacoScript() {
  return new Promise((resolve, reject) => {
    if (window.monaco) return resolve(window.monaco);
    const s = document.createElement('script');
    s.src = `${MONACO_BASE}/loader.js`;
    s.onload = () => {
      window.require.config({ paths: { vs: MONACO_BASE } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function registerRoysonLanguages(monaco) {
  const tokenDef = {
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"""/, 'string', '@tripleString'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b\d+\s*[xX]\s*\d+\b/, 'number.float'],
        [/\b\d[\d_]*(?:\.[\d_]+)?(?:ms|s)\b/, 'number.float'],
        [/\b0x[0-9a-fA-F_]+\b/, 'number.hex'],
        [/-?\b\d[\d_]*(?:\.[\d_]+)?\b/, 'number'],
        [/\bproject\b/, 'keyword'],
        [/\b(true|false|null)\b/, 'keyword'],
        [/[a-zA-Z_$][\w$]*(?=\s*:)/, 'attribute.name'],
        [/[{}[\],:]/, 'delimiter']
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ],
      tripleString: [
        [/[^"]+/, 'string'],
        [/"""/, 'string', '@pop'],
        [/"/, 'string']
      ]
    }
  };
  for (const id of ['royson', 'royproj']) {
    if (!monaco.languages.getLanguages().some(l => l.id === id)) {
      monaco.languages.register({ id, extensions: ['.' + id] });
      monaco.languages.setMonarchTokensProvider(id, tokenDef);
    }
  }
  if (!monaco.languages.getLanguages().some(l => l.id === 'gdscript')) {
    monaco.languages.register({ id: 'gdscript', extensions: ['.gd'] });
    monaco.languages.setMonarchTokensProvider('gdscript', {
      keywords: [
        'if', 'elif', 'else', 'for', 'while', 'match', 'break', 'continue', 'pass', 'return',
        'class', 'class_name', 'extends', 'is', 'in', 'as', 'self', 'super', 'signal', 'func',
        'static', 'const', 'enum', 'var', 'breakpoint', 'preload', 'await', 'yield', 'assert',
        'void', 'and', 'or', 'not', 'true', 'false', 'null', 'PI', 'TAU', 'INF', 'NAN'
      ],
      typeKeywords: [
        'bool', 'int', 'float', 'String', 'Vector2', 'Vector2i', 'Vector3', 'Vector3i',
        'Color', 'Rect2', 'Transform2D', 'Transform3D', 'Node', 'Node2D', 'Node3D',
        'CharacterBody2D', 'CharacterBody3D', 'Sprite2D', 'Array', 'Dictionary'
      ],
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/@[a-zA-Z_]\w*/, 'annotation'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/\b\d+(\.\d+)?\b/, 'number'],
          [/[a-zA-Z_]\w*/, {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'type',
              '@default': 'identifier'
            }
          }]
        ]
      }
    });
  }
}

function applyRoyMonarchTokens(monaco) {
  const kwSet = new Set([...liveMeta.keywords, 'interface', 'trait', 'implements']);
  monaco.languages.setMonarchTokensProvider('roy', {
    keywords: Array.from(kwSet),
    apis: liveMeta.apis,
    tokenizer: {
      root: [
        [/#(if|elif|else|endif|define)\b.*$/, 'metatag'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/<[A-Z][\w,\s]*>/, 'type.identifier'],
        [/(\|>|\.\.=|\.\.\.|\.\.|\?\?|\?\.|=>|==|!=|<=|>=|&&|\|\|)/, 'operator'],
        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            '@keywords': 'keyword',
            '@apis': 'type.identifier',
            '@default': 'identifier'
          }
        }]
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ]
    }
  });
}

function registerColorProviderForLang(monaco, langId) {
  monaco.languages.registerColorProvider(langId, {
    provideDocumentColors(model) {
      const text = model.getValue();
      const colors = [];
      const hexRe = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
      let m;
      while ((m = hexRe.exec(text)) !== null) {
        const hex = m[0].slice(1);
        let r = 0, g = 0, b = 0, a = 1;
        if (hex.length === 3) {
          r = parseInt(hex[0] + hex[0], 16) / 255;
          g = parseInt(hex[1] + hex[1], 16) / 255;
          b = parseInt(hex[2] + hex[2], 16) / 255;
        } else {
          r = parseInt(hex.slice(0, 2), 16) / 255;
          g = parseInt(hex.slice(2, 4), 16) / 255;
          b = parseInt(hex.slice(4, 6), 16) / 255;
          if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
        }
        const start = model.getPositionAt(m.index);
        const end = model.getPositionAt(m.index + m[0].length);
        colors.push({
          color: { red: r, green: g, blue: b, alpha: a },
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
        });
      }
      return colors;
    },
    provideColorPresentations(model, colorInfo) {
      const { red, green, blue, alpha } = colorInfo.color;
      const toHex = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
      const hex = alpha < 0.999
        ? `#${toHex(red)}${toHex(green)}${toHex(blue)}${toHex(alpha)}`
        : `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
      return [{ label: hex }];
    }
  });
}

function formatSymbolSig(sym) {
  if (!sym) return '';
  if (Array.isArray(sym.params)) return `${sym.kind || 'fn'} ${sym.name}(${sym.params.join(', ')})`;
  return `${sym.kind || 'symbol'} ${sym.name}`;
}

function parseCallBeforeCursor(lineText, colOneBased) {
  const before = lineText.slice(0, Math.max(0, colOneBased - 1));
  let depth = 0;
  let commas = 0;
  let openIdx = -1;
  let inStr = null;
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (inStr) {
      if (ch === inStr && before[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === ')') { depth++; continue; }
    if (ch === '(') {
      if (depth === 0) { openIdx = i; break; }
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) commas++;
  }
  if (openIdx < 0) return null;
  const left = before.slice(0, openIdx).trimEnd();
  const m = /([a-zA-Z_$][\w$]*)$/.exec(left);
  if (!m) return null;
  return { name: m[1], activeParameter: commas };
}

function splitSigParams(sig) {
  const m = /\(([^)]*)\)/.exec(sig || '');
  if (!m || !m[1].trim()) return [];
  return m[1].split(',').map(p => p.trim()).filter(Boolean);
}

function registerRoyLanguage(monaco) {
  monacoInstance = monaco;
  registerRoysonLanguages(monaco);
  if (monaco.languages.getLanguages().some(l => l.id === 'roy')) {
    applyRoyMonarchTokens(monaco);
    return;
  }
  monaco.languages.register({ id: 'roy', extensions: ['.roy', '.roylang'] });
  applyRoyMonarchTokens(monaco);
  registerColorProviderForLang(monaco, 'roy');
  registerColorProviderForLang(monaco, 'royson');
  registerColorProviderForLang(monaco, 'royproj');

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource && resource.scheme === 'roy' && typeof liveAnalysis.onOpenFile === 'function') {
        const rel = resource.path.replace(/^\/+/, '');
        const ln = selectionOrPosition?.startLineNumber || selectionOrPosition?.lineNumber || 1;
        liveAnalysis.onOpenFile(rel, ln);
        return true;
      }
      return false;
    }
  });

  monaco.languages.registerCompletionItemProvider('roy', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      };
      const seenUser = new Set();
      const userItems = [];
      for (const sym of liveAnalysis.symbols) {
        if (!sym || !sym.name || seenUser.has(sym.name)) continue;
        seenUser.add(sym.name);
        const kind =
          sym.kind === 'fn' ? monaco.languages.CompletionItemKind.Function :
          sym.kind === 'struct' || sym.kind === 'class' ? monaco.languages.CompletionItemKind.Struct :
          sym.kind === 'entity' ? monaco.languages.CompletionItemKind.Class :
          sym.kind === 'field' ? monaco.languages.CompletionItemKind.Field :
          monaco.languages.CompletionItemKind.Variable;
        userItems.push({
          label: sym.name,
          kind,
          insertText: sym.name,
          detail: `${formatSymbolSig(sym)}${sym.file ? ` · ${sym.file}:${sym.line || 1}` : ''}`,
          documentation: sym.doc || undefined,
          range
        });
      }
      const items = [
        ...userItems,
        ...liveMeta.keywords.map(k => ({
          label: k,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: k,
          detail: `RoyLang ${liveMeta.version} keyword`,
          range
        })),
        ...liveMeta.apis.map(a => {
          const doc = liveMeta.docsByName.get(a);
          return {
            label: a,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: a,
            detail: doc ? doc.sig : `RoyLang ${liveMeta.version} API`,
            documentation: doc && doc.desc ? `${doc.desc}${doc.ver ? ` (${doc.ver})` : ''}` : undefined,
            range
          };
        }),
        {
          label: 'on update(dt)',
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: 'on update(dt) {\n  $0\n}',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'Игровой цикл обновления',
          range
        },
        {
          label: 'on draw',
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: 'on draw {\n  cls("#090d16")\n  $0\n}',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'Кадр отрисовки',
          range
        }
      ];
      return { suggestions: items };
    }
  });

  monaco.languages.registerHoverProvider('roy', {
    provideHover: (model, position) => {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const doc = liveMeta.docsByName.get(w.word);
      if (doc) {
        return {
          range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn),
          contents: [
            { value: '```roy\n' + doc.sig + '\n```' },
            { value: `**${doc.kind || 'API'}** · \`${doc.cat || 'core'}\` (${doc.ver || liveMeta.version})\n\n${doc.desc || ''}` }
          ]
        };
      }
      const sym = liveAnalysis.byName.get(w.word);
      if (sym) {
        return {
          range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn),
          contents: [
            { value: '```roy\n' + formatSymbolSig(sym) + '\n```' },
            { value: `${sym.file ? `\`${sym.file}:${sym.line || 1}\`` : 'Проект'}${sym.doc ? `\n\n${sym.doc}` : ''}` }
          ]
        };
      }
      return null;
    }
  });

  monaco.languages.registerSignatureHelpProvider('roy', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp: (model, position) => {
      const lineText = model.getLineContent(position.lineNumber);
      const call = parseCallBeforeCursor(lineText, position.column);
      if (!call) return null;
      const doc = liveMeta.docsByName.get(call.name);
      const sym = liveAnalysis.byName.get(call.name);
      let label = null;
      let documentation = '';
      let params = [];
      if (doc && doc.sig) {
        label = doc.sig;
        documentation = doc.desc || '';
        params = splitSigParams(doc.sig);
      } else if (sym && Array.isArray(sym.params)) {
        label = `${sym.name}(${sym.params.join(', ')})`;
        documentation = sym.doc || (sym.file ? `${sym.file}:${sym.line || 1}` : '');
        params = sym.params;
      }
      if (!label) return null;
      return {
        value: {
          signatures: [{
            label,
            documentation,
            parameters: params.map(p => ({ label: p }))
          }],
          activeSignature: 0,
          activeParameter: Math.min(call.activeParameter, Math.max(0, params.length - 1))
        },
        dispose: () => {}
      };
    }
  });

  monaco.languages.registerDefinitionProvider('roy', {
    provideDefinition: (model, position) => {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const activeFile = liveAnalysis.getActiveFile();
      const lsp = typeof window !== 'undefined' && window.RoyLang?.lsp;
      if (lsp && typeof lsp.goToDefinition === 'function') {
        try {
          const res = lsp.goToDefinition(model.getValue(), position.lineNumber, position.column, liveAnalysis.getProjectFiles());
          if (res && res.found && res.definition) {
            const def = res.definition;
            const targetUri = (!def.file || def.file === activeFile)
              ? model.uri
              : monaco.Uri.parse(`roy:///${def.file.replace(/^\/+/, '')}`);
            const ln = Math.max(1, def.line || 1);
            const col = Math.max(1, def.col || 1);
            return { uri: targetUri, range: new monaco.Range(ln, col, ln, col + w.word.length) };
          }
        } catch {}
      }
      const sym = liveAnalysis.byName.get(w.word);
      if (!sym || !sym.line) return null;
      const targetUri = (!sym.file || sym.file === activeFile)
        ? model.uri
        : monaco.Uri.parse(`roy:///${sym.file.replace(/^\/+/, '')}`);
      const ln = Math.max(1, sym.line || 1);
      const col = Math.max(1, sym.col || 1);
      return {
        uri: targetUri,
        range: new monaco.Range(ln, col, ln, col + w.word.length)
      };
    }
  });

  monaco.languages.registerReferenceProvider('roy', {
    provideReferences: (model, position) => {
      const lsp = typeof window !== 'undefined' && window.RoyLang?.lsp;
      if (!lsp || typeof lsp.findReferences !== 'function') return [];
      try {
        const activeFile = liveAnalysis.getActiveFile();
        const res = lsp.findReferences(model.getValue(), position.lineNumber, position.column, liveAnalysis.getProjectFiles());
        return (res?.references || []).map(r => ({
          uri: (!r.file || r.file === activeFile) ? model.uri : monaco.Uri.parse(`roy:///${r.file.replace(/^\/+/, '')}`),
          range: new monaco.Range(Math.max(1, r.line || 1), Math.max(1, r.col || 1), Math.max(1, r.line || 1), Math.max(2, r.endCol || (r.col || 1) + 1))
        }));
      } catch {
        return [];
      }
    }
  });

  monaco.languages.registerRenameProvider('roy', {
    provideRenameEdits: (model, position, newName) => {
      const w = model.getWordAtPosition(position);
      if (!w || !newName || !/^[a-zA-Z_$][\w$]*$/.test(newName)) return null;
      const activeFile = liveAnalysis.getActiveFile();
      const lsp = typeof window !== 'undefined' && window.RoyLang?.lsp;
      if (lsp && typeof lsp.renameSymbol === 'function') {
        try {
          const res = lsp.renameSymbol(model.getValue(), position.lineNumber, position.column, newName, liveAnalysis.getProjectFiles());
          if (res && res.ok && res.files) {
            if (typeof liveAnalysis.onApplyProjectFiles === 'function') {
              const otherFiles = {};
              for (const [f, content] of Object.entries(res.files)) {
                if (f !== activeFile) otherFiles[f] = content;
              }
              if (Object.keys(otherFiles).length) liveAnalysis.onApplyProjectFiles(otherFiles, res.totalChanges || 0);
            }
            const curEdits = (res.edits && res.edits[activeFile]) || [];
            if (curEdits.length) {
              return {
                edits: curEdits.map(ed => ({
                  resource: model.uri,
                  textEdit: {
                    range: new monaco.Range(ed.line, ed.col, ed.line, ed.col + (ed.oldText || w.word).length),
                    text: ed.newText || newName
                  }
                }))
              };
            }
          }
        } catch {}
      }
      const matches = model.findMatches(w.word, true, false, true, null, false);
      return {
        edits: matches.map(m => ({
          resource: model.uri,
          textEdit: { range: m.range, text: newName }
        }))
      };
    }
  });

  monaco.languages.registerCodeActionProvider('roy', {
    provideCodeActions: (model, range) => {
      const lsp = typeof window !== 'undefined' && window.RoyLang?.lsp;
      if (!lsp || typeof lsp.getQuickFixes !== 'function') return { actions: [], dispose: () => {} };
      try {
        const fixes = lsp.getQuickFixes(model.getValue(), range.startLineNumber, liveAnalysis.getProjectFiles()) || [];
        const actions = (Array.isArray(fixes) ? fixes : []).map(fx => {
          const targetLine = Math.max(1, fx.line || range.startLineNumber);
          const editRange = fx.range
            ? new monaco.Range(fx.range.startLine || targetLine, fx.range.startCol || 1, fx.range.endLine || targetLine, fx.range.endCol || model.getLineMaxColumn(targetLine))
            : new monaco.Range(targetLine, 1, targetLine, model.getLineMaxColumn(targetLine));
          const text = fx.replacement ?? fx.newText ?? fx.text ?? null;
          if (text == null) return null;
          return {
            title: fx.title || fx.message || 'Исправить (RoyLang LSP)',
            kind: 'quickfix',
            edit: { edits: [{ resource: model.uri, textEdit: { range: editRange, text } }] },
            isPreferred: true
          };
        }).filter(Boolean);
        return { actions, dispose: () => {} };
      } catch {
        return { actions: [], dispose: () => {} };
      }
    }
  });

  monaco.languages.registerDocumentFormattingEditProvider('roy', {
    provideDocumentFormattingEdits: (model) => {
      if (typeof window === 'undefined' || !window.RoyLang || typeof window.RoyLang.format !== 'function') return [];
      const src = model.getValue();
      const formatted = window.RoyLang.format(src);
      if (typeof formatted !== 'string' || formatted === src) return [];
      return [{
        range: model.getFullModelRange(),
        text: formatted
      }];
    }
  });
}

export function detectMonacoLang(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  if (ext === 'roy' || ext === 'roylang') return 'roy';
  if (ext === 'royson' || ext === 'royscene' || ext === 'royprefab' || ext === 'royanim' || ext === 'roydata' || ext === 'roymodel' || ext === 'royui') return 'royson';
  if (ext === 'royproj' || ext === 'roypkg') return 'royproj';
  if (ext === 'json' || ext === 'jsonl' || ext === 'tmj' || ext === 'ldtk' || ext === 'gltf') return 'json';
  if (ext === 'lua' || ext === 'luau') return 'lua';
  if (ext === 'gd') return 'gdscript';
  if (ext === 'py') return 'python';
  if (ext === 'glsl' || ext === 'frag' || ext === 'vert' || ext === 'wgsl' || ext === 'hlsl' || ext === 'cpp' || ext === 'c' || ext === 'h' || ext === 'hpp') return 'cpp';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'md') return 'markdown';
  if (ext === 'tmx' || ext === 'xml' || ext === 'svg') return 'xml';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'ini' || ext === 'cfg' || ext === 'tscn' || ext === 'tres' || ext === 'godot') return 'ini';
  if (ext === 'bat') return 'bat';
  if (ext === 'ps1') return 'powershell';
  if (ext === 'sh') return 'shell';
  if (ext === 'sql') return 'sql';
  if (ext === 'rs') return 'rust';
  if (ext === 'cs') return 'csharp';
  return 'plaintext';
}

export async function createRoyEditor(hostEl, { onChange, onSave, onRun, onCursor, onCmdPalette, onToggleBreakpoint }) {
  let wordWrapOn = false;
  let minimapOn = true;
  let fontSize = 13;

  try {
    const monaco = await loadMonacoScript();
    registerRoyLanguage(monaco);
    const editor = monaco.editor.create(hostEl, {
      value: '',
      language: 'roy',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize,
      tabSize: 2,
      minimap: { enabled: minimapOn },
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      colorDecorators: true,
      glyphMargin: true,
      lightbulb: { enabled: 'on' }
    });

    let bpDecoIds = [];
    let dbgLineDecoIds = [];
    editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position && onToggleBreakpoint) {
        onToggleBreakpoint(e.target.position.lineNumber);
      }
    });

    editor.onDidChangeModelContent(() => onChange(editor.getValue()));
    if (onCursor) {
      editor.onDidChangeCursorPosition((e) => onCursor(e.position.lineNumber, e.position.column));
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
    editor.addCommand(monaco.KeyCode.F5, () => onRun());
    if (onCmdPalette) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => onCmdPalette());
    }

    return {
      isMonaco: true,
      focus: () => editor.focus(),
      getValue: () => editor.getValue(),
      setValue: (text) => { if (editor.getValue() !== text) editor.setValue(text); },
      setLanguage: (langId) => {
        const model = editor.getModel();
        if (model && model.getLanguageId() !== langId) {
          monaco.editor.setModelLanguage(model, langId);
        }
      },
      revealLine: (line) => { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus(); },
      getPosition: () => { const p = editor.getPosition(); return p ? { line: p.lineNumber, col: p.column } : { line: 1, col: 1 }; },
      setPosition: (line, col = 1) => {
        const ln = Math.max(1, Number(line) || 1);
        const c = Math.max(1, Number(col) || 1);
        editor.setPosition({ lineNumber: ln, column: c });
        editor.revealLineInCenter(ln);
      },
      insertText: (txt) => {
        const sel = editor.getSelection();
        if (!sel) return;
        editor.executeEdits('api-insert', [{ range: sel, text: txt, forceMoveMarkers: true }]);
        editor.focus();
      },
      trigger: (cmd) => {
        editor.focus();
        editor.trigger('menu', cmd, null);
      },
      runAction: (actionId) => {
        editor.focus();
        const a = editor.getAction(actionId);
        if (a) a.run();
        else editor.trigger('menu', actionId, null);
      },
      execClipboard: async (op) => {
        editor.focus();
        const model = editor.getModel();
        const sel = editor.getSelection();
        if (op === 'copy' || op === 'cut') {
          const text = model && sel ? model.getValueInRange(sel) : '';
          let copied = false;
          if (text && navigator.clipboard && navigator.clipboard.writeText) {
            try {
              await navigator.clipboard.writeText(text);
              copied = true;
            } catch {}
          }
          if (!copied) {
            try { document.execCommand(op); } catch {}
          } else if (op === 'cut' && sel) {
            editor.executeEdits('menu-cut', [{ range: sel, text: '', forceMoveMarkers: true }]);
          }
        } else if (op === 'paste') {
          let pasted = false;
          if (navigator.clipboard && navigator.clipboard.readText) {
            try {
              const text = await navigator.clipboard.readText();
              if (typeof text === 'string' && sel) {
                editor.executeEdits('menu-paste', [{ range: sel, text, forceMoveMarkers: true }]);
                pasted = true;
              }
            } catch {}
          }
          if (!pasted) {
            try { document.execCommand('paste'); } catch {}
          }
        }
      },
      toggleWordWrap: () => {
        wordWrapOn = !wordWrapOn;
        editor.updateOptions({ wordWrap: wordWrapOn ? 'on' : 'off' });
        return wordWrapOn;
      },
      toggleMinimap: () => {
        minimapOn = !minimapOn;
        editor.updateOptions({ minimap: { enabled: minimapOn } });
        return minimapOn;
      },
      adjustFontSize: (delta) => {
        fontSize = Math.max(10, Math.min(28, fontSize + delta));
        editor.updateOptions({ fontSize });
        return fontSize;
      },
      setFontSize: (sz) => {
        fontSize = Math.max(10, Math.min(28, Number(sz) || 13));
        editor.updateOptions({ fontSize });
        return fontSize;
      },
      setTheme: (themeName) => {
        monaco.editor.setTheme(themeName || 'vs-dark');
      },
      getOptionsState: () => ({ wordWrap: wordWrapOn, minimap: minimapOn, fontSize }),
      setMarkers: (diags) => {
        const model = editor.getModel();
        if (!model) return;
        monaco.editor.setModelMarkers(model, 'roylang', diags.map(d => ({
          severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: d.message,
          startLineNumber: Math.max(1, d.line || 1),
          startColumn: Math.max(1, d.col || 1),
          endLineNumber: Math.max(1, d.line || 1),
          endColumn: Math.max(2, (d.col || 1) + 8)
        })));
      },
      setBreakpoints: (lines) => {
        const list = Array.isArray(lines) ? lines : [];
        bpDecoIds = editor.deltaDecorations(bpDecoIds, list.map(ln => ({
          range: new monaco.Range(ln, 1, ln, 1),
          options: { isWholeLine: false, glyphMarginClassName: 'roy-bp-glyph', glyphMarginHoverMessage: { value: `Breakpoint · строка ${ln}` } }
        })));
      },
      setDebugCurrentLine: (line) => {
        dbgLineDecoIds = editor.deltaDecorations(dbgLineDecoIds, line ? [{
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: 'roy-dbg-line', glyphMarginClassName: 'roy-dbg-arrow' }
        }] : []);
      }
    };
  } catch {
    const ta = document.createElement('textarea');
    ta.className = 'fallback-editor';
    ta.spellcheck = false;
    hostEl.appendChild(ta);
    ta.addEventListener('input', () => onChange(ta.value));
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); onSave(); }
      if (e.code === 'F5') { e.preventDefault(); onRun(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyP' && onCmdPalette) { e.preventDefault(); onCmdPalette(); }
    });
    return {
      isMonaco: false,
      focus: () => ta.focus(),
      getValue: () => ta.value,
      setValue: (text) => { ta.value = text; },
      setLanguage: () => {},
      revealLine: () => ta.focus(),
      getPosition: () => ({ line: 1, col: 1 }),
      setPosition: () => {},
      insertText: (txt) => {
        const s = ta.selectionStart || 0;
        ta.value = ta.value.slice(0, s) + txt + ta.value.slice(ta.selectionEnd || s);
        onChange(ta.value);
        ta.focus();
      },
      trigger: (cmd) => {
        ta.focus();
        try { document.execCommand(cmd); } catch {}
      },
      runAction: (actionId) => {
        ta.focus();
        if (actionId === 'editor.action.selectAll') ta.select();
      },
      execClipboard: async (op) => {
        ta.focus();
        try { document.execCommand(op); } catch {}
      },
      toggleWordWrap: () => {
        wordWrapOn = !wordWrapOn;
        ta.style.whiteSpace = wordWrapOn ? 'pre-wrap' : 'pre';
        return wordWrapOn;
      },
      toggleMinimap: () => {
        minimapOn = !minimapOn;
        return minimapOn;
      },
      adjustFontSize: (delta) => {
        fontSize = Math.max(10, Math.min(28, fontSize + delta));
        ta.style.fontSize = fontSize + 'px';
        return fontSize;
      },
      getOptionsState: () => ({ wordWrap: wordWrapOn, minimap: minimapOn, fontSize }),
      setMarkers: () => {},
      setBreakpoints: () => {},
      setDebugCurrentLine: () => {}
    };
  }
}

export async function createDiffEditor(hostEl, originalText, modifiedText, langId = 'roy') {
  const monaco = await loadMonacoScript();
  registerRoyLanguage(monaco);
  const diffEd = monaco.editor.createDiffEditor(hostEl, {
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    scrollBeyondLastLine: false,
    fontSize: 13
  });
  const origModel = monaco.editor.createModel(String(originalText ?? ''), langId);
  const modModel = monaco.editor.createModel(String(modifiedText ?? ''), langId);
  diffEd.setModel({ original: origModel, modified: modModel });
  return {
    dispose: () => {
      diffEd.dispose();
      origModel.dispose();
      modModel.dispose();
    }
  };
}

export async function createSecondaryEditor(hostEl, { onChange, onSave, onRun }) {
  try {
    const monaco = await loadMonacoScript();
    registerRoyLanguage(monaco);
    const ed = monaco.editor.create(hostEl, {
      value: '',
      language: 'roy',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      tabSize: 2,
      minimap: { enabled: false },
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      colorDecorators: true
    });
    ed.onDidChangeModelContent(() => { if (onChange) onChange(ed.getValue()); });
    if (onSave) ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
    if (onRun) ed.addCommand(monaco.KeyCode.F5, () => onRun());
    return {
      isMonaco: true,
      focus: () => ed.focus(),
      getValue: () => ed.getValue(),
      setValue: (text) => { if (ed.getValue() !== text) ed.setValue(text); },
      setLanguage: (langId) => {
        const model = ed.getModel();
        if (model && model.getLanguageId() !== langId) monaco.editor.setModelLanguage(model, langId);
      },
      dispose: () => ed.dispose()
    };
  } catch {
    const ta = document.createElement('textarea');
    ta.className = 'fallback-editor';
    ta.spellcheck = false;
    hostEl.appendChild(ta);
    ta.addEventListener('input', () => { if (onChange) onChange(ta.value); });
    return {
      isMonaco: false,
      focus: () => ta.focus(),
      getValue: () => ta.value,
      setValue: (text) => { ta.value = text; },
      setLanguage: () => {},
      dispose: () => ta.remove()
    };
  }
}
