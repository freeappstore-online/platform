import { Auth } from './auth.js';
import { Kv } from './kv.js';
import { Rooms } from './rooms.js';
import type { FasInitOptions } from './types.js';

export type { User, FasInitOptions, Unsubscribe } from './types.js';
export type { Room, RoomMessage } from './rooms.js';

export class FreeAppStore {
  readonly auth: Auth;
  readonly kv: Kv;
  readonly rooms: Rooms;

  constructor(opts: FasInitOptions) {
    const apiBase = opts.apiBase ?? 'https://api.freeappstore.online';
    this.auth = new Auth(opts.appId, apiBase);
    this.kv = new Kv(opts.appId, apiBase, this.auth);
    this.rooms = new Rooms(opts.appId, apiBase, this.auth);
  }
}

export function initApp(opts: FasInitOptions): FreeAppStore {
  return new FreeAppStore(opts);
}
