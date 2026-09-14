'use strict';

const fs = require('fs');
const path = require('path');
const { text } = require('./http-utils');

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[ext] || 'application/octet-stream';
}

function safeFilePath(appDistDir, routePath) {
  const relativePath = routePath.replace(/^\/+/, '');
  const requestedPath = path.normalize(path.join(appDistDir, relativePath));
  const appRoot = path.normalize(appDistDir);
  const insideRoot = requestedPath === appRoot || requestedPath.startsWith(`${appRoot}${path.sep}`);
  return insideRoot ? requestedPath : null;
}

function serveReactApp(req, res, { appDistDir }) {
  const routePath = req.url.split('?')[0] || '/';
  const indexPath = path.join(appDistDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    text(res, 503, 'Dashboard web build not found. Run `npm.cmd run build:web` from TinyAgentOffice.');
    return true;
  }

  const hasExtension = Boolean(path.extname(routePath));
  const requestedPath = routePath === '/'
    ? indexPath
    : safeFilePath(appDistDir, routePath);

  let filePath = null;
  if (requestedPath && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
    filePath = requestedPath;
  } else if (!hasExtension) {
    filePath = indexPath;
  } else {
    text(res, 404, 'Not found');
    return true;
  }

  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return true;
}

module.exports = {
  serveReactApp,
};
