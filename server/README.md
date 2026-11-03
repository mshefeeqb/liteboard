# liteboard-server

The WebSocket relay for liteboard. It does three jobs:

- Forwards live activity between people on the same board: strokes being
  drawn, shapes, the laser, cursors and camera.
- Saves finished changes to Postgres in batches.
- Confirms each change to its sender only once it is saved.

See [../docs/scaling.md](../docs/scaling.md) for the design and cost estimate.

## Run

```bash
npm install
```

```bash
npm run build
```

```bash
PORT=8787 DATABASE_URL=postgres://user:pass@host/db LITEBOARD_JWT_SECRET=change-me node dist/bin.js
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8787` | WebSocket and `/health` port |
| `HOST` | all interfaces | Set `127.0.0.1` behind a reverse proxy on the same machine |
| `DATABASE_URL` | none | Postgres. Without it, boards live in memory and are lost on restart (development only). Tables are created on start. |
| `DATABASE_POOL_MAX` | `10` | Postgres connections |
| `LITEBOARD_JWT_SECRET` | none | HS256 secret for login tokens. Without it, anyone can open any board (development only). |

For a production server (Docker or systemd, TLS with Caddy, AWS EC2), see
[DEPLOY.md](DEPLOY.md).

`GET /health` returns `{ ok, connections, rooms, pending }`.

On `SIGTERM` or `SIGINT` the relay writes everything buffered, closes the
connections (clients reconnect elsewhere), and exits.

## Login tokens

Your backend signs a short-lived HS256 token for each user and board group:

```ts
import { signToken } from 'liteboard-server';

const token = signToken(
    {
        sub: user.id,
        name: user.name,
        boards: `${sessionId}:`, // the token opens only this session's boards
        write: canDraw,          // false = view only
        exp: Math.floor(Date.now() / 1000) + 3600,
    },
    process.env.LITEBOARD_JWT_SECRET!,
);
```

The client gets it through the `token` option of `connect()`. A function is
called on every reconnect, so it can fetch a fresh token.

## Storage

Two tables (`liteboard_ops`, `liteboard_snapshots`) are created by
`PostgresStorage.migrate()`:

- **Changes in use:** one row per change, while a board is in use.
- **Snapshot:** when a room has been empty for 30 s and has 200 or more rows,
  the rows are folded into one snapshot row per board.
- **Resends:** a resent change has the same `(client_id, cseq)` and is
  ignored, so retries never duplicate rows.
- **Cleanup:** `deleteBoards('session-123:%')` removes every board of a
  session.

Any other store works by implementing `BoardStorage` (`maxSeq`, `load`,
`append`, `compact`).

## Deploying several relays

All connections for a board must reach the **same** relay. Put the session
in the URL the client connects to, e.g. `wss://board.example.com/?session=123`,
and route on it:

- with HAProxy, use `balance url_param session` with `hash-type consistent`;
- or have a small endpoint return the relay URL for a session.

If two relays ever write the same board, the storage reports a sequence
conflict. The relay then renumbers its changes and starts a new epoch, so
clients reload the board instead of missing changes.

## Use as a library

```ts
import { createRelay, PostgresStorage, jwtAuthorizer } from 'liteboard-server';

const storage = new PostgresStorage(pool); // any pg.Pool / pg.Client
await storage.migrate();
const relay = await createRelay({ storage, port: 8787, authorize: jwtAuthorizer(secret) });
```

`authorize(token, boardId, user)` can be any function returning
`{ canWrite, user? }`, or `null` to refuse. Use it, for example, to check your
own sessions table.
