# Deploying the relay on a single server (AWS EC2)

One small server runs the relay behind [Caddy](https://caddyserver.com),
which provides `wss://` on port 443 with a free, auto-renewed certificate.
Browsers then reach the board like any HTTPS site, so school and office
firewalls let it through.

```
browser ──wss:443──► Caddy ──► relay :8787 (not public) ──► Postgres
```

Everything is in [`deploy/`](deploy): `docker-compose.yml`, `Caddyfile`,
`relay.env.example`, and `liteboard-relay.service` for running without Docker.

## 1. Create the server

| Setting | Value |
| --- | --- |
| Image | Ubuntu 24.04 LTS, **arm64** (Graviton is cheaper; x64 works too) |
| Type | `t4g.small` to start (2 vCPU, 2 GB). See [sizing](#sizing). |
| Disk | 20 GB gp3 |
| Region | Close to your users and to your Postgres |
| Security group | **80 and 443 from anywhere** (TCP). 22 from your own IP only, or no SSH and use Session Manager. **Never open 8787.** |
| Address | Allocate an Elastic IP and attach it, so the address survives restarts |

## 2. Point a domain at it

Create an `A` record, e.g. `board.example.com` → the Elastic IP. Use a
subdomain of your app's own domain: brand-new domains are sometimes blocked
by web filters.

If the domain is on Cloudflare, set the record to **DNS only** (grey cloud)
at first so Caddy can get its certificate. WebSockets also work through
Cloudflare's proxy later if you want it.

## 3. Install Docker

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
```

```bash
sudo usermod -aG docker $USER && newgrp docker
```

## 4. Get the relay and configure it

```bash
git clone --depth 1 --branch v0.1.3 https://github.com/mshefeeqb/liteboard.git && cd liteboard/server/deploy
```

```bash
cp relay.env.example relay.env && chmod 600 relay.env
```

Edit `relay.env`:

- **`DATABASE_URL`**: your Postgres. On Supabase, use the **session pooler**
  (port 5432) or the direct connection, not the transaction pooler (6543).
- **TLS to Postgres**: download your database's CA certificate (on Supabase:
  *Database settings → SSL configuration*) to `certs/db-ca.crt` and keep
  `?sslmode=verify-full&sslrootcert=/certs/db-ca.crt` in the URL.
- **`LITEBOARD_JWT_SECRET`**: the same secret your app signs board tokens with.

Then set the domain once (Compose reads `.env` on every command):

```bash
echo RELAY_DOMAIN=board.example.com > .env
```

## 5. Start

```bash
docker compose up -d --build
```

The first build takes a few minutes. The relay creates its tables on first
start; if you already created them (for example with your own migration and
row-level security), it uses those.

Check it:

```bash
curl https://board.example.com/health
```

It should return `{"ok":true,...}`. Logs, including a stats line every minute:

```bash
docker compose logs -f relay
```

## 6. Point the app at it

- Relay URL in the client: `wss://board.example.com`
- Add `wss://board.example.com` to your Content-Security-Policy `connect-src`.
- Your token endpoint signs with the same `LITEBOARD_JWT_SECRET`.

## Updating

```bash
git fetch --depth 1 origin tag v0.1.4 && git checkout v0.1.4 && docker compose up -d --build relay
```

The relay writes everything buffered and closes; clients reconnect within a
few seconds. Unsaved strokes wait on each device and are resent, so nothing
is lost, but boards show *offline* briefly. Update outside class hours.

## Monitoring

- **Uptime:** an external check (CloudWatch Synthetics, UptimeRobot, …) on
  `https://board.example.com/health` every minute.
- **Server:** CloudWatch CPU, plus memory with the CloudWatch agent.
- **`pending` in `/health`** is the number of changes waiting to be saved. If it
  keeps growing, Postgres is slow or unreachable: see the relay logs.

## Sizing

| Live classes at once | Instance | About per month (on-demand) |
| --- | --- | --- |
| up to ~1,000 | `t4g.small` | $12 |
| several thousand | `t4g.medium` | $25 |
| 10,000+ | `c7g.large` / `c7g.xlarge` | $50–105 |

Add about $4 for the public IPv4 address and $2 for the disk. AWS charges
for data leaving the server after the first 100 GB a month; a two-person
class-hour is about 1.6 MB. See [../docs/scaling.md](../docs/scaling.md).

One server is a single point of failure: during a restart or crash, boards
are offline (not losing data) until it is back. For more than one relay,
route every connection of a session to the same relay (see
[README.md](README.md#deploying-several-relays)).

## Without Docker (systemd)

1. Install Node.js 22 and [Caddy](https://caddyserver.com/docs/install).
2. Build the relay:
   ```bash
   sudo git clone --depth 1 --branch v0.1.3 https://github.com/mshefeeqb/liteboard.git /opt/liteboard && cd /opt/liteboard && sudo npm run setup && sudo npm --prefix server run build
   ```
3. Create the service user and settings:
   ```bash
   sudo useradd --system --no-create-home liteboard && sudo mkdir -p /etc/liteboard && sudo cp server/deploy/relay.env.example /etc/liteboard/relay.env && sudo chmod 600 /etc/liteboard/relay.env
   ```
   Fill it in, and add `HOST=127.0.0.1` so the relay is reachable only
   through Caddy. Put the CA certificate where `sslrootcert` points.
4. Start it:
   ```bash
   sudo cp server/deploy/liteboard-relay.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now liteboard-relay
   ```
5. Use `deploy/Caddyfile` as `/etc/caddy/Caddyfile`, with
   `RELAY_DOMAIN=board.example.com` and `RELAY_UPSTREAM=127.0.0.1:8787` in
   Caddy's environment (`sudo systemctl edit caddy` →
   `[Service]` `Environment=...`), then `sudo systemctl restart caddy`.
