'use strict';

const { publish } = require('./redis');

/**
 * Returns an object with an emit(event, data) method that mirrors the socket.io API.
 * Each call forwards to the given socket.io target AND publishes to Redis channel bedrock:<event>.
 */
function createEmitter(socketTarget) {
  return {
    emit(event, data) {
      try {
        socketTarget.emit(event, data);
        console.log('[BEDROCK] emit:', event, JSON.stringify(data).slice(0, 200));
      } catch (err) {
        console.error('[BEDROCK] Failed to emit to socket:', err.message);
      }
      publish(`bedrock:${event}`, data);
    },
  };
}

module.exports = { createEmitter };
