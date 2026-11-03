import { sceneToScreen } from './camera';
import { nanoid, round1 } from './model/geometry';
import type { History } from './model/history';
import {
    inkColor,
    LINE_HEIGHT,
    measureText,
    NOTE_PADDING,
    NOTE_TEXT,
    textFont,
    wrapText,
} from './render/draw';
import type { Camera, Element, Point, Style, Theme } from './types';

interface EditorHost {
    root: HTMLElement;
    history: History;
    camera(): Camera;
    style(): Style;
    theme(): Theme;
    fontFamily(): string | undefined;
    /** Hides the element being edited from the canvas, or shows it again. */
    hide(id: string | null): void;
}

/**
 * A textarea over the board for typing text and sticky notes. Whatever
 * closes it (Escape, Ctrl/Cmd+Enter, blur, a click on the board, switching
 * boards, destroy) saves the text: typed text is never dropped.
 */
export class TextEditor {
    private ta: HTMLTextAreaElement | null = null;
    private base: Element | null = null;
    private at: Point = { x: 0, y: 0 };
    private fontSize = 20;
    private color = '#1e1e1e';
    private note: Element | null = null;

    constructor(private host: EditorHost) {}

    get isOpen(): boolean {
        return this.ta !== null;
    }

    open(base: Element | null, at?: Point): void {
        this.commit();
        const style = this.host.style();
        this.base = base;
        this.note = base?.t === 'note' ? base : null;
        this.fontSize = base?.fs ?? style.fontSize;
        this.color = base?.c ?? style.color;
        // Put the first line's centre where the user tapped.
        this.at = base
            ? { x: base.x, y: base.y }
            : { x: at!.x, y: at!.y - (this.fontSize * LINE_HEIGHT) / 2 };

        const ta = document.createElement('textarea');
        ta.value = base?.txt ?? '';
        ta.wrap = this.note ? 'soft' : 'off';
        ta.spellcheck = false;
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('aria-label', 'Text');
        ta.style.cssText =
            'position:absolute;margin:0;padding:0;border:0;outline:1px dashed #4c6ef5;' +
            'background:transparent;resize:none;overflow:hidden;box-sizing:border-box;' +
            `white-space:${this.note ? 'pre-wrap' : 'pre'};z-index:2;min-width:4px;`;
        ta.addEventListener('input', this.layout);
        ta.addEventListener('blur', () => this.commit());
        ta.addEventListener('keydown', (e) => {
            // Keep board shortcuts (Delete, tool keys, undo) out of typing.
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                e.preventDefault();
                this.commit();
            }
        });
        this.ta = ta;
        this.host.root.appendChild(ta);
        if (base) this.host.hide(base.id);
        this.layout();
        // Focus synchronously: iOS only shows the keyboard inside the gesture.
        ta.focus({ preventScroll: true });
        if (base) ta.select();
    }

    /** Follows the camera. */
    layout = (): void => {
        const ta = this.ta;
        if (!ta) return;
        const cam = this.host.camera();
        const p = sceneToScreen(cam, this.at);
        const size = this.fontSize * cam.zoom;
        ta.style.left = `${p.x}px`;
        ta.style.top = `${p.y}px`;
        ta.style.font = textFont(size, this.host.fontFamily());
        ta.style.lineHeight = String(LINE_HEIGHT);
        if (this.note) {
            // Cover the note: same paper, same padding, text wraps inside.
            const note = this.note;
            ta.style.color = NOTE_TEXT;
            ta.style.background = note.fill ?? '#ffec99';
            ta.style.borderRadius = `${Math.min(8, note.w / 8) * cam.zoom}px`;
            ta.style.padding = `${NOTE_PADDING * cam.zoom}px`;
            ta.style.width = `${note.w * cam.zoom}px`;
            ta.style.height = '1px';
            ta.style.height = `${Math.max(note.h * cam.zoom, ta.scrollHeight)}px`;
            return;
        }
        ta.style.color = inkColor(this.color, this.host.theme());
        ta.style.width = '1px';
        ta.style.height = '1px';
        ta.style.width = `${ta.scrollWidth + size}px`;
        ta.style.height = `${ta.scrollHeight}px`;
    };

    /** Saves and closes. Empty text deletes the element. */
    commit(): void {
        const ta = this.ta;
        if (!ta) return;
        this.ta = null;
        const txt = ta.value.replace(/\s+$/, '');
        const base = this.base;
        this.base = null;
        // Removing a focused textarea drops focus to <body>, which would cut
        // the board off from its keyboard shortcuts.
        const hadFocus = document.activeElement === ta;
        ta.remove();
        if (hadFocus) this.host.root.focus({ preventScroll: true });
        this.host.hide(null);

        const note = this.note;
        this.note = null;
        if (note) {
            if ((note.txt ?? '') === txt) return;
            // The note grows to fit its text; it never shrinks under the user.
            const lines = wrapText(txt, this.fontSize, note.w - NOTE_PADDING * 2, this.host.fontFamily());
            const needed = lines.length * this.fontSize * LINE_HEIGHT + NOTE_PADDING * 2;
            this.host.history.commit([{ ...note, txt, h: Math.max(note.h, Math.ceil(needed)) }]);
            return;
        }

        if (!txt) {
            if (base) this.host.history.commit([], [base.id]);
            return;
        }
        if (base && base.txt === txt) return;
        const { w, h } = measureText(txt, this.fontSize, this.host.fontFamily());
        this.host.history.commit([
            {
                ...(base ?? {}),
                id: base?.id ?? nanoid(),
                t: 'text',
                x: round1(this.at.x),
                y: round1(this.at.y),
                w,
                h,
                txt,
                fs: this.fontSize,
                c: this.color,
                sw: base?.sw ?? 1,
            },
        ]);
    }
}
