/**
 * Web Push for agent session notifications. The implementation is shared with
 * the backend's scheduled reminder delivery (#146) and lives there; this file
 * re-exports it so the agent and backend can't drift apart.
 */
export { type PushSubscription, sendWebPush, type WebPushResult } from "../../../packages/backend/src/lib/web-push";
