'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const CONFIG = require('./config');

function dockerComposePull(tag, emitter) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CONFIG.yamlPath)) {
      return reject(new Error(`YAML file not found at "${CONFIG.yamlPath}". Check YAML_NAME in .env.`));
    }

    emitter.emit('status', { status: 'pulling-containers', tag, progress: 'Starting docker compose pull...' });
    console.log(`[BEDROCK] docker compose pull -f ${CONFIG.yamlPath}`);

    const proc = spawn('docker', ['compose', '-f', CONFIG.yamlPath, 'pull'], {
      cwd: CONFIG.repoPath,
      env: process.env,
    });

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
        emitter.emit('status', { status: 'pulling-containers', tag, progress: line });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // Docker pull writes progress to stderr — emit as progress, not error
      for (const line of text.split('\n').filter(l => l.trim())) {
        emitter.emit('status', { status: 'pulling-containers', tag, progress: line });
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to spawn docker compose pull: ${err.message}`)));

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `docker compose pull exited with code ${code}`));
    });
  });
}

/**
 * If DEV_YAML_PATH is set and the file exists, check whether any containers
 * from that project exist (any state — stopped containers still hold their name).
 * If they do, bring the dev stack fully down before production comes up.
 */
function devComposeDown(emitter) {
  const devYaml = process.env.DEV_YAML_PATH;
  if (!devYaml || !fs.existsSync(devYaml)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    // ps -q lists container IDs for the project regardless of state
    const check = spawn('docker', ['compose', '-f', devYaml, 'ps', '-q'], { env: process.env });

    let ids = '';
    check.stdout.on('data', (chunk) => { ids += chunk.toString(); });

    check.on('error', (err) => {
      console.warn('[BEDROCK] devComposeDown: could not check dev containers:', err.message);
      resolve(); // non-fatal — proceed anyway
    });

    check.on('close', () => {
      if (!ids.trim()) {
        console.log('[BEDROCK] devComposeDown: no dev containers found, skipping.');
        return resolve();
      }

      console.log('[BEDROCK] devComposeDown: dev containers present — bringing down dev stack.');
      emitter.emit('status', { status: 'soft-restarting', progress: 'Stopping dev stack before starting production...' });

      const down = spawn('docker', ['compose', '-f', devYaml, 'down'], { env: process.env });
      let stderr = '';

      down.stdout.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
          emitter.emit('status', { status: 'soft-restarting', progress: line });
        }
      });

      down.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        for (const line of text.split('\n').filter(l => l.trim())) {
          emitter.emit('status', { status: 'soft-restarting', progress: line });
        }
      });

      down.on('error', (err) => reject(new Error(`Failed to spawn docker compose down (dev): ${err.message}`)));

      down.on('close', (code) => {
        if (code === 0) {
          console.log('[BEDROCK] devComposeDown: dev stack is down.');
          resolve();
        } else {
          reject(new Error(stderr.trim() || `docker compose down (dev) exited with code ${code}`));
        }
      });
    });
  });
}

async function dockerComposeUp(emitter) {
  if (!fs.existsSync(CONFIG.yamlPath)) {
    throw new Error(`YAML file not found at "${CONFIG.yamlPath}". Check YAML_NAME in .env.`);
  }

  await devComposeDown(emitter);

  emitter.emit('status', { status: 'soft-restarting', progress: 'Running docker compose up -d --remove-orphans...' });
  console.log(`[BEDROCK] docker compose up -d --remove-orphans -f ${CONFIG.yamlPath}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['compose', '-f', CONFIG.yamlPath, 'up', '-d', '--remove-orphans'], {
      cwd: CONFIG.repoPath,
      env: process.env,
    });

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(l => l.trim())) {
        emitter.emit('status', { status: 'soft-restarting', progress: line });
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split('\n').filter(l => l.trim())) {
        emitter.emit('status', { status: 'soft-restarting', progress: line });
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to spawn docker compose up: ${err.message}`)));

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `docker compose up exited with code ${code}`));
    });
  });
}

module.exports = { dockerComposePull, dockerComposeUp };
