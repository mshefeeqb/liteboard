# liteboard

A lightweight, fast whiteboard you can embed in any web app. Built for slow
networks and low-end tablets and phones. MIT licensed.

- **Small:** about 15 KB brotli for the core, 18 KB with the toolbar and 5 KB
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

## API

```ts
wb.setTool('eraser'); wb.setStyle({ color: '#e03131', strokeWidth: 4 });
wb.undo(); wb.redo(); wb.clear(); wb.deleteSelected(); wb.selectAll();
wb.getElements(); wb.getScene(); wb.load(boardId, scene); wb.merge(remoteElements);
wb.setCamera({ x, y, zoom }); wb.zoomTo(1.5); wb.zoomToContent();
wb.setTheme('dark'); wb.setReadOnly(true);
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
sync.follow(peerNo); // …and you can follow theirs
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
