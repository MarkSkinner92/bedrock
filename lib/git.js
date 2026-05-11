'use strict';

const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const CONFIG = require('./config');

async function cloneRepoRoutine(emitter) {
  const repoExists = fs.existsSync(path.join(CONFIG.repoPath, '.git'));

  if (!repoExists) {
    emitter.emit('status', { status: 'cloning', progress: `Cloning ${CONFIG.repoUrl} → ${CONFIG.repoPath}` });
    console.log('[BEDROCK] Cloning repo...');

    try {
      fs.mkdirSync(CONFIG.repoPath, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to create repo directory "${CONFIG.repoPath}": ${err.message}`);
    }

    try {
      await simpleGit().clone(CONFIG.repoUrl, CONFIG.repoPath);
      emitter.emit('status', { status: 'cloning-complete', progress: 'Repo cloned successfully.' });
      console.log('[BEDROCK] Repo cloned.');
    } catch (err) {
      throw new Error(`Git clone failed: ${err.message}`);
    }
  } else {
    emitter.emit('status', { status: 'repo-exists', progress: 'Repo already present, fetching latest refs...' });
    console.log('[BEDROCK] Repo exists, fetching...');

    try {
      const git = simpleGit(CONFIG.repoPath);
      await git.fetch(['--tags', '--prune', '--prune-tags']);
      emitter.emit('status', { status: 'repo-exists', progress: 'Fetch complete.' });
      console.log('[BEDROCK] Fetch complete.');
    } catch (err) {
      throw new Error(`Git fetch failed: ${err.message}`);
    }
  }

  return simpleGit(CONFIG.repoPath);
}

async function fetchTags(git) {
  const tagResult = await git.tags(['--sort=-version:refname']);
  return (tagResult.all || []).slice(0, 4);
}

async function checkoutTag(git, tag, emitter) {
  emitter.emit('status', { status: 'downloading', tag, progress: `Checking out tag: ${tag}` });
  try {
    await git.checkout(['--force', tag]);
    emitter.emit('status', { status: 'downloading', tag, progress: `Checked out tag: ${tag}` });
    console.log(`[BEDROCK] Checked out tag: ${tag}`);
  } catch (err) {
    throw new Error(`Git checkout of tag "${tag}" failed: ${err.message}`);
  }
}

/**
 * Returns the exact tag at HEAD in the production repo, or null if HEAD isn't
 * on a tag or the repo hasn't been cloned yet.
 */
async function getCurrentTag() {
  if (!fs.existsSync(path.join(CONFIG.repoPath, '.git'))) return null;
  try {
    const result = await simpleGit(CONFIG.repoPath).raw(['describe', '--tags', '--exact-match']);
    return result.trim() || null;
  } catch {
    return null;
  }
}

module.exports = { cloneRepoRoutine, fetchTags, checkoutTag, getCurrentTag };
