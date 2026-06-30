'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const CONFIG = require('./lib/config');
const { createEmitter } = require('./lib/emitter');
const { startCommandSubscriber } = require('./lib/subscriber');
const { dispatch } = require('./lib/routines');
const { dockerComposeDown } = require('./lib/docker');

// ─── Express + Socket.IO Setup ───────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/in-progress', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'in-progress.html'));
});

// Synchronous stop — blocks until docker compose down completes, then responds.
// Used by sim.sh so it can wait before bringing up a different stack.
app.post('/api/stop', async (_req, res) => {
  console.log('[BEDROCK] POST /api/stop received');
  try {
    await dockerComposeDown(createEmitter(io));
    res.json({ ok: true });
  } catch (err) {
    console.error('[BEDROCK] POST /api/stop failed:', err.message);
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// ─── Redis Command Subscriber ────────────────────────────────────────────────

startCommandSubscriber(io).catch((err) => {
  console.error('[BEDROCK] Failed to start Redis command subscriber:', err.message);
});

// ─── Socket.IO Events ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  const addr = socket.handshake.address;
  console.log(`[BEDROCK] Client connected: ${socket.id} from ${addr}`);

  socket.on('disconnect', (reason) => {
    console.log(`[BEDROCK] Client disconnected: ${socket.id} — reason: ${reason}`);
  });

  socket.on('error', (err) => {
    console.error(`[BEDROCK] Socket error from ${socket.id}:`, err);
  });

  for (const event of ['list_tags', 'download_tag', 'soft_restart', 'download_tag_and_soft_restart', 'stop', 'get_version']) {
    socket.on(event, (payload) => {
      console.log(`[BEDROCK] [${socket.id}] ${event}`, payload ?? '');
      dispatch(event, payload, createEmitter(io));
    });
  }
});

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[BEDROCK] Listening on http://${CONFIG.host}:${CONFIG.port}`);
});

server.on('error', (err) => {
  console.error('[BEDROCK] HTTP server error:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`[BEDROCK] Port ${CONFIG.port} is already in use.`);
    process.exit(1);
  }
});

// ─── Global Error Handlers ───────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[BEDROCK] UNCAUGHT EXCEPTION:', err);
  // Do NOT exit — Bedrock is never meant to stop
});

process.on('unhandledRejection', (reason) => {
  console.error('[BEDROCK] UNHANDLED REJECTION:', reason);
});
