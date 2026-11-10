'use strict';

const {timingSafeEqual} = require('node:crypto');
const {renameSync, rmSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {startServer} = require('../server/index.js');

function writeStatus(file, status) {
  const temporary = file + '.tmp';
  writeFileSync(temporary, JSON.stringify(status), {mode: 0o600});
  renameSync(temporary, file);
}

async function startOffline({dataDir, readyFile, token}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('无效的应用访问令牌');
  const secret = Buffer.from(token);
  const app = await startServer({port: 0, host: '127.0.0.1', dataDir});
  const {server} = app;
  const host = new URL(app.url).host;
  const handler = server.listeners('request')[0];
  server.removeListener('request', handler);
  server.on('request', (request, response) => {
    const match = /(?:^|;\s*)orbital_device=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '');
    if (request.headers.host !== host || !match || !timingSafeEqual(Buffer.from(match[1]), secret)) {
      response.writeHead(403, {'Cache-Control': 'no-store'});
      response.end();
      return;
    }
    handler.call(server, request, response);
  });
  try {
    writeStatus(readyFile, {url: app.url});
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

if (require.main === module) {
  const [, , dataDir, readyFile, token] = process.argv;
  Promise.resolve().then(() => {
    // Android starts one runtime per app process and keeps the directory private.
    // A force-stop can leave the desktop process marker behind.
    rmSync(join(dataDir, 'server.lock'), {force: true});
    return startOffline({dataDir, readyFile, token});
  }).then(app => {
    app.worker.once('exit', () => {
      try {
        writeStatus(readyFile, {error: '模拟服务已停止，请重新打开 ORBITAL。'});
      } finally {
        app.close();
      }
    });
  }).catch(error => {
    console.error(error);
    writeStatus(readyFile, {error: '无法启动离线存档：' + error.message});
    process.exitCode = 1;
  });
}

module.exports = {startOffline};
