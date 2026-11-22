import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { aivenBridge } from './server/adapters/aiven.ts';
import { createStoreStreamApp } from './server/app.ts';
import { searchIndex } from './server/search-engine.ts';

dotenv.config();

export { createStoreStreamApp };

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  await aivenBridge.initialize();

  let wssRef: WebSocketServer | null = null;
  function broadcastEvent(event: string, payload: unknown) {
    if (!wssRef) return;
    const frame = JSON.stringify({ event, payload });
    for (const client of wssRef.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(frame);
      }
    }
  }

  const app = createStoreStreamApp(broadcastEvent);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wssRef = wss;

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        event: 'session:connected',
        payload: {
          connectedClients: wss.clients.size,
          indexedDocuments: searchIndex.getDocumentCount(),
        },
      })
    );
    broadcastEvent('presence:clients', { connectedClients: wss.clients.size });
    ws.on('close', () => {
      broadcastEvent('presence:clients', { connectedClients: wss.clients.size });
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`StoreStream server running on http://0.0.0.0:${PORT}`);
  });
}

if (process.env.VITEST !== 'true') {
  startServer().catch((err) => {
    console.error('Failed to start StoreStream server:', err);
    process.exit(1);
  });
}
