'use strict';

let busy = false;

function acquireLock(emitter, opName) {
  if (busy) {
    emitter.emit('status', { status: 'error', reason: 'Bedrock is busy with another operation. Please wait.' });
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

module.exports = { acquireLock, releaseLock };
