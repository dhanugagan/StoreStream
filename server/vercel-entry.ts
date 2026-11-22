import type { IncomingMessage, ServerResponse } from 'node:http';
import { aivenBridge } from './adapters/aiven.ts';
import { createStoreStreamApp } from './app.ts';

let readyPromise: Promise<ReturnType<typeof createStoreStreamApp>> | null = null;

function getApp() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await aivenBridge.initialize();
      return createStoreStreamApp();
    })();
  }
  return readyPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
