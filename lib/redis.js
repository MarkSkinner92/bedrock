'use strict';

const { createClient } = require('redis');
const CONFIG = require('./config');

const client = createClient({ url: CONFIG.redisUrl });

client.on('error', (err) => console.error('[BEDROCK] Redis error:', err.message));
client.on('ready', () => console.log(`[BEDROCK] Redis connected: ${CONFIG.redisUrl}`));

// Connect once at startup; failures are non-fatal — publish calls will be no-ops if disconnected.
client.connect().catch((err) => {
  console.error('[BEDROCK] Redis initial connect failed:', err.message);
});

function publish(channel, data) {
  if (!client.isReady) return;
  client.publish(channel, JSON.stringify(data)).catch((err) => {
    console.error(`[BEDROCK] Redis publish to ${channel} failed:`, err.message);
  });
}

module.exports = { client, publish };
