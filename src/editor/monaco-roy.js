import { getEngineState } from '../core/engine-manager.js';

const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';

let monacoInstance = null;
let liveMeta = {
  version: 'v6.5',
  keywords: [],
  apis: [],
  docsByName: new Map()
};

function syncMetaFromEngine(meta) {
  const src = meta || getEngineState();
  liveMeta = {
    version: src.version || 'v6.5',
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
}

function applyRoyMonarchTokens(monaco) {
  monaco.languages.setMonarchTokensProvider('roy', {
    keywords: liveMeta.keywords,
    apis: liveMeta.apis,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
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

function registerRoyLanguage(monaco) {
  monacoInstance = monaco;
  registerRoysonLanguages(monaco);
  if (monaco.languages.getLanguages().some(l => l.id === 'roy')) {
    applyRoyMonarchTokens(monaco);
    return;
  }
  monaco.languages.register({ id: 'roy', extensions: ['.roy', '.roylang'] });
  applyRoyMonarchTokens(monaco);

  monaco.languages.registerCompletionItemProvider('roy', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      };
      const items = [
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
      if (!doc) return null;
      return {
        range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn),
        contents: [
          { value: '```roy\n' + doc.sig + '\n```' },
          { value: `**${doc.kind || 'API'}** · \`${doc.cat || 'core'}\` (${doc.ver || liveMeta.version})\n\n${doc.desc || ''}` }
        ]
      };
    }
  });
}

export function detectMonacoLang(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  if (ext === 'roy' || ext === 'roylang') return 'roy';
  if (ext === 'royson') return 'royson';
  if (ext === 'royproj') return 'royproj';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'xml' || ext === 'svg') return 'xml';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return 'plaintext';
}

export async function createRoyEditor(hostEl, { onChange, onSave, onRun, onCursor, onCmdPalette }) {
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
      cursorBlinking: 'smooth'
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
      setMarkers: () => {}
    };
  }
}
