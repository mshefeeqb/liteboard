# Whiteboard landscape (checked 2026-11-01)

Why liteboard is its own engine, and what it borrows from others. Sizes are
gzip, from bundlephobia or the npm registry on 2026-11-01.

## WooWhiteboard

[woowhiteboard.com](https://woowhiteboard.com) is a hosted tutoring app, not a
library. Its bundle is one Create React App file of 3.3 MB raw (about 843 KB
gzip), synced through Firebase, and it ships MUI, Desmos and MathQuill. It has
no license or SDK, so we can borrow ideas but no code.

## Libraries

| Candidate | Can we embed it in an MIT package? | Size | Collaboration | Notes |
| --- | --- | --- | --- | --- |
| tldraw 5.x | **No.** Source-available; production needs a license key, and so does everyone who uses our package. | 552 KB | Built in | Good, but heavy |
| Excalidraw 0.18 | Yes (MIT) | 353 KB | Bring your own | Popular and capable; reports of pen lag on iPad |
| WBO (whitebophir) | **No** (AGPL-3.0) | n/a (server app) | Server relay | Light, but it's an app, not a library |
| Agora/Netless Fastboard | **No.** The SDK is proprietary and needs Agora cloud credentials. | 600–700 KB | Agora cloud | Heavy |
| Drawnix / Plait | Yes (MIT) | about 80 KB | None | Built for diagrams |
| Weave.js | Yes (Apache-2.0) | 189 KB plus Konva and Yjs | Yjs | Konva-based |
| Quickdraw | Yes (MIT; turn its watermark off) | 28 KB | JSON diffs over your own transport | Closest to our goals; first released Jul 2026, still young |
| Konva / Fabric / Paper | Yes (MIT) | 57 / 92 / 104 KB | None | Canvas frameworks, not whiteboards |
| perfect-freehand | Yes (MIT) | 2 KB | n/a | **We use this** for stroke outlines |

### Sync layers

- **Yjs:** MIT, 28 KB, mature. Worth adding only if we need editing beyond 1:1
  lessons.
- **Automerge, Loro:** each ships about 1.1–1.2 MB of WASM, which is too heavy
  for 3G.
- **Liveblocks, PartyKit, Y-Sweet:** tied to hosted services.

For 1:1 and small-group boards, a last-writer-wins element map costs about
0 KB and needs nothing from the transport beyond delivering messages. See
[scaling.md](scaling.md) for why liteboard ships its own WebSocket relay
rather than relying on a hosted realtime service.

## What we borrowed (in Phase 1 unless noted)

1. **Two-layer canvas.** A static layer, plus a live layer on top. DPR is
   capped at 2, or 1.5 on low-memory devices. The live layer deliberately
   does *not* use `desynchronized: true`: mobile Chrome renders such a canvas
   as an opaque overlay, which turns a transparent layer black.
2. **Pointer input.** `getCoalescedEvents()`, `touch-action: none`, palm
   rejection once a pen is seen, and configurable two-finger gestures.
3. **Stroke pipeline.** perfect-freehand outlines, Ramer–Douglas–Peucker
   simplification at pointer-up, and a cached `Path2D` per stroke.
4. **Compact encoding.** Coordinates are quantised to 0.1 and delta-encoded.
   Next step (Phase 2): zigzag varints in a `Uint8Array` for about 2–4 bytes
   per point.
5. **Sync model.** A last-writer-wins record per element, with tombstones and
   per-user undo. *Phase 2:* stream in-progress points in 50–100 ms batches.
6. **Reconnect (Phase 2/3).** Snapshot plus ops "since clock N", never the
   whole board.
7. **Spatial index (later).** rbush (2.3 KB) if eraser hit-testing or culling
   shows up in profiles. A linear scan is fine at 2,000 strokes.
8. **`getPredictedEvents()` (later).** To hide pen latency.

## When building our own would be a mistake

- If the scope grows into a diagramming tool: connectors, rich text, frames,
  embeds. Stay ink-first: pen, eraser, laser, basic shapes, text, and host
  content underneath.
- If we need concurrent text editing. That needs a real CRDT (Yjs).
- If we don't test on real low-end devices. iPadOS and Safari pointer quirks
  and `desynchronized` gaps (Firefox has none) will eat the budget.

## Sources

- tldraw license: https://tldraw.dev/community/license
- Quickdraw: https://github.com/quickdrawjs/quickdraw
- Excalidraw P2P sync: https://plus.excalidraw.com/blog/building-excalidraw-p2p-collaboration-feature
- `desynchronized` support: https://web-platform-dx.github.io/web-features-explorer/features/canvas-2d-desynchronized
- Supabase Realtime limits: https://supabase.com/docs/guides/realtime/limits
- Package sizes: https://bundlephobia.com
