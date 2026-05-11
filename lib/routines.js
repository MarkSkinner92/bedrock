'use strict';

const { acquireLock, releaseLock } = require('./lock');
const { cloneRepoRoutine, fetchTags, checkoutTag, getCurrentTag } = require('./git');
const { dockerComposePull, dockerComposeUp } = require('./docker');

async function routineListTags(emitter) {
  if (!acquireLock(emitter, 'list_tags')) return;
  try {
    const git  = await cloneRepoRoutine(emitter);
    const tags = await fetchTags(git);
    emitter.emit('tags', tags);
  } catch (err) {
    console.error('[BEDROCK] list_tags error:', err);
    emitter.emit('status', { status: 'error', reason: err.message });
  } finally {
    releaseLock('list_tags');
  }
}

async function routineDownloadTag(tag, emitter) {
  if (!tag || typeof tag !== 'string' || !tag.trim()) {
    emitter.emit('status', { status: 'download-failed', tag, reason: 'No tag specified.' });
    return;
  }
  tag = tag.trim();

  if (!acquireLock(emitter, `download_tag:${tag}`)) return;
  try {
    const git  = await cloneRepoRoutine(emitter);
    const tags = await fetchTags(git);
    if (!tags.includes(tag)) {
      throw new Error(`Tag "${tag}" not found in repo. Available: ${tags.join(', ') || '(none)'}`);
    }

    await checkoutTag(git, tag, emitter);
    emitter.emit('status', { status: 'downloading', tag, progress: 'Checkout complete. Starting image pull...' });

    await dockerComposePull(tag, emitter);

    emitter.emit('status', { status: 'pulling-containers-complete', tag });
    emitter.emit('status', { status: 'download-complete', tag });
    console.log(`[BEDROCK] Download complete for tag: ${tag}`);
  } catch (err) {
    console.error(`[BEDROCK] download_tag error for "${tag}":`, err);

    if (err.message.includes('pull') || err.message.includes('docker') || err.message.includes('YAML')) {
      emitter.emit('status', { status: 'pulling-containers-failed', tag, reason: err.message });
    } else {
      emitter.emit('status', { status: 'download-failed', tag, reason: err.message });
    }
  } finally {
    releaseLock(`download_tag:${tag}`);
  }
}

async function routineSoftRestart(emitter) {
  if (!acquireLock(emitter, 'soft_restart')) return;
  try {
    emitter.emit('status', { status: 'soft-restarting' });
    await dockerComposeUp(emitter);
    emitter.emit('status', { status: 'soft-restarting-complete' });
    console.log('[BEDROCK] Soft restart complete.');
  } catch (err) {
    console.error('[BEDROCK] soft_restart error:', err);
    emitter.emit('status', { status: 'error', reason: `Soft restart failed: ${err.message}` });
  } finally {
    releaseLock('soft_restart');
  }
}

async function routineDownloadTagAndSoftRestart(tag, emitter) {
  if (!tag || typeof tag !== 'string' || !tag.trim()) {
    emitter.emit('status', { status: 'download-failed', tag, reason: 'No tag specified.' });
    return;
  }
  tag = tag.trim();

  if (!acquireLock(emitter, `download_and_restart:${tag}`)) return;
  try {
    const git  = await cloneRepoRoutine(emitter);
    const tags = await fetchTags(git);
    if (!tags.includes(tag)) {
      throw new Error(`Tag "${tag}" not found in repo. Available: ${tags.join(', ') || '(none)'}`);
    }

    await checkoutTag(git, tag, emitter);
    emitter.emit('status', { status: 'downloading', tag, progress: 'Checkout complete. Starting image pull...' });

    await dockerComposePull(tag, emitter);

    emitter.emit('status', { status: 'pulling-containers-complete', tag });
    emitter.emit('status', { status: 'download-complete', tag });

    emitter.emit('status', { status: 'soft-restarting' });
    await dockerComposeUp(emitter);
    emitter.emit('status', { status: 'soft-restarting-complete' });

    console.log(`[BEDROCK] Download + soft restart complete for tag: ${tag}`);
  } catch (err) {
    console.error(`[BEDROCK] download_tag_and_soft_restart error for "${tag}":`, err);

    if (err.message.includes('compose up') || (err.message.includes('docker') && err.message.includes('up'))) {
      emitter.emit('status', { status: 'error', reason: `Soft restart failed after download: ${err.message}` });
    } else if (err.message.includes('pull') || err.message.includes('YAML')) {
      emitter.emit('status', { status: 'pulling-containers-failed', tag, reason: err.message });
    } else {
      emitter.emit('status', { status: 'download-failed', tag, reason: err.message });
    }
  } finally {
    releaseLock(`download_and_restart:${tag}`);
  }
}

async function routineGetVersion(emitter) {
  try {
    const tag = await getCurrentTag();
    emitter.emit('version', { tag });
    console.log(`[BEDROCK] get_version: ${tag ?? '(none)'}`);
  } catch (err) {
    console.error('[BEDROCK] get_version error:', err);
    emitter.emit('status', { status: 'error', reason: err.message });
  }
}

/**
 * Routes an event name + optional payload to the correct routine.
 * Handles the .catch() so callers don't need to repeat the error pattern.
 */
function dispatch(event, payload, emitter) {
  let promise;

  switch (event) {
    case 'list_tags':
      promise = routineListTags(emitter);
      break;
    case 'download_tag':
      promise = routineDownloadTag(payload, emitter);
      break;
    case 'soft_restart':
      promise = routineSoftRestart(emitter);
      break;
    case 'download_tag_and_soft_restart':
      promise = routineDownloadTagAndSoftRestart(payload, emitter);
      break;
    case 'get_version':
      promise = routineGetVersion(emitter);
      break;
    default:
      console.warn(`[BEDROCK] dispatch: unknown event "${event}"`);
      return;
  }

  promise.catch((err) => {
    console.error(`[BEDROCK] Unhandled error in ${event}:`, err);
    emitter.emit('status', { status: 'error', reason: `Unexpected error: ${err.message}` });
  });
}

module.exports = {
  routineListTags,
  routineDownloadTag,
  routineSoftRestart,
  routineDownloadTagAndSoftRestart,
  dispatch,
};
