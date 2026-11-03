# liteboard

A lightweight, fast whiteboard you can embed in any web app. Built for slow
networks and low-end tablets and phones. MIT licensed.

- **Small:** about 16 KB brotli for the core, 19 KB with the toolbar and 5 KB
  more for live sync,
  including its one dependency
  ([perfect-freehand](https://github.com/steveruizok/perfect-freehand)).
  Excalidraw is about 324 KB gzip.
- **Fast:** two canvases. Finished strokes are redrawn only when something
  changes; what you are drawing goes on a cheap top layer. Each stroke's path
  is cached, and off-screen strokes are skipped.
- **Ready for sync:** every element is a last-writer-wins record with a Lamport
  clock, so updates can arrive late, twice or out of order and every client
  still ends up with the same board. Undo only reverts your own changes.
- **Compact data:** points are stored as delta-encoded integers, so a
  handwritten stroke is about 300–400 bytes of JSON.
- **Any framework:** a vanilla core, a React component, and an optional
  built-in toolbar (or build your own).

> Status: the core engine and live collaboration through the WebSocket relay
> ([server/](server/README.md)) both work. See [ROADMAP.md](ROADMAP.md) and
> [docs/scaling.md](docs/scaling.md).

## Install

```bash
npm install liteboard
```

## Vanilla JS

```js
import { createWhiteboard } from 'liteboard';
import { mountToolbar } from 'liteboard/ui';

const wb = createWhiteboard(document.getElementById('board'), {
    boardId: 'lesson-1',
    scene: savedScene, // from wb.getScene(), or null
    theme: 'light',
});
mountToolbar(wb);

wb.on('change', (e) => {
    if (e.origin === 'local') save(wb.getScene()); // or send e.elements to peers
});
```

The board fills its container, so give the container a size.

## React

```tsx
import { Whiteboard } from 'liteboard/react';

<Whiteboard
    boardId={`${sessionId}:${topic}`}
    scene={scene}
    theme={theme}
    readOnly={!canWrite}
    drawStyle={{ strokeWidth: 1 }}
    penResetsWidth
    gestures={{ pinchZoom: false }}
    underlay={<LessonContent />}
    onChange={(e, wb) => save(wb.getScene())}
/>
```

`theme`, `readOnly` and `boardId` follow props. Changing `boardId` saves any
open text and switches boards; pass that board's `scene` with it. The
component is marked `'use client'` for the Next.js app router.

## Options

| Option | Default | |
| --- | --- | --- |
| `boardId` | — | Identifies the board in events. |
| `scene` | — | Board to show (`getScene()` output). |
| `theme` | `'light'` | `'light'` or `'dark'`. Black ink is drawn light on dark boards. |
| `readOnly` | `false` | Only pan and the laser pointer remain. |
| `tools` | all | Any of `select hand pen line arrow rect ellipse text note eraser laser`, in toolbar order. |
| `tool` | `'pen'` | Starting tool. |
| `style` | `{ color: '#1e1e1e', strokeWidth: 2, fontSize: 20, noteColor: '#ffec99' }` | Starting style. |
| `penResetsWidth` | `false` | Choosing the pen resets the width to `style.strokeWidth`. |
| `gestures` | `{ pinchZoom: true, twoFingerPan: true, wheel: 'pan' }` | Touch and wheel behaviour. |
| `background` | transparent | Board colour. |
| `underlay` | — | Element under the strokes that pans and zooms with them. |
| `fontFamily` | system UI | Font for text. |
| `maxPixelRatio` | `2` (`1.5` on ≤ 2 GB devices) | Caps canvas sharpness. `1.5` saves about 44% canvas memory on Retina screens. |
| `keyboard` | `true` | Shortcuts while the board has focus. |

## Choosing features

Every tool, toolbar button and gesture can be switched on or off, at start or
while the board is running. Start from a preset and override what you need:

```ts
import { createWhiteboard, presets } from 'liteboard';
import { mountToolbar } from 'liteboard/ui';

const wb = createWhiteboard(el, { ...presets.teaching, gestures: { pinchZoom: false } });
const toolbar = mountToolbar(wb, { undo: true, style: true, zoom: false, clear: true });

// Later, e.g. from your app's settings:
wb.setTools(['pen', 'eraser', 'laser']);
wb.setGestures({ pinchZoom: true });
toolbar.update({ zoom: true });
```

| Preset | Tools |
| --- | --- |
| `full` | everything |
| `teaching` | select, pan, pen (thin by default), eraser, line, arrow, rectangle, ellipse, text, sticky note, laser |
| `simple` | pen, eraser, laser: for phones and young learners |
| `viewer` | pan and laser, read-only |

| Toolbar option | Default | |
| --- | --- | --- |
| `style` | `true` | Colour, width and note-colour panel |
| `undo` | `true` | Undo and redo buttons |
| `zoom` | `false` | Zoom out, level (tap to reset), zoom in |
| `clear` | `false` | Clear board, which asks for a second tap |
| `colors`, `widths`, `noteColors` | built in | Choices offered in the panel |
| `labels` | English | Tooltips, e.g. for translation |
| `position` | `'auto'` | `'left'`, `'bottom'`, or auto (bottom on narrow boards) |

In React, `tools`, `toolbar`, `gestures` and `fontFamily` props update live.
The demo's **Features** button lets you try every switch and copy the
resulting config.

## Content under the board

Pass any element as `underlay` (React: any JSX): rendered Markdown, KaTeX
maths, HTML, images or PDF pages. It gets the same camera transform as the
strokes, so pinch zoom and panning keep every stroke exactly where it was
drawn on the content. It is redrawn sharp once the zoom settles.

```tsx
<Whiteboard
    underlay={<ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{lesson}</ReactMarkdown>}
    gestures={{ pinchZoom: true, twoFingerPan: true }}
/>
```

- **Not interactive:** the content sits under the drawing surface, so links
  and buttons in it don't respond.
- **Sizing:** give it a fixed width (e.g. `width: 800px`), so it lays out
  the same on every screen and strokes land on the same words for everyone.
- **Exporting:** for a PNG that includes the content, draw it yourself in
  `exportPNG({ drawUnderlay })`, e.g. with html2canvas.

## Fonts

Nothing is bundled into the code; a font downloads only if you ask for it.

**Excalifont**, Excalidraw's hand-drawn font, ships with this package:
`liteboard/fonts/Excalifont-Regular.woff2` (52 KB; Latin, Greek, Cyrillic),
with its licence in `liteboard/fonts/OFL.txt`. Serve the file from your app:

```ts
import { fonts, loadFont } from 'liteboard';

// Vite: import url from 'liteboard/fonts/Excalifont-Regular.woff2?url';
// Next.js or anything else: copy the file to /public/fonts/.
wb.setFont(await loadFont({ ...fonts.excalifont, url: '/fonts/Excalifont-Regular.woff2' }));
```

| Font | Good for | Comes from |
| --- | --- | --- |
| `fonts.excalifont` | The Excalidraw look | this package (self-hosted) |
| `fonts.kalam` | Handwriting with **Devanagari** (Hindi, Marathi) | Google Fonts |
| `fonts.patrickHand` | Very legible print handwriting | Google Fonts |
| `fonts.caveat` | Casual marker style | Google Fonts |

All are under the SIL Open Font License 1.1, which allows use in paid
products. Keep `OFL.txt` with the font file and don't sell the font on its
own. To mix fonts (e.g. Excalifont for English, Kalam for Hindi), load both
and pass `fontStack(fonts.excalifont, fonts.kalam)` as `fontFamily`.

## API

```ts
wb.setTool('eraser'); wb.setStyle({ color: '#e03131', strokeWidth: 4 });
wb.undo(); wb.redo(); wb.clear(); wb.deleteSelected(); wb.selectAll();
wb.getElements(); wb.getScene(); wb.load(boardId, scene); wb.merge(remoteElements);
wb.setCamera({ x, y, zoom }); wb.zoomTo(1.5); wb.zoomToContent();
wb.setTheme('dark'); wb.setReadOnly(true); wb.setFont(fontFamily);
wb.setTools(['pen', 'eraser']); wb.setGestures({ pinchZoom: false });
await wb.exportPNG({ background: '#fff', drawUnderlay: (ctx, region) => {...} });
wb.exportSVG();
wb.on('change' | 'camera' | 'tool' | 'style' | 'selection' | 'history' | 'load' | 'theme' | 'readOnly', fn);
wb.destroy();
```

### Live collaboration

```ts
import { connect } from 'liteboard/sync';

const sync = connect(wb, {
    url: 'wss://board.example.com/?session=123',
    token: () => fetch('/api/board-token').then((r) => r.text()), // checked by the relay
    user: { id: user.id, name: user.name, color: '#e03131' },
});

sync.on('status', (s) => {}); // 'connecting' | 'online' | 'offline' | 'denied' | 'closed'
sync.on('pending', (n) => {}); // changes not yet confirmed saved; 0 = all safe
sync.on('peers', (peers) => {}); // who else is on the board
sync.present(true); // others can follow your camera…
sync.follow(peerNo); // …and you can follow theirs ('any' follows whoever presents)
sync.on('joined', ({ boardId, elements }) => {}); // a board finished loading
sync.close();
```

- **Boards:** `wb.load(otherBoardId)` switches boards on the same
  connection.
- **Live activity:** strokes appear on everyone's screen while they're being
  drawn, along with shapes, the laser and named cursors.
- **Saved changes:** each change waits in IndexedDB until the server confirms
  it is in the database, and is resent after any reconnect, reload or crash.
- **Wire size:** messages are binary. A handwritten stroke is about 100 bytes.
- **Slow networks:** live updates are batched and dropped first; saved
  changes never are.

Run a relay locally with `npm run relay` (see [server/README.md](server/README.md)).

### Importing Excalidraw boards

```ts
import { fromExcalidraw } from 'liteboard/excalidraw';
wb.load(boardId, fromExcalidraw(excalidrawJson));
```

This converts pen strokes, lines, arrows, rectangles, ellipses, diamonds and
text. Rotation and images are not carried over.

## Input

- **Pen and stylus:** pressure-sensitive. Once a pen is used, finger touches
  only pan (palm rejection).
- **Touch:** one finger draws. Two fingers pan and zoom, depending on
  `gestures`.
- **Mouse:** the wheel pans and ctrl+wheel zooms. Middle-drag or Space+drag
  pans.
- **Keys:** V select, H pan, P pen, L line, A arrow, R rectangle, O ellipse,
  T text, N sticky note, E eraser, K laser. Ctrl/Cmd+Z undoes, Shift+Ctrl/Cmd+Z or Ctrl+Y
  redoes, Delete removes the selection, and arrow keys nudge it.
- **Sticky notes:** tap to add a note and type. The text wraps, and the note
  grows to fit. Double-click a note (select tool) to edit it.
- **Text:** Enter adds a line. Escape, Ctrl/Cmd+Enter, clicking away,
  switching boards or destroying the board saves the text.

## Development

```bash
npm install
```

```bash
npm run dev
```

The dev command serves the demos at http://localhost:5199. `/` is the vanilla
demo; with `npm run relay` running, open it in two tabs (or on a phone and a
tablet on the same network) to draw together. `/react.html` is the React
demo.

```bash
npm test
```

```bash
npm run size
```
