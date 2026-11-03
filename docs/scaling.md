# Collaboration at scale: WebSocket design and cost

Live collaboration runs over liteboard's own WebSocket relay (`server/`,
`src/sync/`) rather than a hosted realtime service. Snapshots are kept in
Postgres for now; moving them to object storage is on the roadmap. This page covers how it works, how it avoids
losing data, what it costs at **10,000 classes at the same time**, and how the
board stays light on users' devices.

All numbers are estimates from stated assumptions. Prices are list prices as
of late 2026 and need checking before you commit to a provider.

---

## 1. The complete picture

```
 Teacher device                      Relay server (uWebSockets.js)               Student device
┌──────────────────┐   wss://      ┌──────────────────────────────┐   wss://   ┌──────────────────┐
│ liteboard        │──────────────►│ room "session-123"           │──────────►│ liteboard        │
│  outbox (IndexedDB)◄── ack ──────│  • relays live bytes as-is   │           │  merges by        │
└──────────────────┘               │  • buffers finished strokes  │           │  version          │
                                   │  • every 1 s: one batch      │           └──────────────────┘
                                   │    INSERT → Postgres, then ack│
                                   └──────────────┬───────────────┘
                                                  │
                     ┌────────────────────────────▼─────────────────────────────┐
                     │ Postgres (hot): whiteboard_ops for boards in use now      │
                     │ Object storage (cold): one compressed snapshot per board, │
                     │ written when the class ends, new file name every time     │
                     └───────────────────────────────────────────────────────────┘
```

| Step | What happens |
| --- | --- |
| **Connect** | Client opens `wss://board.example.com/?board=<boardId>` with the user's login token. The server checks the token and the user's access to that session (cached for a few minutes), then joins the room. |
| **Routing** | Every connection for a session goes to the **same server**, by hashing the session id (HAProxy/Nginx `hash` on the query parameter, or a small "which server?" lookup). Teacher and student meet in one process, so no Redis pub/sub is needed. |
| **Live drawing** | Points of the stroke being drawn, cursors and the laser are forwarded to the others in the room **without being parsed or stored**. This is the cheap fast path. |
| **Finished strokes** | Relayed at once, and also buffered. Every second the server writes all buffered strokes from all its rooms in **one batched INSERT**. Only after Postgres confirms does it send the client an ack. |
| **Opening a board** | Download the latest snapshot file, then fetch the rows newer than it. Snapshot files are immutable and get a new name each time, so a CDN can never serve a stale board. |
| **Class ends** | When a room has been empty for about 5 minutes, the server merges the rows into a new compressed snapshot, uploads it, points the board at it, and deletes the rows. Postgres only ever holds boards in active use. |

### Message format

Binary frames, not JSON: one type byte, the element id, then points as
zigzag-varint deltas. A handwritten stroke is about **60–100 bytes** on the
wire, against about 200 bytes in our compact JSON and over 1.5 KB in
Excalidraw.

---

## 2. No lost data: the delivery chain

1. **Saved on the device first.** A finished stroke goes into the IndexedDB
   outbox before anything is sent. A closed tab, a crash or a dead battery
   doesn't lose it.
2. **Sent with an id.** Each change carries `(clientId, clientSeq)`.
3. **Relayed, then made durable.** The server relays the change, writes it to
   Postgres, and **only then** acks.
4. **Removed only after the ack.** Anything not acked is resent after a
   reconnect.
5. **Duplicates are harmless.** A unique key on `(board_id, client_id,
   client_seq)` drops repeated inserts, and the version merge ignores repeated
   updates.
6. **Missed updates are fetched.** On reconnect a client asks for "rows for
   this board after id N" and gets exactly what it missed.
7. **Server crash or deploy.** Clients reconnect to another server, with
   backoff and jitter so they don't all arrive at once. Acked data is already
   in Postgres; un-acked data is still in the outboxes and gets resent.
8. **Monitoring.** The client reports its oldest un-acked change. Alert if any
   client has had data waiting longer than 30 seconds.

**The guarantee:** every stroke is delivered at least once and applied exactly
once. Nothing is overwritten, because nothing ever uploads a whole board.

---

## 3. Cost for 10,000 simultaneous classes

### Assumptions (a "heavy" class)

| Assumption | Value |
| --- | --- |
| Classes at peak | 10,000 at once, 2 people each, so about **20,000 connections** (plan for 25,000 with observers) |
| Drawing | Someone is drawing **40%** of the time, at about 2 strokes per second |
| Strokes | About **2,900 per class-hour**, at about 80 bytes each in binary |
| Monthly volume | About **2.2 million class-hours** (10k classes for 4 peak hours a day plus about 4k for 8 more hours) |

### Traffic per class-hour (through the server)

| | Data |
| --- | --- |
| Live points while drawing (10 batches/s) | ~0.63 MB |
| Finished strokes | ~0.23 MB |
| Cursors (mouse users only, 10 Hz while moving) | ~0.13 MB |
| Laser, follow mode, acks, heartbeats | ~0.10 MB |
| **Total each way** | **~1.1 MB** |
| Board load when joining (2 people) | ~0.5 MB |
| **Egress per class-hour** | **~1.6 MB** (about 4 MB if we stayed on JSON) |

### At peak (10,000 classes)

| Resource | Need | Capacity |
| --- | --- | --- |
| Bandwidth | ~25 Mbps each way, bursts to ~75 Mbps | One server's network card is 1–10 Gbps |
| Messages | ~160,000 per second in total | uWebSockets.js forwards several hundred thousand small messages per second per core |
| Connection memory | 25k sockets × ~5 KB, about **150 MB** | Fits easily in 8 GB |
| Database writes | ~2,000–5,000 rows/s in batches, about 1 MB/s | Comfortable for one 4 vCPU Postgres |

**Servers:** 2 relay servers with 4 vCPU and 8–16 GB each. One alone could
carry the peak; the second is for failover and deploys. Add a third if peak
grows past about 25k classes.

### Monthly bill

| Item | Budget hosting (Hetzner / DigitalOcean + R2) | All AWS |
| --- | --- | --- |
| 2–3 relay servers | $60–100 | $200–320 |
| Egress (~3.5 TB binary, ~9 TB JSON) | $0 (20 TB included per Hetzner server) | $315–810 at $0.09/GB |
| Postgres for active boards (4 vCPU, 16 GB) | $100–200 | $250–300 |
| Snapshot storage (grows ~0.3–0.5 TB/month) | ~$5–8 more each month (R2, no egress fee) | ~$8–12 more each month (S3) |
| Load balancer | $0–15 | $50–70 |
| **Total** | **about $200–350/month** | **about $850–1,550/month** |

That's **less than $0.001 per class-hour**.

### Why not Supabase Realtime at this size

At ~16 messages per second per class, a month is about **127 billion
messages**. At Supabase's published overage of about $2.50 per million
messages, that's about **$300,000/month**. Even if the estimate is 10× too
high, it's still about $30,000/month. The peak of about 160,000 messages per
second is also far above the standard plans' limits. Our own WebSocket server
costs 100–1,000× less, and it lets us send binary frames.

---

## 4. Light on the user's device (measured 2026-11-02, desktop Chrome)

| Situation | Cost |
| --- | --- |
| Board idle (nobody drawing) | **No frames scheduled: zero CPU** |
| While drawing | Only the top canvas redraws; finished strokes are not touched |
| Redraw, 2,000 strokes, normal zoom | 0.25 ms |
| Redraw, 10,000 strokes, normal zoom | 2.2 ms |
| Redraw, 10,000 strokes all on screen (zoomed out) | 41 ms. Too slow for every frame, so **panning slides the last image on the GPU** and redraws once the view rests. This switches on automatically when a redraw takes more than 8 ms. |
| Memory: drawing data | About 1–2.6 KB per stroke. A heavy lesson (3,000 strokes) is about 3–8 MB; 10,000 strokes measured ≤ 26 MB including garbage not yet collected |
| Memory: canvases | Width × height × pixel-ratio² × 4 bytes × 2 layers. A 1280×800 tablet at 1.5× is about 18 MB. Pixel ratio is capped at 2, and at 1.5 on devices with ≤ 2 GB RAM. |
| Network on the device | ~10 small messages per second while drawing, nothing while idle |

Low-end devices are roughly 4–6× slower than this desktop, so a typical lesson
board still redraws in a few milliseconds.

### Still to do for low-end devices

- **Incremental live stroke.** The stroke being drawn is re-outlined every
  frame, so cost grows with its length. Draw only the new tail instead, so a
  long scribble stays cheap. (Phase 2)
- **Level of detail when zoomed far out.** Draw simplified strokes, so a
  10,000-stroke board redraws in a few milliseconds. (Phase 4, only if needed)
- **A worker for encoding and the network.** Only if profiling on a real
  budget tablet shows main-thread pressure.
- **Real-device test pass.** Budget Android tablet, old iPad and a low-end
  phone, with the stress test and a 1-hour lesson recording.
