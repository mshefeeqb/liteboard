import type { WhiteboardOptions } from './whiteboard';

/**
 * Ready-made option sets. Spread one and override what you need:
 *
 *   createWhiteboard(el, { ...presets.teaching, theme: 'dark' })
 */
export const presets = {
    /** Every tool. */
    full: {},
    /** Teaching: thin pen by default, shapes, text, notes, laser. */
    teaching: {
        tools: ['select', 'hand', 'pen', 'eraser', 'line', 'arrow', 'rect', 'ellipse', 'text', 'note', 'laser'],
        style: { strokeWidth: 1 },
        penResetsWidth: true,
    },
    /** Just writing: pen, eraser, laser. Good for phones and young learners. */
    simple: {
        tools: ['pen', 'eraser', 'laser'],
        style: { strokeWidth: 2 },
    },
    /** Watch only: pan and point. */
    viewer: {
        tools: ['hand', 'laser'],
        tool: 'hand',
        readOnly: true,
    },
} satisfies Record<string, Partial<WhiteboardOptions>>;
