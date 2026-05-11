'use strict';

const { createClient } = require('redis');
const CONFIG = require('./config');
const { createEmitter } = require('./emitter');
const { dispatch } = require('./routines');

const COMMAND_CHANNELS = [
  'bedrock:list_tags',
  'bedrock:download_tag',
  'bedrock:soft_restart',
  'bedrock:download_tag_and_soft_restart',
  'bedrock:get_version',
];

/**
 * Starts a dedicated Redis subscriber that mirrors the socket.io command API.
 * Incoming messages on bedrock:<cmd> channels run the same routines as socket events.
 * Results are broadcast to all socket.io clients via io.emit().
 */
async function startCommandSubscriber(io) {
  const sub = createClient({ url: CONFIG.redisUrl });

  sub.on('error', (err) => console.error('[BEDROCK] Redis subscriber error:', err.message));
  sub.on('ready', () => console.log(`[BEDROCK] Redis subscriber ready: ${CONFIG.redisUrl}`));

  try {
    await sub.connect();
  } catch (err) {
    console.error('[BEDROCK] Redis subscriber connect failed:', err.message);
    return;
  }

  await sub.subscribe(COMMAND_CHANNELS, (message, channel) => {
    let payload;
    try { payload = JSON.parse(message); } catch { payload = message; }

    const event = channel.slice('bedrock:'.length);
    console.log(`[BEDROCK] Redis command: ${event}`, payload ?? '');
    dispatch(event, payload, createEmitter(io));
  });

  console.log(`[BEDROCK] Redis subscribed to: ${COMMAND_CHANNELS.join(', ')}`);
}

module.exports = { startCommandSubscriber };
