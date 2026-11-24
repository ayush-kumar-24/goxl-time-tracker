// Local test gateway. Stands in for the Supabase API gateway and for Vercel:
//   /auth/v1/*     -> GoTrue      (real Supabase auth server)
//   /rest/v1/*     -> PostgREST   (real Supabase data API)
//   /storage/v1/*  -> storage-api (real Supabase storage server, optional)
//   /team, /team/* -> the static front-end from this repository
//   /team/config.js is generated so the front-end points at this gateway.
// For local testing only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = +(process.env.GATEWAY_PORT || 8000);
const UP = { '/auth/v1': +(process.env.GOTRUE_PORT || 9999), '/rest/v1': +(process.env.POSTGREST_PORT || 3001), '/storage/v1': +(process.env.STORAGE_PORT || 5000) };
const ANON = process.env.ANON_KEY || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const prefix = Object.keys(UP).find(p => url.pathname === p || url.pathname.startsWith(p + '/'));
  if (prefix) {
    const headers = { ...req.headers, host: '127.0.0.1:' + UP[prefix] };
    const up = http.request({ host: '127.0.0.1', port: UP[prefix], method: req.method, path: (url.pathname.slice(prefix.length) || '/') + url.search, headers }, r => {
      res.writeHead(r.statusCode, { ...r.headers, ...CORS }); r.pipe(res);
    });
    up.on('error', e => { res.writeHead(502, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify({ message: 'Local service is not running: ' + prefix + ' (' + e.code + ')' })); });
    return req.pipe(up);
  }
  if (url.pathname === '/team/config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    return res.end(`window.GOXL_CONFIG = ${JSON.stringify({ supabaseUrl: 'http://127.0.0.1:' + PORT, supabaseKey: ANON, realtime: false })};\n`);
  }
  let rel = url.pathname === '/team' || url.pathname === '/team/' ? '/team/index.html' : url.pathname;
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(path.join(ROOT, 'team') + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('gateway on http://127.0.0.1:' + PORT + '/team'));
