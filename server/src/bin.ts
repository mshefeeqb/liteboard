import { jwtAuthorizer } from './jwt';
import { PostgresStorage } from './postgres';
import { createRelay } from './relay';
import { MemoryStorage, type BoardStorage } from './storage';

/**
 * Runs a relay from environment variables:
 *   PORT                    default 8787
 *   HOST                    interface to listen on; default all (IPv4 and IPv6).
 *                           127.0.0.1 behind a reverse proxy on the same machine.
 *   DATABASE_URL            Postgres; without it changes live in memory only
 *   DATABASE_POOL_MAX       Postgres connections, default 10
 *   DATABASE_MIGRATE        false = don't create the tables on start (they exist
 *                           already and the relay's role may only use them)
 *   LITEBOARD_JWT_SECRET    HS256 secret; without it anyone may open any board
 */
async function main() {
    const log = (msg: string, extra?: unknown) =>
        console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...(extra as object) }));

    let storage: BoardStorage;
    let pool: { end(): Promise<void> } | null = null;
    if (process.env.DATABASE_URL) {
        const { default: pg } = await import('pg');
        const p = new pg.Pool({
            connectionString: process.env.DATABASE_URL,
            max: Number(process.env.DATABASE_POOL_MAX ?? 10),
        });
        // A pooler or failover can drop idle connections; without a listener
        // that error would end the process. The pool reconnects on next use.
        p.on('error', (err) => log('postgres idle connection error', { err: String(err) }));
        pool = p;
        const pgStorage = new PostgresStorage(p);
        if (process.env.DATABASE_MIGRATE !== 'false') await pgStorage.migrate();
        storage = pgStorage;
    } else {
        log('DATABASE_URL not set: boards are kept in memory and lost on restart');
        storage = new MemoryStorage();
    }

    const secret = process.env.LITEBOARD_JWT_SECRET;
    if (!secret) log('LITEBOARD_JWT_SECRET not set: anyone may open any board');

    const relay = await createRelay({
        storage,
        port: Number(process.env.PORT ?? 8787),
        host: process.env.HOST || undefined,
        authorize: secret ? jwtAuthorizer(secret) : undefined,
        log,
    });

    const shutdown = async () => {
        log('shutting down: writing buffered changes');
        await relay.close();
        await pool?.end();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    setInterval(() => log('stats', relay.stats()), 60_000).unref();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
