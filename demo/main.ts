import { createWhiteboard, type Whiteboard } from 'liteboard';
import { connect, type SyncClient } from 'liteboard/sync';
import { mountToolbar } from 'liteboard/ui';
import { mountFeatures } from './features';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Phones have no console at hand: show errors on the page itself.
function showError(message: string): void {
    const box = $('errors');
    box.hidden = false;
    box.textContent = `Error: ${message}`;
}
window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError(String(e.reason)));

// The relay from `npm run relay` (server/), on the same host as this page.
// Open the page in two tabs or on a phone and tablet to draw together.
const RELAY_URL = `ws://${location.hostname}:8787`;
const COLORS = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5'];
const params = new URLSearchParams(location.search);
const myName = params.get('name') ?? `User ${Math.floor(Math.random() * 90 + 10)}`;
const myColor = COLORS[Math.floor(Math.random() * COLORS.length)];

function lessonContent(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lesson';
    el.innerHTML = `
        <h2>Solving a quadratic</h2>
        <p>This text is host content in the <b>underlay</b>. It pans and zooms with the strokes, like a lesson page.</p>
        <p class="eq">x² − 5x + 6 = 0</p>
        <p>Factor it, then circle the roots.</p>`;
    return el;
}

/** Shows connection state and unsaved changes for one board. */
function trackStatus(sync: SyncClient, label: HTMLElement, who: string): void {
    const render = () => {
        const saved = sync.pending === 0 ? 'all saved' : `${sync.pending} saving…`;
        const others = sync.peers.map((p) => p.user.name).join(', ') || 'nobody else';
        label.textContent = `${who}: ${sync.status} · ${saved} · with ${others}`;
    };
    sync.on('status', render);
    sync.on('pending', render);
    sync.on('peers', render);
    render();
}

// ---- Board A ------------------------------------------------------------------

// A whiteboard starts white; `?theme=dark` or the button switches it.
let theme: 'light' | 'dark' = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.classList.toggle('dark', theme === 'dark');

const boardSelect = $<HTMLSelectElement>('board');
const a = createWhiteboard($('a'), {
    boardId: boardSelect.value,
    theme,
    underlay: lessonContent(),
    style: { strokeWidth: 1 },
    penResetsWidth: true,
});
const toolbarA = mountToolbar(a);
mountFeatures($('features'), a, toolbarA);
const syncA = connect(a, { url: RELAY_URL, user: { id: myName, name: myName, color: myColor } });
trackStatus(syncA, $('syncA'), myName);

boardSelect.addEventListener('change', () => {
    a.load(boardSelect.value);
    peer?.load(boardSelect.value);
});

// ---- Peer board: a second user in this page, through the same relay ---------------

let peer: Whiteboard | null = null;
let peerSync: SyncClient | null = null;

function togglePeer(): void {
    if (peer) {
        peerSync?.close();
        peer.destroy();
        peer = null;
        $('b')?.remove();
        $('syncB').textContent = '';
        $('peer').textContent = 'Show peer';
        return;
    }
    const host = document.createElement('div');
    host.className = 'board';
    host.id = 'b';
    host.innerHTML = '<span class="label">Second user</span>';
    document.querySelector('main')!.appendChild(host);
    const b = createWhiteboard(host, {
        boardId: a.boardId,
        theme,
        underlay: lessonContent(),
        style: { color: '#1971c2', strokeWidth: 1 },
    });
    mountToolbar(b);
    peerSync = connect(b, { url: RELAY_URL, user: { id: 'peer', name: 'Student', color: '#1971c2' } });
    trackStatus(peerSync, $('syncB'), 'Student');
    peer = b;
    Object.assign(window, { peer: b, peerSync });
    $('peer').textContent = 'Hide peer';
}

// ---- Controls -------------------------------------------------------------------

$('theme').textContent = theme === 'dark' ? 'Light' : 'Dark';
$('theme').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    $('theme').textContent = theme === 'dark' ? 'Light' : 'Dark';
    a.setTheme(theme);
    peer?.setTheme(theme);
});

$('readonly').addEventListener('click', () => {
    a.setReadOnly(!a.readOnly);
    $('readonly').textContent = `Read-only: ${a.readOnly ? 'on' : 'off'}`;
});

$('peer').addEventListener('click', togglePeer);
$('fit').addEventListener('click', () => a.zoomToContent());
$('clear').addEventListener('click', () => a.clear());

$('stress').addEventListener('click', () => {
    // Wavy handwriting-like strokes spread over a large area.
    a.store.transact(() => {
        for (let i = 0; i < 2000; i++) {
            const ox = Math.random() * 3000 - 500;
            const oy = Math.random() * 2000 - 300;
            const pts: number[] = [];
            for (let j = 0; j < 40; j++) {
                pts.push(j * 3, Math.sin(j / 4 + i) * 12 + j * 0.5);
            }
            a.store.write({
                t: 'pen',
                x: Math.round(ox),
                y: Math.round(oy),
                w: 117,
                h: 44,
                pts: pts.map((v, k) => Math.round((v + (k % 2 ? 12 : 0)) * 10) / 10),
                c: ['#1e1e1e', '#e03131', '#1971c2', '#2f9e44'][i % 4],
                sw: 1,
            });
        }
    });
});

$('png').addEventListener('click', async () => {
    const blob = await a.exportPNG({ background: '#ffffff' });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), {
        href: url,
        download: `${a.boardId ?? 'board'}.png`,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// ---- Stats: elements, stored size, zoom ------------------------------------------
// Updated only when something changes, so an idle page does no work at all.

let statsTimer = 0;
function updateStats(): void {
    if (statsTimer) return;
    statsTimer = window.setTimeout(() => {
        statsTimer = 0;
        const bytes = JSON.stringify(a.getScene()).length;
        $('stats').textContent =
            `${a.getElements().length} elements · ${(bytes / 1024).toFixed(1)} KB · zoom ${Math.round(a.camera.zoom * 100)}%`;
    }, 500);
}
a.on('change', updateStats);
a.on('camera', updateStats);
a.on('load', updateStats);
updateStats();

Object.assign(window, { board: a, sync: syncA });
