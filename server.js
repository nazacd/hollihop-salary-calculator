import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HolliHop } from './src/hollihop.js';
import { buildMonth, teacherHistory } from './src/month.js';
import { SettingsStore } from './src/settings.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const api = new HolliHop({ baseUrl: process.env.BASE_URL, authKey: process.env.AUTHKEY });
const settings = new SettingsStore(path.join(ROOT, 'data', 'settings.json'), {
  teacherId: process.env.TEACHER_ID ? Number(process.env.TEACHER_ID) : null,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return pass === APP_PASSWORD;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) return send(res, 404, 'Not found');
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

const routes = {
  'GET /api/config': async () => {
    const s = await settings.get();
    return { teacherId: s.teacherId ?? null };
  },

  'GET /api/teachers': async (url) => {
    const fresh = url.searchParams.has('fresh');
    const list = await api.teachers({ fresh });
    return list.map((t) => ({
      id: t.Id,
      name: [t.LastName, t.FirstName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
      status: t.Status,
      fired: !!t.Fired,
      disciplines: t.Disciplines ?? [],
      offices: (t.Offices ?? []).map((o) => o.Name),
    }));
  },

  'GET /api/settings': () => settings.get(),

  'PUT /api/settings': async (url, req) => settings.replace(await readJson(req)),

  'GET /api/history': async (url) => {
    const teacherId = Number(url.searchParams.get('teacherId') || (await settings.get()).teacherId);
    if (!teacherId) throw Object.assign(new Error('teacherId is not configured'), { status: 400 });
    return teacherHistory(api, { teacherId, fresh: url.searchParams.has('fresh') });
  },

  'GET /api/month': async (url) => {
    const year = Number(url.searchParams.get('year'));
    const month = Number(url.searchParams.get('month'));
    const teacherId = Number(url.searchParams.get('teacherId') || (await settings.get()).teacherId);
    if (!year || !(month >= 1 && month <= 12)) throw Object.assign(new Error('year and month are required'), { status: 400 });
    if (!teacherId) throw Object.assign(new Error('teacherId is not configured'), { status: 400 });
    return buildMonth(api, { teacherId, year, month, fresh: url.searchParams.has('fresh') });
  },
};

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    return send(res, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="Salary"' });
  }
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      send(res, 200, await handler(url, req));
    } catch (err) {
      console.error(err);
      send(res, err.status || 502, { error: err.message });
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Salary calculator running at http://localhost:${PORT}`);
});
