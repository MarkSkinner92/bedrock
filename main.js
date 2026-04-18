'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');
const { execFile, spawn } = require('child_process');

// ─── Config & Validation ────────────────────────────────────────────────────

const REQUIRED_ENV = ['GITHUB_REPO_URL', 'REPO_FS_LOCATION', 'YAML_NAME', 'HOST', 'PORT'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[BEDROCK] FATAL: Missing required env var: ${key}`);
    process.exit(1);
  }
}

const CONFIG = {
  repoUrl:      process.env.GITHUB_REPO_URL,
  repoPath:     process.env.REPO_FS_LOCATION,
  yamlName:     process.env.YAML_NAME.trim(),
  host:         process.env.HOST,
  port:         parseInt(process.env.PORT, 10),
};

CONFIG.yamlPath = path.join(CONFIG.repoPath, CONFIG.yamlName);

console.log('[BEDROCK] Starting with config:', {
  repoUrl:  CONFIG.repoUrl,
  repoPath: CONFIG.repoPath,
  yamlPath: CONFIG.yamlPath,
  host:     CONFIG.host,
  port:     CONFIG.port,
});

// ─── Express + Socket.IO Setup ───────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Operation Lock (prevent concurrent destructive ops) ────────────────────

let busy = false;

function acquireLock(socket, opName) {
  if (busy) {
    emitStatus(socket, { status: 'error', reason: `Bedrock is busy with another operation. Please wait.` });
    return false;
  }
  busy = true;
  console.log(`[BEDROCK] Lock acquired for: ${opName}`);
  return true;
}

function releaseLock(opName) {
  busy = false;
  console.log(`[BEDROCK] Lock released after: ${opName}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emitStatus(socket, payload) {
  try {
    const target = socket || io;
    target.emit('status', payload);
    console.log('[BEDROCK] status emit:', JSON.stringify(payload).slice(0, 200));
  } catch (err) {
    console.error('[BEDROCK] Failed to emit status:', err.message);
  }
}

function emitTags(socket, tags) {
  try {
    socket.emit('tags', tags);
    console.log(`[BEDROCK] tags emitted (${tags.length})`);
  } catch (err) {
    console.error('[BEDROCK] Failed to emit tags:', err.message);
  }
}

// ─── Git Helpers ─────────────────────────────────────────────────────────────

/**
 * Clone the repo if it doesn't exist, otherwise open it.
 * Returns a simpleGit instance pointed at the repo.
 */
async function cloneRepoRoutine(socket) {
  const repoExists = fs.existsSync(path.join(CONFIG.repoPath, '.git'));

  if (!repoExists) {
    emitStatus(socket, { status: 'cloning', progress: `Cloning ${CONFIG.repoUrl} → ${CONFIG.repoPath}` });
    console.log('[BEDROCK] Cloning repo...');

    try {
      // Ensure parent directory exists
      fs.mkdirSync(CONFIG.repoPath, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to create repo directory "${CONFIG.repoPath}": ${err.message}`);
    }

    try {
      await simpleGit().clone(CONFIG.repoUrl, CONFIG.repoPath);
      emitStatus(socket, { status: 'cloning-complete', progress: 'Repo cloned successfully.' });
      console.log('[BEDROCK] Repo cloned.');
    } catch (err) {
      throw new Error(`Git clone failed: ${err.message}`);
    }
  } else {
    emitStatus(socket, { status: 'repo-exists', progress: 'Repo already present, fetching latest refs...' });
    console.log('[BEDROCK] Repo exists, fetching...');

    try {
      const git = simpleGit(CONFIG.repoPath);
      await git.fetch(['--tags', '--prune', '--prune-tags']);
      emitStatus(socket, { status: 'repo-exists', progress: 'Fetch complete.' });
      console.log('[BEDROCK] Fetch complete.');
    } catch (err) {
      throw new Error(`Git fetch failed: ${err.message}`);
    }
  }

  return simpleGit(CONFIG.repoPath);
}

/**
 * List all tags from the repo (remote + local), sorted newest-first if possible.
 */
async function fetchTags(git) {
  const tagResult = await git.tags(['--sort=-version:refname']);
  return tagResult.all || [];
}

/**
 * Checkout a specific tag in the repo.
 */
async function checkoutTag(git, tag, socket) {
  emitStatus(socket, { status: 'downloading', tag, progress: `Checking out tag: ${tag}` });
  try {
    await git.checkout(['--force', tag]);
    emitStatus(socket, { status: 'downloading', tag, progress: `Checked out tag: ${tag}` });
    console.log(`[BEDROCK] Checked out tag: ${tag}`);
  } catch (err) {
    throw new Error(`Git checkout of tag "${tag}" failed: ${err.message}`);
  }
}

// ─── Docker Helpers ──────────────────────────────────────────────────────────

/**
 * Run `docker compose -f <yaml> pull` and stream output line-by-line.
 * Resolves on success, rejects with the last stderr chunk on failure.
 */
function dockerComposePull(tag, socket) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CONFIG.yamlPath)) {
      return reject(new Error(`YAML file not found at "${CONFIG.yamlPath}". Check YAML_NAME in .env.`));
    }

    emitStatus(socket, { status: 'pulling-containers', tag, progress: 'Starting docker compose pull...' });
    console.log(`[BEDROCK] docker compose pull -f ${CONFIG.yamlPath}`);

    const proc = spawn('docker', ['compose', '-f', CONFIG.yamlPath, 'pull'], {
      cwd: CONFIG.repoPath,
      env: process.env,
    });

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        emitStatus(socket, { status: 'pulling-containers', tag, progress: line });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Docker pull writes progress to stderr — emit it as progress, not error
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        emitStatus(socket, { status: 'pulling-containers', tag, progress: line });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn docker compose pull: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `docker compose pull exited with code ${code}`));
      }
    });
  });
}

/**
 * Run `docker compose -f <yaml> up -d --remove-orphans` for a soft restart.
 */
function dockerComposeUp(socket) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CONFIG.yamlPath)) {
      return reject(new Error(`YAML file not found at "${CONFIG.yamlPath}". Check YAML_NAME in .env.`));
    }

    emitStatus(socket, { status: 'soft-restarting', progress: 'Running docker compose up -d --remove-orphans...' });
    console.log(`[BEDROCK] docker compose up -d --remove-orphans -f ${CONFIG.yamlPath}`);

    const proc = spawn('docker', ['compose', '-f', CONFIG.yamlPath, 'up', '-d', '--remove-orphans'], {
      cwd: CONFIG.repoPath,
      env: process.env,
    });

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        emitStatus(socket, { status: 'soft-restarting', progress: line });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        emitStatus(socket, { status: 'soft-restarting', progress: line });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn docker compose up: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `docker compose up exited with code ${code}`));
      }
    });
  });
}

// ─── Compound Routines ───────────────────────────────────────────────────────

async function routineListTags(socket) {
  if (!acquireLock(socket, 'list_tags')) return;
  try {
    const git  = await cloneRepoRoutine(socket);
    const tags = await fetchTags(git);
    emitTags(socket, tags);
  } catch (err) {
    console.error('[BEDROCK] list_tags error:', err);
    emitStatus(socket, { status: 'error', reason: err.message });
  } finally {
    releaseLock('list_tags');
  }
}

async function routineDownloadTag(tag, socket) {
  if (!tag || typeof tag !== 'string' || !tag.trim()) {
    emitStatus(socket, { status: 'download-failed', tag, reason: 'No tag specified.' });
    return;
  }
  tag = tag.trim();

  if (!acquireLock(socket, `download_tag:${tag}`)) return;
  try {
    const git = await cloneRepoRoutine(socket);

    // Validate tag exists
    const tags = await fetchTags(git);
    if (!tags.includes(tag)) {
      throw new Error(`Tag "${tag}" not found in repo. Available: ${tags.join(', ') || '(none)'}`);
    }

    await checkoutTag(git, tag, socket);
    emitStatus(socket, { status: 'downloading', tag, progress: 'Checkout complete. Starting image pull...' });

    await dockerComposePull(tag, socket);

    emitStatus(socket, { status: 'pulling-containers-complete', tag });
    emitStatus(socket, { status: 'download-complete', tag });
    console.log(`[BEDROCK] Download complete for tag: ${tag}`);
  } catch (err) {
    console.error(`[BEDROCK] download_tag error for "${tag}":`, err);

    // Determine whether failure was in pull or checkout phase
    if (err.message.includes('pull') || err.message.includes('docker') || err.message.includes('YAML')) {
      emitStatus(socket, { status: 'pulling-containers-failed', tag, reason: err.message });
    } else {
      emitStatus(socket, { status: 'download-failed', tag, reason: err.message });
    }
  } finally {
    releaseLock(`download_tag:${tag}`);
  }
}

async function routineSoftRestart(socket) {
  if (!acquireLock(socket, 'soft_restart')) return;
  try {
    emitStatus(socket, { status: 'soft-restarting' });
    await dockerComposeUp(socket);
    emitStatus(socket, { status: 'soft-restarting-complete' });
    console.log('[BEDROCK] Soft restart complete.');
  } catch (err) {
    console.error('[BEDROCK] soft_restart error:', err);
    emitStatus(socket, { status: 'error', reason: `Soft restart failed: ${err.message}` });
  } finally {
    releaseLock('soft_restart');
  }
}

async function routineDownloadTagAndSoftRestart(tag, socket) {
  if (!tag || typeof tag !== 'string' || !tag.trim()) {
    emitStatus(socket, { status: 'download-failed', tag, reason: 'No tag specified.' });
    return;
  }
  tag = tag.trim();

  if (!acquireLock(socket, `download_and_restart:${tag}`)) return;
  try {
    const git = await cloneRepoRoutine(socket);

    const tags = await fetchTags(git);
    if (!tags.includes(tag)) {
      throw new Error(`Tag "${tag}" not found in repo. Available: ${tags.join(', ') || '(none)'}`);
    }

    await checkoutTag(git, tag, socket);
    emitStatus(socket, { status: 'downloading', tag, progress: 'Checkout complete. Starting image pull...' });

    await dockerComposePull(tag, socket);

    emitStatus(socket, { status: 'pulling-containers-complete', tag });
    emitStatus(socket, { status: 'download-complete', tag });

    emitStatus(socket, { status: 'soft-restarting' });
    await dockerComposeUp(socket);
    emitStatus(socket, { status: 'soft-restarting-complete' });

    console.log(`[BEDROCK] Download + soft restart complete for tag: ${tag}`);
  } catch (err) {
    console.error(`[BEDROCK] download_tag_and_soft_restart error for "${tag}":`, err);

    if (err.message.includes('compose up') || (err.message.includes('docker') && err.message.includes('up'))) {
      emitStatus(socket, { status: 'error', reason: `Soft restart failed after download: ${err.message}` });
    } else if (err.message.includes('pull') || err.message.includes('YAML')) {
      emitStatus(socket, { status: 'pulling-containers-failed', tag, reason: err.message });
    } else {
      emitStatus(socket, { status: 'download-failed', tag, reason: err.message });
    }
  } finally {
    releaseLock(`download_and_restart:${tag}`);
  }
}

// ─── Socket.IO Events ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  const addr = socket.handshake.address;
  console.log(`[BEDROCK] Client connected: ${socket.id} from ${addr}`);

  socket.on('disconnect', (reason) => {
    console.log(`[BEDROCK] Client disconnected: ${socket.id} — reason: ${reason}`);
  });

  socket.on('error', (err) => {
    console.error(`[BEDROCK] Socket error from ${socket.id}:`, err);
  });

  // ── list_tags ──────────────────────────────────────────────────────────────
  socket.on('list_tags', () => {
    console.log(`[BEDROCK] [${socket.id}] list_tags`);
    routineListTags(socket).catch((err) => {
      console.error('[BEDROCK] Unhandled error in list_tags:', err);
      emitStatus(socket, { status: 'error', reason: `Unexpected error: ${err.message}` });
    });
  });

  // ── download_tag <tag> ────────────────────────────────────────────────────
  socket.on('download_tag', (tag) => {
    console.log(`[BEDROCK] [${socket.id}] download_tag:`, tag);
    routineDownloadTag(tag, socket).catch((err) => {
      console.error('[BEDROCK] Unhandled error in download_tag:', err);
      emitStatus(socket, { status: 'download-failed', tag, reason: `Unexpected error: ${err.message}` });
    });
  });

  // ── soft_restart ───────────────────────────────────────────────────────────
  socket.on('soft_restart', () => {
    console.log(`[BEDROCK] [${socket.id}] soft_restart`);
    routineSoftRestart(socket).catch((err) => {
      console.error('[BEDROCK] Unhandled error in soft_restart:', err);
      emitStatus(socket, { status: 'error', reason: `Unexpected error: ${err.message}` });
    });
  });

  // ── download_tag_and_soft_restart <tag> ───────────────────────────────────
  socket.on('download_tag_and_soft_restart', (tag) => {
    console.log(`[BEDROCK] [${socket.id}] download_tag_and_soft_restart:`, tag);
    routineDownloadTagAndSoftRestart(tag, socket).catch((err) => {
      console.error('[BEDROCK] Unhandled error in download_tag_and_soft_restart:', err);
      emitStatus(socket, { status: 'error', reason: `Unexpected error: ${err.message}` });
    });
  });
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