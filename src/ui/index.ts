import type { Whiteboard } from '../whiteboard';
import type { ToolName } from '../types';
import { inkColor } from '../render/color';
import { CSS } from './styles';

export interface ToolbarOptions {
    /** 'auto' puts it on the left on wide boards and at the bottom on narrow ones. */
    position?: 'auto' | 'left' | 'bottom';
    /** Ink colours offered. */
    colors?: string[];
    /** Stroke widths offered (scene units). */
    widths?: number[];
    /** Sticky note paper colours offered. */
    noteColors?: string[];
    /** Tooltips and accessible names, e.g. for translation. */
    labels?: Partial<Record<ToolName | 'undo' | 'redo' | 'style', string>>;
}

export interface Toolbar {
    element: HTMLElement;
    destroy(): void;
}

const ICONS: Record<ToolName | 'undo' | 'redo', string> = {
    select: 'M6 3l12 8-5.5 1.3L9.5 18z',
    hand: 'M8 13V6a1.5 1.5 0 013 0v5m0-6.5a1.5 1.5 0 013 0V11m0-4.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-.5a6 6 0 01-5-2.7L4.6 14a1.5 1.5 0 012.6-1.5L8 14',
    pen: 'M4 20l1.2-4.2L16 5l3 3L8.2 18.8zM14 7l3 3',
    line: 'M5 19L19 5',
    arrow: 'M5 19L19 5M10 5h9v9',
    rect: 'M4 6h16v12H4z',
    ellipse: 'M4 12a8 6 0 1016 0a8 6 0 10-16 0',
    text: 'M6 6h12M12 6v13M9 19h6',
    note: 'M5 4h14v10l-6 6H5zM13 20v-6h6',
    eraser: 'M8 20h11M5.6 14.4l8-8a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L12 18H9.2zM10 10l4.5 4.5',
    laser: 'M10 12a2 2 0 104 0a2 2 0 10-4 0M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
    undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
    redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13',
};

const LABELS: Record<ToolName | 'undo' | 'redo' | 'style', string> = {
    select: 'Select (V)',
    hand: 'Pan (H)',
    pen: 'Pen (P)',
    line: 'Line (L)',
    arrow: 'Arrow (A)',
    rect: 'Rectangle (R)',
    ellipse: 'Ellipse (O)',
    text: 'Text (T)',
    note: 'Sticky note (N)',
    eraser: 'Eraser (E)',
    laser: 'Laser pointer (K)',
    undo: 'Undo',
    redo: 'Redo',
    style: 'Colour and width',
};

const DEFAULT_COLORS = ['#1e1e1e', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#868e96'];
const DEFAULT_WIDTHS = [1, 2, 4];
const DEFAULT_NOTE_COLORS = ['#ffec99', '#ffc9c9', '#a5d8ff', '#b2f2bb', '#eebefa'];
const VIEW_TOOLS: ReadonlySet<ToolName> = new Set(['hand', 'laser']);
const NARROW = 640;

function injectStyles(): void {
    if (document.getElementById('lb-styles')) return;
    const style = document.createElement('style');
    style.id = 'lb-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
}

function icon(path: string): string {
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

function button(label: string, html: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = html;
    // pointerdown, not click: the board must not see this tap, and a click
    // on touch screens arrives late.
    b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        }
    });
    return b;
}

/** Adds the built-in toolbar to a board. */
export function mountToolbar(wb: Whiteboard, options: ToolbarOptions = {}): Toolbar {
    injectStyles();
    const labels = { ...LABELS, ...options.labels };
    const colors = options.colors ?? DEFAULT_COLORS;
    const widths = options.widths ?? DEFAULT_WIDTHS;
    const noteColors = options.noteColors ?? DEFAULT_NOTE_COLORS;
    const notesInFocus = () =>
        wb.toolId === 'note' || wb.selection.some((id) => wb.store.get(id)?.t === 'note');

    const bar = document.createElement('div');
    bar.className = 'lb-toolbar';
    bar.setAttribute('role', 'toolbar');
    const panel = document.createElement('div');
    panel.className = 'lb-panel';
    panel.hidden = true;
    wb.element.append(bar, panel);

    const toolButtons = new Map<ToolName, HTMLButtonElement>();
    let styleBtn: HTMLButtonElement;
    let undoBtn: HTMLButtonElement;
    let redoBtn: HTMLButtonElement;

    const closePanel = () => {
        panel.hidden = true;
        styleBtn?.setAttribute('aria-expanded', 'false');
    };

    const render = () => {
        bar.textContent = '';
        toolButtons.clear();
        const tools = wb.availableTools.filter((t) => !wb.readOnly || VIEW_TOOLS.has(t));
        for (const t of tools) {
            const b = button(labels[t], icon(ICONS[t]), () => wb.setTool(t));
            toolButtons.set(t, b);
            bar.appendChild(b);
        }
        if (!wb.readOnly) {
            bar.appendChild(Object.assign(document.createElement('span'), { className: 'lb-sep' }));
            styleBtn = button(labels.style, '<span class="lb-dot"></span>', () => {
                panel.hidden = !panel.hidden;
                styleBtn.setAttribute('aria-expanded', String(!panel.hidden));
                if (!panel.hidden) {
                    renderPanel();
                    layout();
                }
            });
            undoBtn = button(labels.undo, icon(ICONS.undo), () => wb.undo());
            redoBtn = button(labels.redo, icon(ICONS.redo), () => wb.redo());
            bar.append(styleBtn, undoBtn, redoBtn);
        } else {
            closePanel();
        }
        sync();
    };

    const renderPanel = () => {
        panel.textContent = '';
        const swatches = document.createElement('div');
        swatches.className = 'lb-row';
        for (const c of colors) {
            const shown = inkColor(c, wb.theme);
            const b = button(c, `<span class="lb-swatch" style="background:${shown}"></span>`, () => {
                wb.setStyle({ color: c });
                renderPanel();
            });
            b.setAttribute('aria-pressed', String(wb.style.color === c));
            swatches.appendChild(b);
        }
        const sizes = document.createElement('div');
        sizes.className = 'lb-row';
        for (const w of widths) {
            const b = button(`Width ${w}`, `<span class="lb-width" style="height:${Math.min(12, w * 2 + 1)}px"></span>`, () => {
                wb.setStyle({ strokeWidth: w });
                renderPanel();
            });
            b.setAttribute('aria-pressed', String(wb.style.strokeWidth === w));
            sizes.appendChild(b);
        }
        const papers = document.createElement('div');
        papers.className = 'lb-row';
        for (const c of noteColors) {
            const b = button(`Note ${c}`, `<span class="lb-swatch lb-paper" style="background:${c}"></span>`, () => {
                wb.setStyle({ noteColor: c });
                renderPanel();
            });
            b.setAttribute('aria-pressed', String(wb.style.noteColor === c));
            papers.appendChild(b);
        }
        // The note tool only needs paper colours; a mixed selection gets both.
        if (wb.toolId !== 'note') panel.append(swatches, sizes);
        if (notesInFocus()) panel.append(papers);
    };

    const sync = () => {
        for (const [t, b] of toolButtons) b.setAttribute('aria-pressed', String(wb.toolId === t));
        if (!wb.readOnly) {
            const dot = styleBtn.firstElementChild as HTMLElement;
            dot.style.background =
                wb.toolId === 'note' ? wb.style.noteColor : inkColor(wb.style.color, wb.theme);
            dot.style.boxShadow = `0 0 0 ${Math.min(4, wb.style.strokeWidth)}px var(--lb-ring)`;
            undoBtn.disabled = !wb.canUndo;
            redoBtn.disabled = !wb.canRedo;
        }
        bar.classList.toggle('lb-dark', wb.theme === 'dark');
        panel.classList.toggle('lb-dark', wb.theme === 'dark');
    };

    const layout = () => {
        const pos =
            options.position && options.position !== 'auto'
                ? options.position
                : wb.element.clientWidth < NARROW
                  ? 'bottom'
                  : 'left';
        bar.dataset.pos = pos;
        panel.dataset.pos = pos;
        // Sit above the toolbar, which wraps to two rows on phones.
        panel.style.bottom = pos === 'bottom' ? `${bar.offsetHeight + 16}px` : '';
    };

    const offs = [
        wb.on('tool', () => {
            sync();
            if (!panel.hidden) renderPanel();
        }),
        wb.on('selection', () => {
            if (!panel.hidden) renderPanel();
        }),
        wb.on('style', sync),
        wb.on('history', sync),
        wb.on('theme', sync),
        wb.on('readOnly', render),
        wb.on('load', sync),
    ];
    const onOutside = (e: PointerEvent) => {
        if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== styleBtn) {
            closePanel();
        }
    };
    document.addEventListener('pointerdown', onOutside, true);
    const ro = new ResizeObserver(layout);
    ro.observe(wb.element);
    layout();
    render();

    return {
        element: bar,
        destroy() {
            offs.forEach((off) => off());
            document.removeEventListener('pointerdown', onOutside, true);
            ro.disconnect();
            bar.remove();
            panel.remove();
        },
    };
}
