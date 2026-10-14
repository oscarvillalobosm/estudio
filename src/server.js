'use strict';
// Servidor de hojas de calculo: login por cookie firmada + guardado por usuario.
// Sin dependencias externas.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { Auth } = require('./auth');
const { Store, MAX_BYTES } = require('./store');
const { APPS, BY_ID, isApp } = require('./apps');
const { SHIM } = require('./shim');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const APPS_DIR = path.join(__dirname, '..', 'public', 'apps');
const APP_TITLE = process.env.APP_TITLE || 'Estudio';

fs.mkdirSync(DATA_DIR, { recursive: true });

const auth = new Auth(DATA_DIR);
const store = new Store(DATA_DIR);

// ---- CLI: node src/server.js adduser <usuario> <contrasena> -----------------
if (process.argv[2] === 'adduser') {
  const [, , , username, password] = process.argv;
  try {
    console.log('Usuario creado:', auth.create(username, password));
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

auth.bootstrap();

// ---- Sirviendo el WASM con la marca retirada -------------------------------
// El release oficial trae el nombre en el <title> y un favicon con la marca.
// Se reescribe una vez al arrancar para poder cambiar APP_TITLE sin recompilar.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---- Cada app se sirve con la marca retirada y el shim inyectado --------------
// El index.html de las apps trae su propio <title> y un favicon con la marca del
// proyecto original. Se reescriben una vez al arrancar, y se cachea por app.
const indexCache = new Map();

function appIndex(appId) {
  if (indexCache.has(appId)) return indexCache.get(appId);

  const file = path.join(APPS_DIR, appId, 'index.html');
  if (!fs.existsSync(file)) return null;

  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${APP_TITLE}</title>`);
  html = html.replace(/<link[^>]*rel=["']icon["'][^>]*>/gi, '');
  // El shim necesita saber que app es para poder etiquetar lo que llega.
  const tag = `<script>document.currentScript.dataset.app=${JSON.stringify(appId)}</script>`;
  html = html.replace('</head>', tag + SHIM + '\n</head>');

  indexCache.set(appId, html);
  return html;
}

// Aviso de que apps faltan en disco, sin tumbar el servidor.
const missing = APPS.filter((a) => !fs.existsSync(path.join(APPS_DIR, a.id, 'index.html')));
if (missing.length) {
  console.warn(`[apps] Sin build web: ${missing.map((a) => a.id).join(', ')}`);
}

// ---- Utilidades -------------------------------------------------------------
function send(res, code, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, ...extra });
  res.end(buf);
}

const json = (res, code, obj) =>
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  return auth.verifyToken(cookies(req).session);
}

function readBody(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req) {
  return readBody(req, 64 * 1024).then((b) => {
    if (!b.length) return {};
    try {
      return JSON.parse(b.toString('utf8'));
    } catch {
      throw Object.assign(new Error('JSON invalido'), { status: 400 });
    }
  });
}

// El WASM son ~178 MB sin comprimir; con gzip quedan en ~69 MB. Los propios
// proyectos upstream recomiendan comprimirlo al servirlo.
//
// Comprimir 62 MB en cada peticion es caro, y como el .wasm va con
// `immutable` todos los clientes lo piden una sola vez pero el servidor lo
// recomprimiria una vez por usuario. Se cachea el resultado en memoria.
const COMPRESSIBLE = new Set(['.wasm', '.js', '.css', '.html', '.json', '.svg']);
const gzCache = new Map();

function gzipFor(file, body, accept) {
  if (!COMPRESSIBLE.has(path.extname(file).toLowerCase())) return null;
  if (!/\bgzip\b/.test(accept) || body.length <= 1024) return null;

  if (gzCache.has(file)) return gzCache.get(file);
  const gz = zlib.gzipSync(body, { level: 6 });
  // Techo de 256 MB: si se supera, se deja de cachear en vez de crecer sin fin.
  let total = 0;
  for (const v of gzCache.values()) total += v.length;
  if (total + gz.length < 256 * 1024 * 1024) gzCache.set(file, gz);
  return gz;
}

function sendFile(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  const headers =
    ext === '.wasm' || ext === '.js'
      ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
      : { 'Cache-Control': 'no-store' };

  const raw = fs.readFileSync(file);
  const gz = gzipFor(file, raw, String(req.headers['accept-encoding'] || ''));
  if (gz) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  send(res, 200, MIME[ext] || 'application/octet-stream', gz || raw, headers);
}

// ---- Rutas ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const user = currentUser(req);

  try {
    // --- API ---
    if (p === '/api/login' && req.method === 'POST') {
      const { username, password } = await readJson(req);
      if (!auth.verify(username, password)) {
        // Mismo mensaje para usuario inexistente y clave incorrecta.
        return json(res, 401, { error: 'Usuario o contrasena incorrectos' });
      }
      const token = auth.issueToken(String(username).toLowerCase().trim());
      return send(res, 200, 'application/json', '{"ok":true}', {
        'Set-Cookie': `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.FORCE_SECURE ? '; Secure' : ''}`,
      });
    }

    if (p === '/api/logout' && req.method === 'POST') {
      return send(res, 200, 'application/json', '{"ok":true}', {
        'Set-Cookie': 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      });
    }

    if (p === '/api/me' && req.method === 'GET') {
      return json(res, 200, { user: user || null });
    }

    // La API y los binarios de las apps exigen sesion. Sin esto, cualquiera
    // podria entrar directo a /apps/wordcraft/ y usar el editor sin cuenta: solo
    // el guardado fallaria. Para un producto de pago eso es un bypass.
    if ((p.startsWith('/api/') || p.startsWith('/apps/')) && !user) {
      return json(res, 401, { error: 'Sesion requerida' });
    }

    if (p === '/api/apps' && req.method === 'GET') {
      return json(res, 200, { apps: APPS });
    }

    if (p === '/api/docs' && req.method === 'GET') {
      const app = url.searchParams.get('app');
      return json(res, 200, { docs: store.list(user, isApp(app) ? app : null) });
    }

    if (p === '/api/docs' && req.method === 'POST') {
      const { name, folderId, app } = await readJson(req);
      return json(res, 201, {
        doc: store.create(user, name, folderId || null, isApp(app) ? app : null),
      });
    }

    // ---- Carpetas ----
    if (p === '/api/folders' && req.method === 'GET') {
      return json(res, 200, { folders: store.listFolders(user) });
    }

    if (p === '/api/folders' && req.method === 'POST') {
      const { name, parentId } = await readJson(req);
      return json(res, 201, { folder: store.createFolder(user, name, parentId || null) });
    }

    const folderMatch = p.match(/^\/api\/folders\/([0-9a-f-]+)(\/move)?$/);
    if (folderMatch) {
      const folderId = folderMatch[1];
      if (folderMatch[2] && req.method === 'POST') {
        const { parentId } = await readJson(req);
        return json(res, 200, { folder: store.moveFolder(user, folderId, parentId || null) });
      }
      if (req.method === 'PATCH') {
        const { name } = await readJson(req);
        return json(res, 200, { folder: store.renameFolder(user, folderId, name) });
      }
      if (req.method === 'DELETE') {
        store.removeFolder(user, folderId);
        return json(res, 200, { ok: true });
      }
    }

    const docMatch = p.match(/^\/api\/docs\/([0-9a-f-]+)(\/download|\/move|\/rename)?$/);
    if (docMatch) {
      const docId = docMatch[1];
      if (docMatch[2] === '/move' && req.method === 'POST') {
        const { folderId } = await readJson(req);
        return json(res, 200, { doc: store.move(user, docId, folderId || null) });
      }
      if (docMatch[2] === '/rename' && req.method === 'POST') {
        const { name } = await readJson(req);
        return json(res, 200, { doc: store.rename(user, docId, name) });
      }
      if (docMatch[2] === '/download' && req.method === 'GET') {
        const { doc, bytes } = store.read(user, docId);
        return send(res, 200, 'application/octet-stream', bytes, {
          'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.name)}"`,
        });
      }
      if (req.method === 'GET') {
        const { bytes } = store.read(user, docId);
        return send(res, 200, 'application/octet-stream', bytes, {
          'X-Doc-Name': encodeURIComponent(store.get(user, docId).name),
        });
      }
      if (req.method === 'POST') {
        const bytes = await readBody(req);
        const name = req.headers['x-doc-name'] || null;
        return json(res, 200, { doc: store.write(user, docId, bytes, name) });
      }
      if (req.method === 'DELETE') {
        store.remove(user, docId);
        return json(res, 200, { ok: true });
      }
    }

    // --- Paginas de la suite ---
    // El launcher: que app usar.
    if (p === '/' || p === '/index.html') {
      if (!user) return sendFile(req, res, path.join(PUBLIC_DIR, 'login.html'));
      return sendFile(req, res, path.join(PUBLIC_DIR, 'home.html'));
    }

    // El editor de una app concreta. El id se valida contra el catalogo.
    const editorMatch = p.match(/^\/a\/([a-z0-9-]+)$/);
    if (editorMatch) {
      if (!user) return send(res, 302, 'text/plain', '', { Location: '/' });
      if (!isApp(editorMatch[1])) return send(res, 404, 'text/plain', 'App desconocida');
      return sendFile(req, res, path.join(PUBLIC_DIR, 'app.html'));
    }

    // --- Archivos de las apps (WASM, JS, fuentes) ---
    const appFileMatch = p.match(/^\/apps\/([a-z0-9-]+)\/(.*)$/);
    if (appFileMatch) {
      const appId = appFileMatch[1];
      if (!isApp(appId)) return send(res, 404, 'text/plain', 'No encontrado');

      const dir = path.resolve(APPS_DIR, appId);
      // Peticion de directorio -> su index.html
      const rel = appFileMatch[2] === '' ? 'index.html' : appFileMatch[2];
      const file = path.resolve(dir, rel);
      if (!file.startsWith(dir + path.sep)) return send(res, 403, 'text/plain', 'Prohibido');

      if (rel === 'index.html') {
        const html = appIndex(appId);
        if (!html) return send(res, 404, 'text/plain', `Falta la build web de ${appId}`);
        return send(res, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-store' });
      }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return sendFile(req, res, file);
      }
      return send(res, 404, 'text/plain', 'No encontrado');
    }

    // OJO: path.resolve() descarta los argumentos anteriores en cuanto ve uno
    // que empieza por '/', por eso hay que quitar la barra inicial antes de
    // resolver, o acabaria buscando en la raiz del disco.
    const file = path.resolve(PUBLIC_DIR, p.replace(/^\/+/, ''));
    if (!file.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
      return send(res, 403, 'text/plain', 'Prohibido');
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(req, res, file);
    }

    return send(res, 404, 'text/plain', 'No encontrado');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[error]', e);
    return json(res, status, { error: e.message || 'Error interno' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Escuchando en http://${HOST}:${PORT}`);
  console.log(`Datos en ${DATA_DIR}`);
  console.log(`Usuarios: ${auth.list().join(', ') || '(ninguno)'}`);
});