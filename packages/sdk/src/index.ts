import { Auth } from "./auth.js";
import { Kv } from "./kv.js";
import { ApiProxy } from "./proxy.js";
import { Rooms } from "./rooms.js";
import type { FasInitOptions } from "./types.js";

export type { ConnectionState, Room, RoomMessage, RoomPeer } from "./rooms.js";
export type { FasInitOptions, Unsubscribe, User } from "./types.js";

export class FreeAppStore {
  readonly auth: Auth;
  readonly kv: Kv;
  readonly rooms: Rooms;
  readonly proxy: ApiProxy;

  constructor(opts: FasInitOptions) {
    const apiBase = opts.apiBase ?? "https://api.freeappstore.online";
    this.auth = new Auth(opts.appId, apiBase);
    this.kv = new Kv(opts.appId, apiBase, this.auth);
    this.rooms = new Rooms(opts.appId, apiBase, this.auth);
    this.proxy = new ApiProxy(opts.appId, apiBase, this.auth);
  }
}

export function initApp(opts: FasInitOptions): FreeAppStore {
  return new FreeAppStore(opts);
}
