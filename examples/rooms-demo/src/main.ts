import { initApp, type Room } from '@freeappstore/sdk';

const apiBase = (import.meta.env['VITE_FAS_API'] as string | undefined) ?? 'http://localhost:8787';

const fas = initApp({ appId: 'rooms-demo', apiBase });
await fas.auth.init();

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

const statusEl = $('status');
const signInBtn = $('signin') as HTMLButtonElement;
const signOutBtn = $('signout') as HTMLButtonElement;
const peersEl = $('peers');
const input = $('input') as HTMLInputElement;
const messagesEl = $('messages');

let room: Room | null = null;

function appendLine(text: string): void {
  const div = document.createElement('div');
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function render(): void {
  const user = fas.auth.user;
  if (!user) {
    statusEl.textContent = 'not signed in';
    signInBtn.hidden = false;
    signOutBtn.hidden = true;
    input.disabled = true;
    return;
  }
  statusEl.textContent = `signed in as @${user.login}`;
  signInBtn.hidden = true;
  signOutBtn.hidden = false;
  input.disabled = false;
  joinRoom();
}

function joinRoom(): void {
  if (room) return;
  const r = fas.rooms.join('lobby');
  room = r;

  r.onPeers((peers) => {
    peersEl.textContent =
      peers.length === 0
        ? 'no peers yet'
        : `peers (${peers.length}): ${peers.map((p) => `@${p.login}`).join(', ')}`;
  });

  r.onMessage<{ text: string }>((msg) => {
    appendLine(`@${msg.from.login}: ${msg.data.text}`);
  });
}

signInBtn.addEventListener('click', () => fas.auth.signIn());
signOutBtn.addEventListener('click', () => {
  room?.close();
  room = null;
  fas.auth.signOut();
});

input.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const text = input.value.trim();
  if (!text || !room) return;
  room.send({ text });
  appendLine(`me: ${text}`);
  input.value = '';
});

fas.auth.onChange(render);
render();
