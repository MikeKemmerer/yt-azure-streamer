#!/usr/bin/env node

/**
 * Minimal backend API for yt-azure-streamer
 * - Reads namePrefix from /etc/nameprefix
 * - Exposes simple endpoints for UI
 * - Serves as a placeholder for future expansion
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const config = require('./config.json');

function readPrefix() {
  try {
    return fs.readFileSync(config.prefixFile, 'utf8').trim();
  } catch {
    return "unknown";
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/info') {
    const prefix = readPrefix();
    const storage = config.storageAccountTemplate.replace("STORAGE_ACCOUNT", prefix.toLowerCase());
    const automation = config.automationAccountTemplate.replace("AUTOMATION_ACCOUNT", prefix + "-automation");

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      prefix,
      storageAccount: storage,
      automationAccount: automation
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});
