// The code editor.
//
// Regular mode: CodeMirror 6 (indent, brackets, Gleam highlighting).
// Neovim mode: Ace Editor with its built-in Vim keymap from ajaxorg/ace
//   (https://github.com/ajaxorg/ace — keybinding-vim), plus a custom Gleam
//   highlight mode so colours match Regular.
//
// Lustre renders only an empty `unsafe_raw_html` mount node (#code-editor) and
// never re-patches it, so the editor DOM we inject survives re-renders.
// reattachEditor moves the live editor if Lustre replaces the mount node.

let cmView = null;
let aceEditor = null;
let aceVimStatus = null;
let aceStatusTimer = null;
let aceResizeBound = false;
let cmOnChange = null;
let cmModulePromise = null;
let aceModulePromise = null;
let cmObserver = null;
let cmKeymapMode = "regular"; // "regular" | "neovim"
let cmCreate = null;
let cmMountGen = 0;
let gleamModeReady = false;

// ajaxorg/ace (https://github.com/ajaxorg/ace) — noconflict build + keybinding-vim.
const ACE_BASE =
  "https://unpkg.com/ace-builds@1.36.5/src-min-noconflict";

// Shared editor chrome so Regular ↔ Neovim does not jump.
const EDITOR_FONT =
  'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const EDITOR_FONT_SIZE = 13;

// ── Gleam highlighting (CodeMirror) ──────────────────────────────────────────

function defineGleam(StreamLanguage) {
  const keywords = new Set([
    "fn", "case", "let", "const", "import", "use", "type", "pub", "as", "if",
    "todo", "panic", "assert",
  ]);
  return StreamLanguage.define({
    token(stream) {
      if (stream.eatSpace()) return null;
      if (stream.match(/^\/\/.*/)) return "comment";
      if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
      if (stream.match(/^[0-9]+\.[0-9]+/) || stream.match(/^[0-9]+/)) return "number";
      if (stream.match(/^(True|False|Nil|Ok|Error)\b/)) return "atom";
      const word = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (word) {
        if (keywords.has(word[0])) return "keyword";
        if (/^[A-Z]/.test(word[0])) return "typeName";
        return "variableName";
      }
      if (stream.match(/^(\+\.|-\.|\*\.|\/\.|<=\.|>=\.|<\.|>\.|==|!=|->|<-|\|>|=)/))
        return "operator";
      stream.next();
      return null;
    },
    languageData: { commentTokens: { line: "//" } },
  });
}

// ── Gleam highlighting (Ace) ─────────────────────────────────────────────────

function ensureAceGleamMode() {
  if (gleamModeReady || !window.ace || !window.ace.define) return;
  gleamModeReady = true;
  const ace = window.ace;

  ace.define(
    "ace/mode/gleam_highlight_rules",
    ["require", "exports", "module", "ace/lib/oop", "ace/mode/text_highlight_rules"],
    function (require, exports, _module) {
      const oop = require("ace/lib/oop");
      const TextHighlightRules = require("ace/mode/text_highlight_rules").TextHighlightRules;
      function GleamHighlightRules() {
        this.$rules = {
          start: [
            { token: "comment", regex: /\/\/.*/ },
            { token: "string", regex: /"(?:[^"\\]|\\.)*"/ },
            { token: "constant.numeric", regex: /\b\d+(?:\.\d+)?\b/ },
            {
              token: "constant.language",
              regex: /\b(?:True|False|Nil|Ok|Error)\b/,
            },
            {
              token: "keyword",
              regex:
                /\b(?:fn|case|let|const|import|use|type|pub|as|if|todo|panic|assert)\b/,
            },
            { token: "entity.name.type", regex: /\b[A-Z][A-Za-z0-9_]*\b/ },
            {
              token: "keyword.operator",
              regex: /\+\.|\-\.|\*\.|\/\.|<=\.|>=\.|<\.|>\.|==|!=|->|<-|\|>|=>|=/,
            },
            { token: "paren.lparen", regex: /[[({]/ },
            { token: "paren.rparen", regex: /[\])}]/ },
            { token: "text", regex: /\s+/ },
            { token: "identifier", regex: /[a-z_][A-Za-z0-9_]*/ },
          ],
        };
        this.normalizeRules();
      }
      oop.inherits(GleamHighlightRules, TextHighlightRules);
      exports.GleamHighlightRules = GleamHighlightRules;
    },
  );

  ace.define(
    "ace/mode/gleam",
    [
      "require",
      "exports",
      "module",
      "ace/lib/oop",
      "ace/mode/text",
      "ace/mode/gleam_highlight_rules",
    ],
    function (require, exports, _module) {
      const oop = require("ace/lib/oop");
      const TextMode = require("ace/mode/text").Mode;
      const GleamHighlightRules = require("ace/mode/gleam_highlight_rules")
        .GleamHighlightRules;
      function Mode() {
        this.HighlightRules = GleamHighlightRules;
        this.$behaviour = this.$defaultBehaviour;
      }
      oop.inherits(Mode, TextMode);
      Mode.prototype.$id = "ace/mode/gleam";
      exports.Mode = Mode;
    },
  );
}

// ── CodeMirror (Regular) ─────────────────────────────────────────────────────

function loadCodeMirror() {
  if (cmModulePromise) return cmModulePromise;
  const V = "6";
  cmModulePromise = Promise.all([
    import(`https://esm.sh/@codemirror/view@${V}`),
    import(`https://esm.sh/@codemirror/state@${V}`),
    import(`https://esm.sh/@codemirror/commands@${V}`),
    import(`https://esm.sh/@codemirror/language@${V}`),
    import(`https://esm.sh/@codemirror/autocomplete@${V}`),
    import(`https://esm.sh/@lezer/highlight@1`),
  ]).then(([view, state, commands, language, autocomplete, highlight]) => {
    const { tags: t } = highlight;
    const theme = view.EditorView.theme(
      {
        "&": {
          color: "#d4c5a0",
          backgroundColor: "#0d0d1a",
          height: "100%",
          fontSize: `${EDITOR_FONT_SIZE}px`,
        },
        ".cm-content": {
          fontFamily: EDITOR_FONT,
          fontSize: `${EDITOR_FONT_SIZE}px`,
          // Match Ace's default line box so switching modes does not jump.
          lineHeight: "1.5",
          padding: "8px 0",
        },
        ".cm-gutters": {
          backgroundColor: "#0d0d1a",
          color: "#3a3a5e",
          border: "none",
          minWidth: "40px",
        },
        ".cm-activeLine": { backgroundColor: "#16162c" },
        ".cm-activeLineGutter": { backgroundColor: "#16162c" },
        "&.cm-focused .cm-matchingBracket": {
          backgroundColor: "#2a4a3a",
          color: "#fff",
        },
        ".cm-scroller": { overflow: "auto", fontFamily: EDITOR_FONT },
        "&.cm-focused": { outline: "1px solid #6a6aaa" },
      },
      { dark: true },
    );
    const highlightStyle = language.HighlightStyle.define([
      { tag: t.keyword, color: "#c792ea" },
      { tag: t.comment, color: "#6a7a6a", fontStyle: "italic" },
      { tag: t.string, color: "#c3e88d" },
      { tag: t.number, color: "#f78c6c" },
      { tag: [t.atom, t.bool], color: "#82aaff" },
      { tag: t.typeName, color: "#ffcb6b" },
      { tag: t.variableName, color: "#d4c5a0" },
      { tag: t.operator, color: "#89ddff" },
    ]);
    const gleam = defineGleam(language.StreamLanguage);

    function create(parent, doc, onChange) {
      const updateListener = view.EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange(u.state.doc.toString());
      });
      const startState = state.EditorState.create({
        doc,
        extensions: [
          view.lineNumbers(),
          view.highlightActiveLine(),
          view.highlightActiveLineGutter(),
          commands.history(),
          view.drawSelection(),
          language.indentOnInput(),
          language.indentUnit.of("  "),
          language.bracketMatching(),
          autocomplete.closeBrackets(),
          language.syntaxHighlighting(highlightStyle),
          gleam,
          view.keymap.of([
            ...autocomplete.closeBracketsKeymap,
            ...commands.defaultKeymap,
            ...commands.historyKeymap,
            commands.indentWithTab,
          ]),
          theme,
          // No soft-wrap: matches Ace/Neovim and keeps columns stable.
          updateListener,
        ],
      });
      return new view.EditorView({ state: startState, parent });
    }

    cmCreate = create;
    return { create };
  });
  return cmModulePromise;
}

// ── Ace + Vim (Neovim) — https://github.com/ajaxorg/ace ──────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-ace-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(src)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.dataset.aceSrc = src;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function loadAce() {
  if (aceModulePromise) return aceModulePromise;
  aceModulePromise = (async () => {
    await loadScript(`${ACE_BASE}/ace.js`);
    if (!window.ace || typeof window.ace.require !== "function") {
      throw new Error("Ace loader did not set window.ace.require");
    }
    const ace = window.ace.require("ace/ace");
    if (!ace || typeof ace.edit !== "function") {
      throw new Error("Ace did not export ace.edit");
    }
    ace.config.set("basePath", ACE_BASE);
    ace.config.set("modePath", ACE_BASE);
    ace.config.set("themePath", ACE_BASE);
    ace.config.set("workerPath", ACE_BASE);
    await loadScript(`${ACE_BASE}/keybinding-vim.js`);
    await loadScript(`${ACE_BASE}/theme-tomorrow_night.js`);
    ensureAceGleamMode();
    return ace;
  })().catch((e) => {
    aceModulePromise = null;
    throw e;
  });
  return aceModulePromise;
}

function destroyEditors() {
  if (aceStatusTimer) {
    clearInterval(aceStatusTimer);
    aceStatusTimer = null;
  }
  if (cmView) {
    cmView.destroy();
    cmView = null;
  }
  if (aceEditor) {
    aceEditor.destroy();
    aceEditor = null;
  }
  aceVimStatus = null;
}

function currentDoc() {
  if (cmView) return cmView.state.doc.toString();
  if (aceEditor) return aceEditor.getValue();
  return "";
}

function buildEditorShell(el, aceHost) {
  el.innerHTML = "";
  const host = document.createElement("div");
  host.className = aceHost ? "editor-host ace-editor" : "editor-host";
  el.appendChild(host);
  // Overlay status: does not change editor height when shown/hidden.
  const status = document.createElement("div");
  status.className = "vim-status" + (aceHost ? "" : " vim-status-hidden");
  status.textContent = aceHost ? "-- NORMAL --" : "";
  el.appendChild(status);
  return { host, status };
}

function mountCodeMirror(el, doc, onChange) {
  destroyEditors();
  const { host } = buildEditorShell(el, false);
  cmView = cmCreate(host, doc, onChange);
  cmView.focus();
}

function onAceResize() {
  if (aceEditor) aceEditor.resize();
}

function mountAce(ace, el, doc, onChange) {
  destroyEditors();
  const { host, status } = buildEditorShell(el, true);
  aceVimStatus = status;

  ensureAceGleamMode();

  const editor = ace.edit(host, {
    value: doc,
    theme: "ace/theme/tomorrow_night",
    mode: "ace/mode/gleam",
    fontSize: EDITOR_FONT_SIZE,
    showPrintMargin: false,
    wrap: false,
    tabSize: 2,
    useSoftTabs: true,
    highlightActiveLine: true,
    behavioursEnabled: true,
  });
  editor.setKeyboardHandler("ace/keyboard/vim");
  editor.session.setUseWrapMode(false);
  editor.session.setMode("ace/mode/gleam");
  editor.setOption("fontFamily", EDITOR_FONT);
  // No fold column: Ace otherwise pads ~19px left of line numbers.
  editor.setShowFoldWidgets(false);
  editor.renderer.setScrollMargin(8, 8, 0, 0);
  editor.renderer.setShowGutter(true);
  // Match CodeMirror's ~25px gap from line-number digits to code start.
  editor.renderer.setPadding(20);

  const syncStatus = () => {
    const kb = editor.getKeyboardHandler();
    let raw = "";
    try {
      if (kb && typeof kb.getStatusText === "function") {
        raw = kb.getStatusText(editor, editor.session.$vim) || "";
      }
    } catch (_e) {
      raw = (kb && kb.status) || "";
    }
    if (aceVimStatus) {
      const label = String(raw).trim();
      aceVimStatus.textContent = label
        ? label.startsWith("--")
          ? label
          : `-- ${label.toUpperCase()} --`
        : "-- NORMAL --";
    }
  };
  editor.on("changeStatus", syncStatus);
  editor.on("keyboardActivity", syncStatus);
  editor.on("click", syncStatus);
  editor.session.on("change", () => {
    if (onChange) onChange(editor.getValue());
    syncStatus();
  });
  aceStatusTimer = setInterval(() => {
    if (!aceEditor) {
      clearInterval(aceStatusTimer);
      aceStatusTimer = null;
      return;
    }
    syncStatus();
  }, 150);

  if (!aceResizeBound) {
    aceResizeBound = true;
    window.addEventListener("animator-col-resize", onAceResize);
    window.addEventListener("resize", onAceResize);
  }

  aceEditor = editor;
  requestAnimationFrame(() => {
    editor.resize();
    editor.focus();
    syncStatus();
  });
}

function applyMode(doc) {
  const el = document.getElementById("code-editor");
  if (!el) return Promise.resolve();
  const onChange = (t) => {
    if (cmOnChange) cmOnChange(t);
  };
  if (cmKeymapMode === "neovim") {
    return loadAce().then((ace) => {
      mountAce(ace, el, doc, onChange);
    });
  }
  return loadCodeMirror().then(() => {
    mountCodeMirror(el, doc, onChange);
  });
}

// ── Shared mount / reattach ──────────────────────────────────────────────────

function waitForElement(id, maxFrames) {
  return new Promise((resolve) => {
    let tries = 0;
    const check = () => {
      const el = document.getElementById(id);
      if (el) return resolve(el);
      if (tries++ >= maxFrames) return resolve(null);
      requestAnimationFrame(check);
    };
    check();
  });
}

function reattachEditor() {
  const el = document.getElementById("code-editor");
  if (!el) return;
  if (cmView && !cmView.dom.isConnected) {
    const host = el.querySelector(".editor-host") || el;
    host.replaceChildren(cmView.dom);
    cmView.requestMeasure();
    if (document.activeElement === document.body) cmView.focus();
    return;
  }
  if (aceEditor) {
    const host = el.querySelector(".ace-editor, .editor-host");
    if (host && !host.isConnected) {
      const doc = aceEditor.getValue();
      applyMode(doc);
    } else if (aceEditor) {
      aceEditor.resize();
    }
  }
}

export function setKeymap(mode) {
  const next = mode === "neovim" ? "neovim" : "regular";
  if (next === cmKeymapMode && (cmView || aceEditor)) return;
  cmKeymapMode = next;
  const gen = ++cmMountGen;
  applyMode(currentDoc()).catch((e) => {
    if (gen !== cmMountGen) return;
    console.error("Editor keymap failed:", e);
  });
}

export function mountEditor(initialText, onChange) {
  destroyEditors();
  cmOnChange = onChange;
  const gen = ++cmMountGen;
  if (!cmObserver) {
    cmObserver = new MutationObserver(reattachEditor);
    cmObserver.observe(document.body, { childList: true, subtree: true });
  }
  waitForElement("code-editor", 120).then((mount) => {
    if (!mount || gen !== cmMountGen) return;
    applyMode(initialText).catch((e) =>
      console.error("Editor failed to load:", e),
    );
  });
}
