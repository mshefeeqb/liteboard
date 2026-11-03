# Roadmap

liteboard is a small, fast, embeddable whiteboard for slow networks and
low-end devices. This page tracks what is done and what is next.

## Goals

| Budget | Target | Now |
| --- | --- | --- |
| Core, gzip/brotli | ≤ 30 KB | 15.4 KB |
| Core + toolbar | ≤ 45 KB | 17.9 KB |
| Sync client | ≤ 10 KB | 5.2 KB |
| Idle CPU | none | no frames scheduled while idle |
| Stored size of a handwritten stroke | small | about 100 bytes binary, 200 bytes JSON |
| Saved changes lost on disconnect or crash | none | covered by an outbox that clears only after the server confirms the save, plus a chaos test |

## Done

### Phase 1: engine
- Two-canvas renderer: finished strokes are redrawn only on change, and a
  cheap top layer holds what is being drawn. Includes viewport culling, a
  pixel-ratio cap, and GPU panning when a full redraw is slow.
- Tools:
  - pen, with pressure and palm rejection
  - line, arrow, rectangle, ellipse
  - text and sticky notes
  - eraser and select (move, resize, nudge)
  - pan and laser pointer
- Per-user undo/redo, light and dark themes, an underlay for host content,
  PNG/SVG export, and an Excalidraw importer.
- A built-in responsive toolbar, a React wrapper, and a vanilla API.

### Phase 2: collaboration
- Binary protocol.
- Sync client (`liteboard/sync`):
  - an IndexedDB outbox, acknowledgements, and catch-up after reconnecting
  - reconnects with backoff and timeouts, and back/forward cache handling
  - slow-network throttling and board switching
  - presence, plus present/follow for camera following
- Live strokes, shapes, laser and named cursors.
- Relay server (`server/`, uWebSockets.js):
  - rooms and batched Postgres writes, acknowledged only after commit
  - compaction into snapshots
  - JWT access and a `/health` endpoint

## Next

- **Follow-mode UI.** The API exists, but there is no button yet.
- **Tests on real devices.** Budget Android tablets, older iPads and low-end
  phones, with throttled-network end-to-end tests in CI.
- **Web Component.** `<liteboard-board>` for Vue, Angular and plain HTML.
- **Snapshots in object storage.** Move them out of Postgres (S3, R2), with
  immutable file names.
- **Relay hardening.** Per-connection rate limits, metrics, a Docker image,
  and a multi-relay routing example.
- **Lesson replay.** Replay a board from its change log.
- **Accessibility.** Keyboard navigation on the canvas and screen-reader
  labels beyond the toolbar.
- **Publishing.** npm release with semver, a changelog and a docs site.

## Not planned

The hand-drawn "rough" style, a shape library, embeds, frames, diagram
importers and character-level collaborative text editing. Each would add
weight that most embedders don't need.
