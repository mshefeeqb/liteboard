import {
    ALL_TOOLS,
    fonts,
    loadFont,
    presets,
    type FontSource,
    type ToolName,
    type Whiteboard,
} from 'liteboard';
import type { Toolbar, ToolbarOptions } from 'liteboard/ui';
// The font file ships in the package; Vite turns this import into its URL.
import excalifontUrl from 'liteboard/fonts/Excalifont-Regular.woff2?url';

/**
 * A panel for trying feature switches live, and the matching config to copy
 * into an app. Everything here uses the public API an app would use.
 */

const TOOL_LABELS: Record<ToolName, string> = {
    select: 'Select',
    hand: 'Pan',
    pen: 'Pen',
    line: 'Line',
    arrow: 'Arrow',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    text: 'Text',
    note: 'Sticky note',
    eraser: 'Eraser',
    laser: 'Laser',
};

const FONT_CHOICES: Record<string, FontSource | null> = {
    System: null,
    Excalifont: { ...fonts.excalifont, url: excalifontUrl },
    'Kalam (with Hindi)': fonts.kalam,
    'Patrick Hand': fonts.patrickHand,
    Caveat: fonts.caveat,
};

interface State {
    tools: ToolName[];
    toolbar: Required<Pick<ToolbarOptions, 'style' | 'undo' | 'zoom' | 'clear'>>;
    gestures: { pinchZoom: boolean; twoFingerPan: boolean };
    font: string;
}

export function mountFeatures(button: HTMLElement, wb: Whiteboard, toolbar: Toolbar): void {
    const state: State = {
        tools: [...wb.availableTools],
        toolbar: { style: true, undo: true, zoom: false, clear: false },
        gestures: { pinchZoom: true, twoFingerPan: true },
        font: 'System',
    };

    const panel = document.createElement('aside');
    panel.className = 'features';
    panel.hidden = true;
    document.body.appendChild(panel);
    button.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
    });

    const apply = async () => {
        wb.setTools(state.tools);
        toolbar.update(state.toolbar);
        wb.setGestures(state.gestures);
        const source = FONT_CHOICES[state.font];
        wb.setFont(source ? await loadFont(source) : undefined);
        render();
    };

    const check = (label: string, on: boolean, change: (v: boolean) => void) => {
        const row = document.createElement('label');
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: on });
        box.addEventListener('change', () => {
            change(box.checked);
            void apply();
        });
        row.append(box, ` ${label}`);
        return row;
    };

    const section = (title: string, ...children: HTMLElement[]) => {
        const s = document.createElement('section');
        s.append(Object.assign(document.createElement('h3'), { textContent: title }), ...children);
        return s;
    };

    const config = () => {
        const lines = [
            `tools: [${state.tools.map((t) => `'${t}'`).join(', ')}],`,
            `gestures: { pinchZoom: ${state.gestures.pinchZoom}, twoFingerPan: ${state.gestures.twoFingerPan} },`,
        ];
        const source = FONT_CHOICES[state.font];
        if (source === FONT_CHOICES.Excalifont) {
            lines.push(`fontFamily: await loadFont({ ...fonts.excalifont, url: '/fonts/Excalifont-Regular.woff2' }),`);
        } else if (source) {
            lines.push(`fontFamily: await loadFont(fonts.${Object.entries(fonts).find(([, f]) => f === source)?.[0]}),`);
        }
        const tb = state.toolbar;
        return [
            '// Vanilla',
            'const wb = createWhiteboard(el, {',
            ...lines.map((l) => '    ' + l),
            '});',
            `mountToolbar(wb, { style: ${tb.style}, undo: ${tb.undo}, zoom: ${tb.zoom}, clear: ${tb.clear} });`,
            '',
            '// React',
            '<Whiteboard',
            `    tools={[${state.tools.map((t) => `'${t}'`).join(', ')}]}`,
            `    toolbar={{ style: ${tb.style}, undo: ${tb.undo}, zoom: ${tb.zoom}, clear: ${tb.clear} }}`,
            `    gestures={{ pinchZoom: ${state.gestures.pinchZoom}, twoFingerPan: ${state.gestures.twoFingerPan} }}`,
            '/>',
        ].join('\n');
    };

    function render(): void {
        panel.textContent = '';
        const presetSelect = document.createElement('select');
        presetSelect.innerHTML =
            '<option value="">Apply a preset…</option>' +
            Object.keys(presets).map((p) => `<option>${p}</option>`).join('');
        presetSelect.addEventListener('change', () => {
            const p = presets[presetSelect.value as keyof typeof presets] as { tools?: readonly ToolName[]; readOnly?: boolean };
            if (!p) return;
            state.tools = [...(p.tools ?? ALL_TOOLS)];
            wb.setReadOnly(p.readOnly ?? false);
            void apply();
        });

        const fontSelect = document.createElement('select');
        fontSelect.innerHTML = Object.keys(FONT_CHOICES)
            .map((f) => `<option ${f === state.font ? 'selected' : ''}>${f}</option>`)
            .join('');
        fontSelect.addEventListener('change', () => {
            state.font = fontSelect.value;
            void apply();
        });

        const code = Object.assign(document.createElement('pre'), { textContent: config() });
        const copy = Object.assign(document.createElement('button'), { textContent: 'Copy config' });
        copy.addEventListener('click', () => {
            void navigator.clipboard?.writeText(config());
            copy.textContent = 'Copied';
            setTimeout(() => (copy.textContent = 'Copy config'), 1500);
        });

        panel.append(
            Object.assign(document.createElement('h2'), { textContent: 'Features' }),
            presetSelect,
            section(
                'Tools',
                ...ALL_TOOLS.map((t) =>
                    check(TOOL_LABELS[t], state.tools.includes(t), (on) => {
                        state.tools = on
                            ? ALL_TOOLS.filter((x) => x === t || state.tools.includes(x))
                            : state.tools.filter((x) => x !== t);
                        if (state.tools.length === 0) state.tools = ['pen'];
                    }),
                ),
            ),
            section(
                'Toolbar buttons',
                check('Colour & width', state.toolbar.style, (v) => (state.toolbar.style = v)),
                check('Undo / redo', state.toolbar.undo, (v) => (state.toolbar.undo = v)),
                check('Zoom', state.toolbar.zoom, (v) => (state.toolbar.zoom = v)),
                check('Clear board', state.toolbar.clear, (v) => (state.toolbar.clear = v)),
            ),
            section(
                'Touch',
                check('Pinch to zoom', state.gestures.pinchZoom, (v) => (state.gestures.pinchZoom = v)),
                check('Two-finger pan', state.gestures.twoFingerPan, (v) => (state.gestures.twoFingerPan = v)),
            ),
            section('Font', fontSelect),
            section('Your config', code, copy),
        );
    }

    render();
}
