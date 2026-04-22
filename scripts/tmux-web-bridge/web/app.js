"use strict";

// The page is loaded with ?token=... guarding it; carry the same token over
// to the WebSocket URL so the server's auth middleware lets us through.
const _urlToken = new URLSearchParams(location.search).get("token") || "";
const _wsQs = _urlToken ? ("?token=" + encodeURIComponent(_urlToken)) : "";
const wsUrl =
  (location.protocol === "https:" ? "wss://" : "ws://") +
  location.host + "/ws" + _wsQs;

const canvas      = document.getElementById("term");
const termWrap    = document.getElementById("term-wrap");
const toolbarEl   = document.getElementById("toolbar");
const emptyEl     = document.getElementById("empty");
const listEl      = document.getElementById("panes-list");
const inputEl     = document.getElementById("input");
const sendBtn     = document.getElementById("send");
const keyBtns     = document.querySelectorAll(".key-btn[data-key]");
const newBtn      = document.getElementById("new-pane-btn");
const killBtn     = document.getElementById("kill-btn");
const modalBack   = document.getElementById("modal-backdrop");
const modalHost   = document.getElementById("new-host");
const modalCwd    = document.getElementById("new-cwd");
const modalSession = document.getElementById("new-session");
const modalError  = document.getElementById("new-error");
const modalSubmit = document.getElementById("new-submit");
const modalCancel = document.getElementById("new-cancel");
const connEl      = document.getElementById("conn");
const termZoomVal = document.getElementById("term-zoom-val");
const uiZoomVal   = document.getElementById("ui-zoom-val");
const fitBtn      = document.getElementById("fit-btn");
const copyBtn     = document.getElementById("copy-btn");
const exitScrollBtn = document.getElementById("exit-scroll-btn");
const clearInputBtn = document.getElementById("clear-input-btn");

const BASE_FONT_SIZE = 20;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.05;
const LINE_HEIGHT = 1.25;
const FONT_FAMILY = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

// Warm Solarized-light terminal palette (high contrast against cream bg).
const BG_DEFAULT = "#fdf6e3";
const FG_DEFAULT = "#3a2e1f";
const PALETTE = {
  black:         "#073642",
  red:           "#c1351a",
  green:         "#657c00",
  brown:         "#9b5100",
  yellow:        "#9b5100",
  blue:          "#1e6fb4",
  magenta:       "#b8336b",
  cyan:          "#1f6b63",
  // On a cream background these were the "invisible" ones — remapped to
  // warm mid/dark greys so light-colored text (claude's dim labels, help
  // hints, etc.) stays readable.
  white:         "#6b5e4a",
  brightblack:   "#8a7a5e",
  brightred:     "#b23a14",
  brightgreen:   "#6f8500",
  brightbrown:   "#a85500",
  brightyellow:  "#a85500",
  brightblue:    "#1a5f9e",
  brightmagenta: "#c02a6a",
  brightcyan:    "#1e7f78",
  brightwhite:   "#4a4035",
};

// Perceptual luminance of a "#rrggbb" string, 0..1.
function _lum(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
// Background luminance (cream ≈ 0.93). Anything close to that is unreadable.
const BG_LUM = _lum(BG_DEFAULT);

function _darken(hex, factor) {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * factor);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * factor);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * factor);
  const h = (v) => v.toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

function _mix(hexA, hexB, t) {
  const rA = parseInt(hexA.slice(1, 3), 16);
  const gA = parseInt(hexA.slice(3, 5), 16);
  const bA = parseInt(hexA.slice(5, 7), 16);
  const rB = parseInt(hexB.slice(1, 3), 16);
  const gB = parseInt(hexB.slice(3, 5), 16);
  const bB = parseInt(hexB.slice(5, 7), 16);
  const r = Math.round(rA * (1 - t) + rB * t);
  const g = Math.round(gA * (1 - t) + gB * t);
  const b = Math.round(bA * (1 - t) + bB * t);
  const h = (v) => v.toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

// Enforce readable contrast of a foreground against a specific background.
// Both args are "#rrggbb". If the luminance delta is already >= 0.45 we leave
// the color alone; otherwise we push the fg toward black (on a light bg) or
// toward white (on a dark bg) until the delta is sufficient.
const CONTRAST_MIN = 0.45;
function ensureFgContrast(hex, bgHex) {
  if (!hex || hex[0] !== "#" || hex.length !== 7) return hex;
  const bgL = (bgHex && bgHex[0] === "#" && bgHex.length === 7) ? _lum(bgHex) : BG_LUM;
  let l = _lum(hex);
  if (Math.abs(l - bgL) >= CONTRAST_MIN) return hex;
  const towardDark = bgL > 0.55;   // light bg → darken fg; dark bg → lighten fg
  let out = hex;
  for (let i = 0; i < 5; i++) {
    out = towardDark ? _darken(out, 0.6) : _mix(out, "#ffffff", 0.35);
    l = _lum(out);
    if (Math.abs(l - bgL) >= CONTRAST_MIN) break;
  }
  return out;
}

// Claude Code TUI paints dark backgrounds for code blocks, diffs, tool panels.
// On the cream page these used to wash out to near-white (and the light text
// on them vanished). Now we keep them visibly *tinted* — deeper than the page
// but still light enough to read dark ink on. Target luminance band: 0.58–0.72
// (page is ~0.93).
function ensureBgContrast(hex) {
  if (!hex || hex[0] !== "#" || hex.length !== 7) return hex;
  const l = _lum(hex);
  // Backgrounds close to the page color: leave alone.
  if (l >= BG_LUM - 0.15) return hex;
  // Very dark panel (l ~0.05) → mix heavily with cream (t~0.78) → l ~0.65.
  // Medium panel  (l ~0.35) → mix less            (t~0.55) → l ~0.65.
  // Pick t so the result lands at ~TARGET.
  const TARGET = 0.66;
  // _mix result luminance ≈ (1-t)*l + t*BG_LUM. Solve for t.
  let t = (TARGET - l) / (BG_LUM - l);
  t = Math.max(0.35, Math.min(0.78, t));
  return _mix(hex, BG_DEFAULT, t);
}

function resolveColor(c, fallback) {
  if (!c) return fallback;
  if (PALETTE[c]) return PALETTE[c];
  if (/^[0-9a-fA-F]{6}$/.test(c)) return "#" + c;
  return fallback;
}

const ctx = canvas.getContext("2d");
let dpr = window.devicePixelRatio || 1;

// ── Zoom (two independent axes: terminal render vs. UI chrome) ──
const TERM_ZOOM_KEY = "tmux-bridge.term-zoom";
const UI_ZOOM_KEY   = "tmux-bridge.ui-zoom";

function loadZoom(key, fallback) {
  const v = parseFloat(localStorage.getItem(key) || "");
  if (!isFinite(v) || v < MIN_ZOOM || v > MAX_ZOOM) return fallback;
  return v;
}
let termZoom = loadZoom(TERM_ZOOM_KEY, 1.0);
let uiZoom   = loadZoom(UI_ZOOM_KEY, 1.0);

let cellW = 0, cellH = 0, baselineY = 0;

function fontSize() { return BASE_FONT_SIZE * termZoom; }

function measureCell() {
  const probe = document.createElement("span");
  probe.style.cssText =
    "visibility:hidden;position:absolute;white-space:pre;padding:0;margin:0;" +
    "font-family:" + FONT_FAMILY + ";font-size:" + fontSize() + "px;" +
    "line-height:" + LINE_HEIGHT + ";letter-spacing:0;";
  probe.textContent = "M".repeat(100);
  document.body.appendChild(probe);
  const r = probe.getBoundingClientRect();
  cellW = r.width / 100;
  cellH = r.height;
  document.body.removeChild(probe);
  baselineY = Math.round(cellH * 0.78);
}

function updateZoomUI() {
  termZoomVal.textContent = Math.round(termZoom * 100) + "%";
  uiZoomVal.textContent   = Math.round(uiZoom * 100) + "%";
}

function applyUiZoom() {
  const z = uiZoom.toFixed(2);
  document.getElementById("sidebar").style.zoom = z;
  document.getElementById("toolbar").style.zoom = z;
  document.getElementById("input-bar").style.zoom = z;
  document.getElementById("empty").style.zoom = z;
  const hint = document.querySelector(".hint");
  if (hint) hint.style.zoom = z;
}

function setTermZoom(z) {
  termZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  localStorage.setItem(TERM_ZOOM_KEY, termZoom.toFixed(2));
  measureCell();
  updateZoomUI();
  // Cell size changed — invalidate the row-diff cache and force a canvas
  // resize, otherwise drawGrid will skip every row that still fingerprints
  // the same (which is all of them) and the canvas stays at the old size.
  lastCols = 0; lastRows = 0;
  lastRowKeys = [];
  if (lastGrid) drawGrid(lastGrid, /*keepScroll=*/true);
}

function setUiZoom(z) {
  uiZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  localStorage.setItem(UI_ZOOM_KEY, uiZoom.toFixed(2));
  updateZoomUI();
  applyUiZoom();
}

function fitPane() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Subtract the wrap padding (6px each side, from CSS) and round down so we
  // never overshoot the viewport; tmux would just clip back.
  const padX = 12, padY = 12;
  const availW = Math.max(0, termWrap.clientWidth  - padX);
  const availH = Math.max(0, termWrap.clientHeight - padY);
  if (cellW <= 0 || cellH <= 0) return;
  const cols = Math.max(20, Math.floor(availW / cellW));
  const rows = Math.max(5,  Math.floor(availH / cellH));
  // Resize every known pane, not just the active one, so a user with several
  // Claude sessions doesn't have to click through each to fit it.
  for (const p of panes) {
    ws.send(JSON.stringify({ type: "resize", key: p.key, cols, rows }));
  }
}
fitBtn.onclick = fitPane;

document.getElementById("term-zoom-in").onclick    = () => setTermZoom(termZoom + ZOOM_STEP);
document.getElementById("term-zoom-out").onclick   = () => setTermZoom(termZoom - ZOOM_STEP);
document.getElementById("term-zoom-reset").onclick = () => setTermZoom(1.0);
document.getElementById("ui-zoom-in").onclick      = () => setUiZoom(uiZoom + ZOOM_STEP);
document.getElementById("ui-zoom-out").onclick     = () => setUiZoom(uiZoom - ZOOM_STEP);
document.getElementById("ui-zoom-reset").onclick   = () => setUiZoom(1.0);
termWrap.addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setTermZoom(termZoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    return;
  }
  if (!activeKey) return;
  // Relay the wheel to tmux copy-mode so the pane's visible window slides
  // over its own scrollback. The next capture-pane poll redraws us.
  e.preventDefault();
  if (e.deltaY > 0 && lastGrid && lastGrid.in_copy_mode && (lastGrid.scroll_position || 0) <= 0) {
    sendScroll("exit");
    return;
  }
  // Only Shift-wheel triggers page scroll; plain wheel stays line-by-line so
  // trackpad inertia or a hard flick can't accidentally jump multiple pages.
  const up = e.deltaY < 0;
  const fast = e.shiftKey;
  sendScroll(fast ? (up ? "page_up" : "page_down") : (up ? "up" : "down"));
}, { passive: false });

// ── Pane name overrides ─────────────────────────────────────
const NAME_KEY = "tmux-bridge.names";
function loadNames() {
  try { return JSON.parse(localStorage.getItem(NAME_KEY) || "{}"); } catch { return {}; }
}
function saveNames(obj) {
  localStorage.setItem(NAME_KEY, JSON.stringify(obj));
}
let nameMap = loadNames();

function displayName(p) {
  if (nameMap[p.key]) return nameMap[p.key];
  const cwdBase = (p.cwd || "").split("/").filter(Boolean).pop() || "";
  const wname = (p.window_name || "").trim();
  // tmux auto-derives the window name from the running command (e.g. "claude",
  // "bash", "zsh"). Prefer it only when it looks like a user-set label —
  // otherwise fall back to the cwd basename so the sidebar stays meaningful.
  const generic = new Set(["", "claude", "bash", "zsh", "sh", "fish", "node", "python", "python3"]);
  if (wname && !generic.has(wname.toLowerCase())) return wname;
  return cwdBase || wname || "-";
}

// ── Canvas rendering ────────────────────────────────────────
let lastGrid = null;

function sendScroll(action) {
  if (!activeKey) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "scroll", key: activeKey, action }));
}

function resizeCanvas(cols, rows) {
  const w = Math.ceil(cols * cellW);
  const h = Math.ceil(rows * cellH);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = "alphabetic";
}

// Row fingerprints from the last paint, for diff-based redraw.
let lastCols = 0, lastRows = 0;
let lastRowKeys = [];   // lastRowKeys[y] = JSON.stringify(lines[y])

function paintRow(runs, y) {
  const yPx = y * cellH;
  const baseY = yPx + baselineY;
  // Clear the row band first.
  ctx.fillStyle = BG_DEFAULT;
  ctx.fillRect(0, yPx, lastCols * cellW, cellH);

  // Backgrounds.
  let curBg = BG_DEFAULT;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const colStart = run[0], text = run[1], fg = run[2], bg = run[3];
    const flags = run[4], width = run[5];
    const reverse = (flags & 8) !== 0;
    const fgColor = resolveColor(fg, FG_DEFAULT);
    const bgColor = resolveColor(bg, BG_DEFAULT);
    const effBg = ensureBgContrast(reverse ? fgColor : bgColor);
    if (effBg === BG_DEFAULT && !reverse) continue;
    const cellsEach = width || 1;
    const charCount = (cellsEach === 2) ? Array.from(text).length : text.length;
    if (effBg !== curBg) { ctx.fillStyle = effBg; curBg = effBg; }
    ctx.fillRect(colStart * cellW, yPx, charCount * cellsEach * cellW, cellH);
  }

  // Foreground text (grouped by font to minimize state changes).
  let curFg = null, curFont = null;
  const fsz = fontSize();
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const colStart = run[0], text = run[1], fg = run[2], bg = run[3];
    const flags = run[4], width = run[5];
    if (!text) continue;
    const reverse = (flags & 8) !== 0;
    const fgColor = resolveColor(fg, FG_DEFAULT);
    const bgColor = resolveColor(bg, BG_DEFAULT);
    // Figure out what surface the glyph will actually sit on, then ensure
    // the foreground has enough contrast against *that* surface. This is
    // what keeps code-block text (light ink on a dark panel in the source
    // ANSI, now light ink on a pastel panel) readable — the old logic only
    // compared against the page bg.
    const surfaceBg = reverse ? fgColor : ensureBgContrast(bgColor);
    const rawFg = reverse ? bgColor : fgColor;
    const effFg = ensureFgContrast(rawFg, surfaceBg);
    const bold = (flags & 1) !== 0;
    const italic = (flags & 2) !== 0;
    const underscore = (flags & 4) !== 0;
    const font = (italic ? "italic " : "") + (bold ? "bold " : "") + fsz + "px " + FONT_FAMILY;
    if (font !== curFont) { ctx.font = font; curFont = font; }
    if (effFg !== curFg) { ctx.fillStyle = effFg; curFg = effFg; }
    const cellsEach = width || 1;
    const xPx = colStart * cellW;
    if (cellsEach === 1) {
      ctx.fillText(text, xPx, baseY);
    } else {
      const chars = Array.from(text);
      const slot = 2 * cellW;
      for (let i = 0; i < chars.length; i++) {
        ctx.fillText(chars[i], xPx + i * slot, baseY);
      }
    }
    if (underscore) {
      const charCount = (cellsEach === 2) ? Array.from(text).length : text.length;
      ctx.fillRect(xPx, yPx + cellH - 1, charCount * cellsEach * cellW, 1);
    }
  }
}

function drawGrid(grid, keepScroll = false) {
  const { cols, rows, lines } = grid;

  const dimsChanged = (cols !== lastCols || rows !== lastRows);
  const forceFull = keepScroll || dimsChanged;
  if (forceFull) {
    resizeCanvas(cols, rows);
    ctx.fillStyle = BG_DEFAULT;
    ctx.fillRect(0, 0, cols * cellW, rows * cellH);
    lastCols = cols; lastRows = rows;
    lastRowKeys = new Array(rows);
    if (dimsChanged) clearSelection(/*silent=*/true);
  }

  const newKeys = new Array(lines.length);
  const selRows = selectionRowSet();
  for (let y = 0; y < lines.length; y++) {
    const k = JSON.stringify(lines[y]);
    newKeys[y] = k;
    if (!forceFull && k === lastRowKeys[y] && !selRows.has(y)) continue;
    paintRow(lines[y], y);
  }
  lastRowKeys = newKeys;
  paintSelection();
}

// ── Text selection & copy ───────────────────────────────────
// Drag on the canvas to select a region of cells; mouseup auto-copies the
// selected text (X-style). Selection is purely visual on the canvas — there
// is no real DOM selection because the terminal is rendered to <canvas>.
let selStart = null;     // {col, row} where the drag started
let selEnd   = null;     // {col, row} current end of the drag
let selecting = false;   // mouse is currently held down
let selActive = false;   // selStart/selEnd describe a visible selection

function pixelToCell(e) {
  const rect = canvas.getBoundingClientRect();
  let col = Math.floor((e.clientX - rect.left) / cellW);
  let row = Math.floor((e.clientY - rect.top) / cellH);
  if (!isFinite(col) || !isFinite(row)) return { col: 0, row: 0 };
  col = Math.max(0, Math.min(Math.max(0, lastCols - 1), col));
  row = Math.max(0, Math.min(Math.max(0, lastRows - 1), row));
  return { col, row };
}

function normalizedSelection() {
  if (!selActive || !selStart || !selEnd) return null;
  let s = selStart, e = selEnd;
  if (s.row > e.row || (s.row === e.row && s.col > e.col)) {
    [s, e] = [e, s];
  }
  return { s, e };
}

function selectionRowSet() {
  const set = new Set();
  const norm = normalizedSelection();
  if (!norm) return set;
  for (let y = norm.s.row; y <= norm.e.row; y++) {
    if (y >= 0 && y < lastRows) set.add(y);
  }
  return set;
}

function invalidateRowsBetween(r1, r2) {
  if (r1 == null || r2 == null) return;
  const a = Math.max(0, Math.min(r1, r2));
  const b = Math.min(lastRows - 1, Math.max(r1, r2));
  for (let y = a; y <= b; y++) lastRowKeys[y] = null;
}

function refreshSelection(prevS, prevE) {
  if (prevS && prevE) invalidateRowsBetween(prevS.row, prevE.row);
  if (selStart && selEnd) invalidateRowsBetween(selStart.row, selEnd.row);
  if (lastGrid) drawGrid(lastGrid);
}

function clearSelection(silent) {
  if (!selActive && !selStart && !selEnd) return;
  const prevS = selStart, prevE = selEnd;
  selActive = false; selStart = null; selEnd = null; selecting = false;
  if (silent) return;
  refreshSelection(prevS, prevE);
}

function paintSelection() {
  const norm = normalizedSelection();
  if (!norm) return;
  ctx.save();
  ctx.fillStyle = "rgba(30, 111, 180, 0.28)"; // soft blue overlay
  for (let y = norm.s.row; y <= norm.e.row; y++) {
    if (y < 0 || y >= lastRows) continue;
    let x1, x2;
    if (y === norm.s.row && y === norm.e.row) { x1 = norm.s.col; x2 = norm.e.col + 1; }
    else if (y === norm.s.row) { x1 = norm.s.col; x2 = lastCols; }
    else if (y === norm.e.row) { x1 = 0; x2 = norm.e.col + 1; }
    else { x1 = 0; x2 = lastCols; }
    ctx.fillRect(x1 * cellW, y * cellH, (x2 - x1) * cellW, cellH);
  }
  ctx.restore();
}

// Reconstruct the textual content of one row from its run list.
// Wide (CJK) chars span two cells; the second cell stays empty so column
// counts line up with the rendering grid.
function rowToChars(runs) {
  const chars = new Array(lastCols).fill(" ");
  for (const run of runs) {
    const colStart = run[0], text = run[1], width = run[5] || 1;
    if (width === 2) {
      const wc = Array.from(text);
      for (let i = 0; i < wc.length; i++) {
        const c = colStart + i * 2;
        if (c >= 0 && c < lastCols) chars[c] = wc[i];
        if (c + 1 >= 0 && c + 1 < lastCols) chars[c + 1] = "";
      }
    } else {
      for (let i = 0; i < text.length; i++) {
        const c = colStart + i;
        if (c >= 0 && c < lastCols) chars[c] = text[i];
      }
    }
  }
  return chars;
}

function extractTextRange(rowFrom, colFrom, rowTo, colTo) {
  if (!lastGrid) return "";
  const lines = lastGrid.lines || [];
  const out = [];
  for (let y = rowFrom; y <= rowTo; y++) {
    if (y < 0 || y >= lines.length) continue;
    const chars = rowToChars(lines[y]);
    let x1, x2;
    if (y === rowFrom && y === rowTo) { x1 = colFrom; x2 = colTo; }
    else if (y === rowFrom) { x1 = colFrom; x2 = lastCols - 1; }
    else if (y === rowTo) { x1 = 0; x2 = colTo; }
    else { x1 = 0; x2 = lastCols - 1; }
    out.push(chars.slice(x1, x2 + 1).join("").replace(/\s+$/, ""));
  }
  return out.join("\n");
}

function extractSelectionText() {
  const norm = normalizedSelection();
  if (!norm) return "";
  return extractTextRange(norm.s.row, norm.s.col, norm.e.row, norm.e.col);
}

function extractScreenText() {
  if (!lastGrid) return "";
  return extractTextRange(0, 0, lastRows - 1, lastCols - 1);
}

async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to legacy path */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.top = "0";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

let toastTimer = null;
const TOAST_POS_KEY = "tmux-bridge.toast-pos";

function _applyToastPos(t) {
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(TOAST_POS_KEY) || "null"); } catch {}
  if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
    // Clamp into the viewport so a prior-session drag off-screen is recoverable.
    const pad = 4;
    const maxLeft = Math.max(pad, window.innerWidth  - (t.offsetWidth  || 80) - pad);
    const maxTop  = Math.max(pad, window.innerHeight - (t.offsetHeight || 32) - pad);
    t.style.left = Math.min(maxLeft, Math.max(pad, pos.left)) + "px";
    t.style.top  = Math.min(maxTop,  Math.max(pad, pos.top))  + "px";
    t.style.right = "auto";
    t.style.bottom = "auto";
  } else {
    t.style.left = ""; t.style.top = "";
    t.style.right = ""; t.style.bottom = "";
  }
}

function _installToastDrag(t) {
  if (t.dataset.dragInstalled === "1") return;
  t.dataset.dragInstalled = "1";
  t.style.cursor = "move";
  // Keep pointer events on so drags work (CSS sets pointer-events:none
  // by default to let clicks pass through — we override here).
  t.style.pointerEvents = "auto";
  t.title = "Drag to reposition";

  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  t.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    // Suspend auto-hide while the user interacts.
    clearTimeout(toastTimer);
    t.classList.add("visible");
    const rect = t.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    t.style.left = startLeft + "px";
    t.style.top  = startTop + "px";
    t.style.right = "auto";
    t.style.bottom = "auto";
    t.style.transition = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const pad = 4;
    const w = t.offsetWidth, h = t.offsetHeight;
    const left = Math.min(window.innerWidth  - w - pad, Math.max(pad, startLeft + (e.clientX - startX)));
    const top  = Math.min(window.innerHeight - h - pad, Math.max(pad, startTop  + (e.clientY - startY)));
    t.style.left = left + "px";
    t.style.top  = top  + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    t.style.transition = "";
    const left = parseFloat(t.style.left) || 0;
    const top  = parseFloat(t.style.top)  || 0;
    try { localStorage.setItem(TOAST_POS_KEY, JSON.stringify({ left, top })); } catch {}
    // Resume the auto-hide countdown after a drag.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("visible"), 1400);
  });

  // Double-click to reset to default corner.
  t.addEventListener("dblclick", () => {
    try { localStorage.removeItem(TOAST_POS_KEY); } catch {}
    _applyToastPos(t);
  });
}

function showToast(msg) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  _installToastDrag(t);
  _applyToastPos(t);
  t.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("visible"), 1400);
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  // Ignore the compatibility mousedown that browsers fire after a touch tap
  // — otherwise every scroll-swipe starts a selection rectangle.
  if (_touchActive || Date.now() < _touchBlockMouseUntil) return;
  if (cellW <= 0 || cellH <= 0 || lastCols <= 0 || lastRows <= 0) return;
  const cell = pixelToCell(e);
  const prevS = selStart, prevE = selEnd;
  selStart = cell; selEnd = cell;
  selecting = true; selActive = true;
  refreshSelection(prevS, prevE);
  e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (!selecting) return;
  const cell = pixelToCell(e);
  if (selEnd && cell.col === selEnd.col && cell.row === selEnd.row) return;
  const prevS = selStart, prevE = selEnd;
  selEnd = cell;
  refreshSelection(prevS, prevE);
});

window.addEventListener("mouseup", async (e) => {
  if (!selecting) return;
  selecting = false;
  // Single click with no drag: clear selection.
  if (selStart && selEnd && selStart.col === selEnd.col && selStart.row === selEnd.row) {
    clearSelection();
    return;
  }
  // X-style: copy on selection. mouseup is a user gesture so the clipboard
  // API is allowed.
  const text = extractSelectionText();
  if (!text) return;
  const ok = await copyToClipboard(text);
  showToast(ok ? `Copied ${text.length} chars` : "Copy failed");
});

if (exitScrollBtn) {
  exitScrollBtn.addEventListener("click", () => {
    sendScroll("exit");
    if (!inputEl.disabled) inputEl.focus();
  });
}

// ── Mobile drawer ──────────────────────────────────────────
const sidebarEl = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");
const mobileMenuBtn = document.getElementById("mobile-menu-btn");
const _mq = window.matchMedia("(max-width: 720px)");
const isMobile = () => _mq.matches;

function openSidebar() {
  sidebarEl.classList.add("open");
  sidebarBackdrop.classList.add("visible");
}
function closeSidebar() {
  sidebarEl.classList.remove("open");
  sidebarBackdrop.classList.remove("visible");
}
if (mobileMenuBtn) mobileMenuBtn.addEventListener("click", openSidebar);
if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", closeSidebar);
// Returning to desktop width: discard any open/backdrop state so the
// sidebar displays inline again without being frozen in the drawer pose.
_mq.addEventListener?.("change", (e) => { if (!e.matches) closeSidebar(); });

// ── Touch gestures on the terminal ─────────────────────────
// Browsers synthesise mousedown/mousemove/mouseup after a touch tap; those
// would kick off a "selection drag" that's not useful on mobile (and is
// hard to cancel with no Esc key). Track an active-touch flag and bail
// out of the mouse path whenever one is in progress.
let _touchActive = false;
let _touchBlockMouseUntil = 0;
let _touchStartY = null;
let _touchLastScrollAt = 0;

function _touchGestureSettle() {
  // Ignore mouse events for 400ms after the touch ends — that's the window
  // in which browsers fire the compatibility mousedown.
  _touchActive = false;
  _touchBlockMouseUntil = Date.now() + 400;
  _touchStartY = null;
}

termWrap.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) { _touchStartY = null; return; }
  _touchActive = true;
  _touchStartY = e.touches[0].clientY;
}, { passive: true });

termWrap.addEventListener("touchmove", (e) => {
  if (!_touchActive || _touchStartY == null) return;
  if (e.touches.length !== 1) return;
  const y = e.touches[0].clientY;
  const dy = _touchStartY - y;   // >0: swipe up = reveal content below
  const THRESH = 50;
  if (Math.abs(dy) < THRESH) { e.preventDefault(); return; }
  // Rate-limit one page scroll per 160ms so a long swipe paginates rather
  // than shooting through the whole scrollback in one frame.
  const now = Date.now();
  if (now - _touchLastScrollAt < 160) { e.preventDefault(); return; }
  _touchLastScrollAt = now;
  if (dy > 0) {
    // At live bottom already: exit copy-mode instead of spamming page_down.
    if (lastGrid && lastGrid.in_copy_mode && (lastGrid.scroll_position || 0) <= 0) {
      sendScroll("exit");
    } else {
      sendScroll("page_down");
    }
  } else {
    sendScroll("page_up");
  }
  _touchStartY = y;   // re-anchor so the next delta is measured fresh
  e.preventDefault();
}, { passive: false });

termWrap.addEventListener("touchend", _touchGestureSettle, { passive: true });
termWrap.addEventListener("touchcancel", _touchGestureSettle, { passive: true });

const pageUpBtn = document.getElementById("page-up-btn");
const pageDownBtn = document.getElementById("page-down-btn");
if (pageUpBtn) {
  pageUpBtn.addEventListener("click", () => {
    if (!activeKey) return;
    sendScroll("page_up");
  });
}
if (pageDownBtn) {
  pageDownBtn.addEventListener("click", () => {
    if (!activeKey) return;
    if (lastGrid && lastGrid.in_copy_mode && (lastGrid.scroll_position || 0) <= 0) {
      sendScroll("exit");
    } else {
      sendScroll("page_down");
    }
  });
}

if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const text = extractSelectionText() || extractScreenText();
    if (!text) { showToast("Nothing to copy"); return; }
    const ok = await copyToClipboard(text);
    showToast(ok ? `Copied ${text.length} chars` : "Copy failed");
  });
}

// ── WebSocket ───────────────────────────────────────────────
let ws = null;
let panes = [];
let activeKey = null;
let reconnectTimer = null;

function setConn(state, label) {
  connEl.className = state;
  connEl.textContent = label;
}

function connect() {
  setConn("", "connecting…");
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setConn("ok", "connected");
    if (activeKey) ws.send(JSON.stringify({ type: "subscribe", key: activeKey }));
  };
  ws.onclose = () => {
    setConn("err", "disconnected");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000);
  };
  ws.onerror = () => setConn("err", "error");
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "panes":
        panes = msg.panes || [];
        renderPanes();
        break;
      case "grid":
        if (msg.key === activeKey) {
          lastGrid = msg;
          drawGrid(msg);
          if (exitScrollBtn) {
            exitScrollBtn.style.display = msg.in_copy_mode ? "inline-block" : "none";
          }
        }
        break;
      case "gone":
        if (msg.key === activeKey) {
          activeKey = null;
          updateActiveUI();
          clearCanvas();
        }
        break;
      case "spawn_result":
        handleSpawnResult(msg);
        break;
      case "error":
        console.warn("server error:", msg.msg);
        break;
    }
  };
}

function clearCanvas() {
  lastGrid = null;
  // Invalidate the row-diff cache — otherwise the next pane's matching rows
  // (e.g. empty lines, shared header text) get skipped and the canvas stays
  // blank until those rows happen to change.
  lastCols = 0; lastRows = 0;
  lastRowKeys = [];
  clearSelection(/*silent=*/true);
  ctx.fillStyle = BG_DEFAULT;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ── Sidebar ─────────────────────────────────────────────────
function renderPanes() {
  listEl.innerHTML = "";
  if (panes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pane-meta";
    empty.style.padding = "14px";
    empty.textContent = "No agents or panes. Start agent.py somewhere.";
    listEl.appendChild(empty);
    if (activeKey) { activeKey = null; updateActiveUI(); clearCanvas(); }
    return;
  }

  const byHost = new Map();
  for (const p of panes) {
    const h = p.host || "local";
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(p);
  }
  for (const [host, items] of byHost) {
    const hh = document.createElement("div");
    hh.className = "host-label";
    hh.textContent = host;
    listEl.appendChild(hh);
    for (const p of items) {
      const d = document.createElement("div");
      d.className = "pane-item"
        + (p.key === activeKey ? " active" : "")
        + (p.state === "pending" ? " has-pending" : "");
      d.innerHTML = `
        <div class="pane-top">
          <span class="pane-proj" title="Double-click to rename"></span>
          <span class="pane-state state-${p.state || "unknown"}"></span>
        </div>
        <div class="pane-meta"></div>
        <div class="pane-path"></div>
      `;
      const projEl = d.querySelector(".pane-proj");
      projEl.textContent = displayName(p);
      projEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        projEl.contentEditable = "true";
        projEl.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(projEl);
        sel.removeAllRanges(); sel.addRange(range);
      });
      const commit = (save) => {
        projEl.contentEditable = "false";
        if (save) {
          const v = projEl.textContent.trim();
          if (v) nameMap[p.key] = v;
          else delete nameMap[p.key];
          saveNames(nameMap);
        }
        projEl.textContent = displayName(p);
      };
      projEl.addEventListener("blur", () => commit(true));
      projEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); projEl.blur(); }
        else if (e.key === "Escape") {
          e.preventDefault();
          projEl.textContent = displayName(p);
          projEl.blur();
        }
      });

      d.querySelector(".pane-state").textContent = p.state || "?";
      const loc = p.session_name
        ? `${p.session_name}:${p.window_index ?? ""}${p.window_name ? " " + p.window_name : ""}`
        : p.pane;
      d.querySelector(".pane-meta").textContent  = `${loc} · ${p.detail || ""}`;
      const pathEl = d.querySelector(".pane-path");
      const fullPath = p.cwd || "";
      pathEl.textContent = fullPath.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~") || "-";
      pathEl.title = fullPath;
      d.onclick = () => selectPane(p.key);
      listEl.appendChild(d);
    }
  }

  if (activeKey && !panes.some((p) => p.key === activeKey)) {
    activeKey = null;
    updateActiveUI();
    clearCanvas();
  }
  updatePendingNotice();
}

// ── Pending-approval notice (sidebar bell + tab-title blink + OS toast) ────
const pendingBell = document.getElementById("pending-bell");
const pendingCountEl = document.getElementById("pending-count");
const ORIG_TITLE = document.title;
let lastPendingCount = 0;
let lastPendingKeys = new Set();
let titleBlinkTimer = null;
let titleState = false;
let liveOsNotification = null;

// Ask once on the first user gesture — browsers refuse the prompt otherwise.
function _primeNotifPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { Notification.requestPermission(); } catch {}
  }
  window.removeEventListener("pointerdown", _primeNotifPermission);
  window.removeEventListener("keydown", _primeNotifPermission);
}
window.addEventListener("pointerdown", _primeNotifPermission, { once: false });
window.addEventListener("keydown", _primeNotifPermission, { once: false });

function _fireOsNotif(n, newlyPendingPane) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try { if (liveOsNotification) liveOsNotification.close(); } catch {}
  const who = newlyPendingPane
    ? `${newlyPendingPane.host || "local"} · ${displayName(newlyPendingPane)}`
    : `${n} pane${n > 1 ? "s" : ""}`;
  const body = newlyPendingPane?.detail || "Click to jump to the pane.";
  const notif = new Notification(`Approval waiting — ${who}`, {
    body,
    tag: "tmux-bridge-pending",   // collapses repeats in the OS tray
    renotify: true,
    requireInteraction: false,
  });
  notif.onclick = () => {
    window.focus();
    const target = panes.find((p) => p.state === "pending");
    if (target) selectPane(target.key);
    notif.close();
  };
  liveOsNotification = notif;
}

function updatePendingNotice() {
  const pendingPanes = panes.filter((p) => p.state === "pending");
  const n = pendingPanes.length;
  const wasVisible = pendingBell.classList.contains("visible");
  if (n > 0) {
    pendingBell.classList.add("visible");
    pendingCountEl.textContent = String(n);
    // offsetWidth/Height are 0 while display:none, so the initial _clamp
    // couldn't see the real size. Re-clamp now that the bell is laid out.
    if (!wasVisible) _clampBellToViewport();
  } else {
    pendingBell.classList.remove("visible");
  }
  const curKeys = new Set(pendingPanes.map((p) => p.key));
  const appeared = pendingPanes.find((p) => !lastPendingKeys.has(p.key));
  if (appeared || (n > lastPendingCount)) _fireOsNotif(n, appeared || pendingPanes[0]);
  lastPendingKeys = curKeys;

  if (n !== lastPendingCount) {
    lastPendingCount = n;
    if (n > 0) startTitleBlink(n); else stopTitleBlink();
    if (n === 0 && liveOsNotification) {
      try { liveOsNotification.close(); } catch {}
      liveOsNotification = null;
    }
  } else if (n > 0) {
    // Keep the count current if it changed between blinks.
    updateBlinkLabel(n);
  }
}

function updateBlinkLabel(n) {
  if (titleBlinkTimer) {
    document.title = titleState ? `(${n}) approval waiting — tmux` : ORIG_TITLE;
  }
}
function startTitleBlink(n) {
  stopTitleBlink();
  titleState = true;
  document.title = `(${n}) approval waiting — tmux`;
  titleBlinkTimer = setInterval(() => {
    titleState = !titleState;
    document.title = titleState
      ? `(${lastPendingCount}) approval waiting — tmux`
      : ORIG_TITLE;
  }, 1100);
}
function stopTitleBlink() {
  if (titleBlinkTimer) clearInterval(titleBlinkTimer);
  titleBlinkTimer = null;
  document.title = ORIG_TITLE;
}

// ── Pending bell: draggable + click-to-jump ─────────────────────────
const BELL_POS_KEY = "tmux-bridge.bell-pos";
function _clampBellToViewport() {
  // Assume an 80x32 minimum footprint before the element has been laid out;
  // once .visible is applied the real offsetWidth/Height take over.
  const pad = 4;
  const w = pendingBell.offsetWidth  || 80;
  const h = pendingBell.offsetHeight || 32;
  const maxLeft = Math.max(pad, window.innerWidth  - w - pad);
  const maxTop  = Math.max(pad, window.innerHeight - h - pad);
  const curLeft = parseFloat(pendingBell.style.left);
  const curTop  = parseFloat(pendingBell.style.top);
  if (Number.isFinite(curLeft) && Number.isFinite(curTop)) {
    const left = Math.min(maxLeft, Math.max(pad, curLeft));
    const top  = Math.min(maxTop,  Math.max(pad, curTop));
    if (left !== curLeft) pendingBell.style.left = left + "px";
    if (top  !== curTop ) pendingBell.style.top  = top  + "px";
  }
}
(function initBellDrag() {
  const PAD = 4;

  // Restore last-saved position (written on drag-end). If the viewport
  // shrank since then the follow-up clamp will pull it back into view.
  const saved = localStorage.getItem(BELL_POS_KEY);
  if (saved) {
    try {
      const { left, top } = JSON.parse(saved);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        pendingBell.style.left = left + "px";
        pendingBell.style.top  = top  + "px";
        pendingBell.style.right = "auto";
        pendingBell.style.bottom = "auto";
      }
    } catch {}
  }
  _clampBellToViewport();
  window.addEventListener("resize", _clampBellToViewport);

  let dragging = false;
  let moved = false;
  let pointerId = null;
  // Offset from the pointer to the bell's top-left at drag start. We use
  // this instead of a delta so the bell stays anchored to the user's
  // finger/cursor — a delta-based drag ends up visibly lagging or jumping
  // when an animated element has transforms/scaling applied.
  let grabX = 0, grabY = 0;
  let startLeft = 0, startTop = 0;

  function _pin(r) {
    // Commit the rendered position as absolute left/top, wiping any
    // right/bottom anchors so the style.left we set next actually moves it.
    pendingBell.style.left = r.left + "px";
    pendingBell.style.top  = r.top  + "px";
    pendingBell.style.right  = "auto";
    pendingBell.style.bottom = "auto";
  }

  pendingBell.addEventListener("pointerdown", (e) => {
    // Only the primary button (or touch/pen) should start a drag.
    if (e.button !== undefined && e.button !== 0) return;
    const r = pendingBell.getBoundingClientRect();
    grabX = e.clientX - r.left;
    grabY = e.clientY - r.top;
    startLeft = r.left; startTop = r.top;
    _pin(r);
    dragging = true; moved = false;
    pointerId = e.pointerId;
    try { pendingBell.setPointerCapture(e.pointerId); } catch {}
    pendingBell.classList.add("dragging");
    // Block the browser's own gesture handling (text selection on mouse,
    // scroll/tap-zoom on touch).
    e.preventDefault();
  });

  pendingBell.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const w = pendingBell.offsetWidth, h = pendingBell.offsetHeight;
    let left = e.clientX - grabX;
    let top  = e.clientY - grabY;
    left = Math.max(PAD, Math.min(window.innerWidth  - w - PAD, left));
    top  = Math.max(PAD, Math.min(window.innerHeight - h - PAD, top));
    if (!moved &&
        (Math.abs(left - startLeft) > 4 || Math.abs(top - startTop) > 4)) {
      moved = true;
    }
    pendingBell.style.left = left + "px";
    pendingBell.style.top  = top  + "px";
    e.preventDefault();
  });

  function _finishDrag(e) {
    if (!dragging || (e && e.pointerId !== pointerId)) return;
    dragging = false;
    pendingBell.classList.remove("dragging");
    try { pendingBell.releasePointerCapture(pointerId); } catch {}
    if (moved) {
      const r = pendingBell.getBoundingClientRect();
      try {
        localStorage.setItem(
          BELL_POS_KEY,
          JSON.stringify({ left: r.left, top: r.top }),
        );
      } catch {}
    }
  }
  pendingBell.addEventListener("pointerup", _finishDrag);
  pendingBell.addEventListener("pointercancel", _finishDrag);

  pendingBell.addEventListener("click", (e) => {
    // A drag ends with a pointerup that also triggers a click; suppress
    // that so the user doesn't jump to a pane after merely repositioning.
    if (moved) {
      e.preventDefault(); e.stopPropagation();
      moved = false;
      return;
    }
    const target = panes.find((p) => p.state === "pending");
    if (target) selectPane(target.key);
  });

  // Double-click restores the default top-right corner so a bell dragged
  // off-screen (e.g. from a previously-wider viewport) is always recoverable.
  pendingBell.addEventListener("dblclick", (e) => {
    e.preventDefault(); e.stopPropagation();
    try { localStorage.removeItem(BELL_POS_KEY); } catch {}
    pendingBell.style.left = "";
    pendingBell.style.top = "";
    pendingBell.style.right = "";
    pendingBell.style.bottom = "";
  });
})();

function selectPane(key) {
  if (key === activeKey) {
    if (isMobile()) closeSidebar();
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN && activeKey) {
    ws.send(JSON.stringify({ type: "unsubscribe", key: activeKey }));
  }
  activeKey = key;
  lastGrid = null;
  clearCanvas();
  updateActiveUI();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "subscribe", key }));
  }
  renderPanes();
  // On mobile the sidebar is a drawer — close it so the pane we just
  // picked actually gets shown instead of being hidden behind the drawer.
  if (isMobile()) closeSidebar();
}

function updateActiveUI() {
  const active = activeKey != null;
  emptyEl.style.display   = active ? "none"  : "flex";
  termWrap.style.display  = active ? "block" : "none";
  toolbarEl.style.display = active ? "flex"  : "none";
  inputEl.disabled = !active;
  sendBtn.disabled = !active;
  keyBtns.forEach((b) => { b.disabled = !active; });
  fitBtn.disabled = !active;
  if (killBtn) killBtn.disabled = !active;
  if (clearInputBtn) clearInputBtn.disabled = !active;
  // Auto-focus on desktop is convenient; on mobile it pops the virtual
  // keyboard the instant you pick a pane, burying the terminal. Let the
  // user tap the textarea when they actually want to type.
  if (active && !isMobile()) inputEl.focus();
}

function killActivePane() {
  if (!activeKey) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const p = panes.find((x) => x.key === activeKey);
  const label = p ? displayName(p) : activeKey;
  if (!confirm(`Kill tmux window "${label}"?\n\nAny running claude/process in it will be terminated.`)) return;
  ws.send(JSON.stringify({ type: "kill", key: activeKey }));
}

if (killBtn) killBtn.addEventListener("click", killActivePane);

if (clearInputBtn) clearInputBtn.addEventListener("click", (e) => {
  e.preventDefault();
  inputEl.value = "";
  if (!inputEl.disabled) inputEl.focus();
});

function sendNamedKey(name) {
  if (!activeKey || !name) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "send_keys", key: activeKey, keys: [name] }));
}

keyBtns.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    sendNamedKey(btn.dataset.key);
    // Keep focus in the textarea so typing can continue without re-clicking.
    if (!inputEl.disabled) inputEl.focus();
  });
});

function sendInput() {
  const text = inputEl.value;
  if (!activeKey || !text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "send_keys", key: activeKey, text, enter: true }));
  inputEl.value = "";
  autoGrow();
}

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 320) + "px";
}

sendBtn.addEventListener("click", sendInput);
inputEl.addEventListener("input", autoGrow);
// Android / GBoard / SwiftKey soft keyboards frequently skip firing a real
// `keydown` for the Enter key and only emit a beforeinput with
// `inputType === "insertLineBreak"`. Without this handler, tapping Enter
// on mobile just inserts a newline into the textarea and never sends.
inputEl.addEventListener("beforeinput", (e) => {
  if (e.inputType !== "insertLineBreak") return;
  // Shift+Enter should still insert a newline on desktop; on soft keyboards
  // there's no shift state here, so any line-break is treated as send.
  e.preventDefault();
  sendInput();
});
inputEl.addEventListener("keydown", (e) => {
  // While an IME (Chinese/Japanese/Korean pinyin etc.) is composing,
  // Enter is the commit keystroke for the IME candidate, not a "send".
  // Swallowing it here would also eat the commit and leave the textarea
  // stuck with half-typed pinyin.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendInput();
    return;
  }
  if (e.key === "PageUp")   { e.preventDefault(); sendScroll("page_up"); return; }
  if (e.key === "PageDown") {
    e.preventDefault();
    if (lastGrid && lastGrid.in_copy_mode && (lastGrid.scroll_position || 0) <= 0) sendScroll("exit");
    else sendScroll("page_down");
    return;
  }
  // When the pane is showing scrollback, Esc exits copy-mode instead of
  // whatever the default would do (nothing, in a textarea).
  if (e.key === "Escape" && lastGrid && lastGrid.in_copy_mode) {
    e.preventDefault();
    sendScroll("exit");
    return;
  }
});

document.addEventListener("keydown", (e) => {
  if (modalBack.classList.contains("open")) return;
  if (e.target === inputEl) return;
  if (e.shiftKey && e.key === "PageUp")   { e.preventDefault(); sendScroll("page_up"); return; }
  if (e.shiftKey && e.key === "PageDown") {
    e.preventDefault();
    if (lastGrid && lastGrid.in_copy_mode && (lastGrid.scroll_position || 0) <= 0) sendScroll("exit");
    else sendScroll("page_down");
    return;
  }
  if (e.key === "Escape" && lastGrid && lastGrid.in_copy_mode) {
    e.preventDefault();
    sendScroll("exit");
  }
});

window.addEventListener("resize", () => {
  const newDpr = window.devicePixelRatio || 1;
  if (newDpr !== dpr) {
    dpr = newDpr;
    if (lastGrid) drawGrid(lastGrid, true);
  }
});

// The row-diff cache skips repaints when fingerprints match. If the on-canvas
// pixels drift from that cached state (DPR flips, browser zoom, tab discard/
// restore, GPU context loss, background throttling dropping a paint), the
// stale patch sticks around until the next row change — and when the pane is
// idle the agent won't send another snapshot because `data == last`. A cheap
// full redraw every couple of seconds heals that back to the last snapshot
// we do have cached.
setInterval(() => {
  if (!lastGrid) return;
  if (document.hidden) return;
  drawGrid(lastGrid, /*keepScroll=*/true);
}, 2000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && lastGrid) drawGrid(lastGrid, /*keepScroll=*/true);
});

// ── New-session modal ───────────────────────────────────────
const pendingSpawns = new Map();   // req_id -> true
const CWD_KEY = "tmux-bridge.last-cwd";

function hostsFromPanes() {
  const hs = new Set();
  for (const p of panes) hs.add(p.host || "local");
  return Array.from(hs);
}

function openNewModal() {
  modalError.textContent = "";
  modalHost.innerHTML = "";
  const hosts = hostsFromPanes();
  if (hosts.length === 0) {
    modalError.textContent = "No agents connected — start agent.py on a host first.";
    modalSubmit.disabled = true;
  } else {
    modalSubmit.disabled = false;
    for (const h of hosts) {
      const opt = document.createElement("option");
      opt.value = h; opt.textContent = h;
      modalHost.appendChild(opt);
    }
  }
  modalCwd.value = localStorage.getItem(CWD_KEY) || "";
  modalSession.value = "";
  modalBack.classList.add("open");
  setTimeout(() => modalCwd.focus(), 10);
}
function closeNewModal() { modalBack.classList.remove("open"); }

function submitNewPane() {
  const host   = modalHost.value;
  const cwd    = modalCwd.value.trim();
  const window = modalSession.value.trim();
  if (!host) { modalError.textContent = "Select a host."; return; }
  if (!cwd)  { modalError.textContent = "Enter a directory."; return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    modalError.textContent = "Not connected."; return;
  }
  const reqId = "s" + Date.now() + Math.random().toString(36).slice(2, 6);
  pendingSpawns.set(reqId, true);
  modalSubmit.disabled = true;
  modalError.textContent = "Launching…";
  localStorage.setItem(CWD_KEY, cwd);
  ws.send(JSON.stringify({
    type: "spawn", req_id: reqId, host, cwd, window,
  }));
}

function handleSpawnResult(msg) {
  if (!pendingSpawns.has(msg.req_id)) return;
  pendingSpawns.delete(msg.req_id);
  modalSubmit.disabled = false;
  if (msg.ok) {
    modalError.textContent = "";
    closeNewModal();
  } else {
    modalError.textContent = "Failed: " + (msg.info || "unknown error");
  }
}

newBtn.addEventListener("click", openNewModal);
modalCancel.addEventListener("click", closeNewModal);
modalSubmit.addEventListener("click", submitNewPane);
modalBack.addEventListener("click", (e) => {
  if (e.target === modalBack) closeNewModal();
});
document.addEventListener("keydown", (e) => {
  if (!modalBack.classList.contains("open")) return;
  if (e.key === "Escape") { e.preventDefault(); closeNewModal(); }
  else if (e.key === "Enter" && (e.target === modalCwd || e.target === modalSession)) {
    e.preventDefault(); submitNewPane();
  }
});

measureCell();
updateZoomUI();
applyUiZoom();
updateActiveUI();
connect();
