import { DEFAULT_FONT } from './render/draw';

/**
 * Optional fonts for text and sticky notes. Nothing is bundled: a font is
 * downloaded only when an app asks for it, once, and the browser caches it.
 * The board redraws by itself when a font finishes loading.
 */
export interface FontSource {
    /** CSS family name, e.g. "Excalifont". */
    family: string;
    /** Where the .woff2 file is served from. */
    url?: string;
    /** A stylesheet that declares the font (Google Fonts style). */
    css?: string;
}

/** Hand-drawn fonts under the SIL Open Font License, free for commercial use. */
export const fonts = {
    /**
     * Excalidraw's hand-drawn font: Latin, Greek, Cyrillic (52 KB). The file
     * ships with this package as `liteboard/fonts/Excalifont-Regular.woff2`,
     * with its licence in `liteboard/fonts/OFL.txt`; serve it from your app
     * and pass its URL: `loadFont({ ...fonts.excalifont, url })`.
     */
    excalifont: { family: 'Excalifont' } as FontSource,
    /** Clear handwriting with Devanagari (Hindi, Marathi) as well as Latin. */
    kalam: { family: 'Kalam', css: 'https://fonts.googleapis.com/css2?family=Kalam&display=swap' },
    /** Very legible print handwriting, good for young learners. */
    patrickHand: {
        family: 'Patrick Hand',
        css: 'https://fonts.googleapis.com/css2?family=Patrick+Hand&display=swap',
    },
    /** Casual marker style. */
    caveat: { family: 'Caveat', css: 'https://fonts.googleapis.com/css2?family=Caveat&display=swap' },
} satisfies Record<string, FontSource>;

/**
 * A font-family value for the `fontFamily` option: the chosen fonts first,
 * then the system font, so characters a font lacks still render.
 */
export function fontStack(...sources: FontSource[]): string {
    return [...sources.map((s) => `"${s.family}"`), DEFAULT_FONT].join(', ');
}

const loading = new Map<string, Promise<void>>();

/**
 * Downloads a font and makes it available to the board. Returns its
 * font-family stack. Safe to call more than once.
 */
export async function loadFont(source: FontSource): Promise<string> {
    const key = source.url ?? source.css ?? source.family;
    let p = loading.get(key);
    if (!p) {
        p = (async () => {
            if (source.css) {
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = source.css;
                await new Promise<void>((resolve, reject) => {
                    link.onload = () => resolve();
                    link.onerror = () => reject(new Error(`Could not load ${source.css}`));
                    document.head.appendChild(link);
                });
                await document.fonts.load(`20px "${source.family}"`);
            } else if (source.url) {
                const face = new FontFace(source.family, `url(${source.url})`, { display: 'swap' });
                document.fonts.add(await face.load());
            } else {
                throw new Error(
                    `loadFont: no url for "${source.family}". Serve the font file from your app and pass its URL.`,
                );
            }
        })();
        p.catch(() => loading.delete(key));
        loading.set(key, p);
    }
    await p;
    return fontStack(source);
}
