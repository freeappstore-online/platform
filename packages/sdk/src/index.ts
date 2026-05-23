import { Auth } from './auth.js';
import { Counters } from './counters.js';
import { Collections } from './db.js';
import { Email } from './email.js';
import { Keys } from './keys.js';
import { Kv } from './kv.js';
import { ApiProxy } from './proxy.js';
import { Roles } from './roles.js';
import { Rooms } from './rooms.js';
import type { FasInitOptions } from './types.js';

export type { AuthProvider } from './auth.js';
export type { Collection, QueryOptions, QueryResult } from './db.js';
export { Collections } from './db.js';
export type { ConnectionState, Room, RoomMessage, RoomPeer } from './rooms.js';
export type { RoleAssignment, DefaultRole } from './roles.js';
export { DEFAULT_ROLES } from './roles.js';
export type { FasInitOptions, Unsubscribe, User } from './types.js';

/** Root SDK instance — provides auth, kv, collections, counters, rooms, and proxy sub-clients. */
export class FreeAppStore {
  readonly auth: Auth;
  readonly kv: Kv;
  readonly collections: Collections;
  readonly counters: Counters;
  readonly rooms: Rooms;
  readonly proxy: ApiProxy;
  readonly roles: Roles;
  readonly keys: Keys;
  readonly email: Email;

  constructor(opts: FasInitOptions) {
    const apiBase = opts.apiBase ?? 'https://api.freeappstore.online';
    this.auth = new Auth(opts.appId, apiBase);
    this.kv = new Kv(opts.appId, apiBase, this.auth);
    this.collections = new Collections(opts.appId, apiBase, this.auth);
    this.counters = new Counters(opts.appId, apiBase, this.auth);
    this.rooms = new Rooms(opts.appId, apiBase, this.auth);
    this.proxy = new ApiProxy(opts.appId, apiBase, this.auth);
    this.roles = new Roles(opts.appId, apiBase, this.auth);
    this.keys = new Keys(opts.appId, apiBase, this.auth);
    this.email = new Email(opts.appId, apiBase, this.auth);
  }
}

/** Create a new FreeAppStore SDK instance for the given app. */
export function initApp(opts: FasInitOptions): FreeAppStore {
  return new FreeAppStore(opts);
}
