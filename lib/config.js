'use strict';

require('dotenv').config();

const path = require('path');

const REQUIRED_ENV = ['GITHUB_REPO_URL', 'REPO_FS_LOCATION', 'YAML_NAME', 'HOST', 'PORT'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[BEDROCK] FATAL: Missing required env var: ${key}`);
    process.exit(1);
  }
}

const CONFIG = {
  repoUrl:  process.env.GITHUB_REPO_URL,
  repoPath: process.env.REPO_FS_LOCATION,
  yamlName: process.env.YAML_NAME.trim(),
  host:     process.env.HOST,
  port:     parseInt(process.env.PORT, 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
};

CONFIG.yamlPath = path.join(CONFIG.repoPath, CONFIG.yamlName);

console.log('[BEDROCK] Starting with config:', {
  repoUrl:  CONFIG.repoUrl,
  repoPath: CONFIG.repoPath,
  yamlPath: CONFIG.yamlPath,
  host:     CONFIG.host,
  port:     CONFIG.port,
});

module.exports = CONFIG;
