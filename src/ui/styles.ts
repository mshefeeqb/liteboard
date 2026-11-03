/** Toolbar styles. Override the --lb-* variables to theme it. */
export const CSS = `
.lb-toolbar, .lb-panel {
  --lb-bg: #ffffff;
  --lb-fg: #343a40;
  --lb-muted: #adb5bd;
  --lb-active-bg: #e7ecff;
  --lb-active-fg: #364fc7;
  --lb-border: rgba(0, 0, 0, 0.08);
  --lb-ring: rgba(0, 0, 0, 0.15);
  --lb-size: 40px;
  position: absolute;
  z-index: 3;
  display: flex;
  gap: 2px;
  padding: 4px;
  background: var(--lb-bg);
  color: var(--lb-fg);
  border: 1px solid var(--lb-border);
  border-radius: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  font: 13px system-ui, sans-serif;
}
.lb-toolbar.lb-dark, .lb-panel.lb-dark {
  --lb-bg: #232329;
  --lb-fg: #dee2e6;
  --lb-muted: #6c757d;
  --lb-active-bg: #403e6a;
  --lb-active-fg: #d0d7ff;
  --lb-border: rgba(255, 255, 255, 0.08);
  --lb-ring: rgba(255, 255, 255, 0.25);
}
@media (pointer: coarse) {
  .lb-toolbar, .lb-panel { --lb-size: 44px; }
}
.lb-toolbar[data-pos="left"] {
  flex-direction: column;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  max-height: calc(100% - 16px);
  overflow-y: auto;
}
.lb-toolbar[data-pos="bottom"] {
  left: 50%;
  bottom: max(8px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100% - 16px);
  /* Wrap to a second row on phones so undo and redo stay reachable. */
  flex-wrap: wrap;
  justify-content: center;
}
.lb-panel { flex-direction: column; gap: 6px; padding: 8px; }
.lb-panel[data-pos="left"] { left: calc(var(--lb-size) + 22px); top: 50%; transform: translateY(-50%); }
.lb-panel[data-pos="bottom"] {
  left: 50%;
  transform: translateX(-50%);
}
.lb-panel[hidden] { display: none; }
.lb-row { display: flex; gap: 2px; flex-wrap: wrap; max-width: calc(var(--lb-size) * 4 + 6px); }
.lb-btn {
  flex: none;
  width: var(--lb-size);
  height: var(--lb-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  touch-action: manipulation;
}
.lb-btn:hover { background: var(--lb-border); }
.lb-btn:focus-visible { outline: 2px solid var(--lb-active-fg); outline-offset: -2px; }
.lb-btn[aria-pressed="true"] { background: var(--lb-active-bg); color: var(--lb-active-fg); }
.lb-btn:disabled { color: var(--lb-muted); cursor: default; background: transparent; }
.lb-sep { flex: none; align-self: stretch; margin: 2px; border-left: 1px solid var(--lb-border); border-top: 1px solid var(--lb-border); }
.lb-dot, .lb-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--lb-ring);
}
.lb-paper { border-radius: 4px; }
.lb-width { width: 22px; border-radius: 6px; background: currentColor; }
`;
