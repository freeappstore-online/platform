// The hidden Contribute window (#826): hosts the SDK's Kokoro worker for the main process, which
// runs the loop. A finished job's audio goes back as bytes (IPC carries no Blob).
import {
  deleteKokoroModel,
  isKokoroDownloaded,
  kokoroDevice,
  kokoroEncoder,
} from '@freeappstore/sdk/generation-kokoro';

const bridge = window.fasContribute;
let worker: Worker | null = null;

bridge.onMessage(async (message) => {
  const msg = message as { type: string };
  if (msg.type === 'terminate') {
    worker?.terminate();
    worker = null;
  } else if (msg.type === 'delete-model') {
    worker?.terminate();
    worker = null;
    await deleteKokoroModel();
    bridge.fromWorker({ type: 'model-deleted' });
  } else {
    if (!worker) {
      worker = new Worker(new URL('./contribute.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = async (e: MessageEvent<{ type: string; file?: Blob }>) => {
        const reply = e.data;
        bridge.fromWorker(
          reply.type === 'done' && reply.file
            ? { ...reply, file: await reply.file.arrayBuffer() }
            : reply,
        );
      };
    }
    worker.postMessage(msg);
  }
});

const [encoder, device, downloaded] = await Promise.all([
  kokoroEncoder(),
  kokoroDevice(),
  isKokoroDownloaded(),
]);
bridge.engine({ encoder, device, downloaded });
