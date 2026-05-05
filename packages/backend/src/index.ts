import { Hono } from 'hono';
import type { Env } from './types.js';
import { authRoutes } from './routes/auth.js';
import { kvRoutes } from './routes/kv.js';
import { roomRoutes } from './routes/rooms.js';

export { Room } from './do/room.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('FreeAppStore API'));
app.get('/health', (c) => c.json({ ok: true }));

const v1 = new Hono<{ Bindings: Env }>();
v1.route('/', authRoutes);
v1.route('/', kvRoutes);
v1.route('/', roomRoutes);
app.route('/v1', v1);

export default app;
