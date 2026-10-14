'use strict';
// Arnés de pruebas del flujo de registro. Arranca un servidor hijo con un
// directorio de datos limpio y prueba la API HTTP de verdad.
// No forma parte del repo: es herramienta de desarrollo.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = 8399;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FALLA ${name} ${extra}`); }
}

async function req(method, p, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, data, cookie: res.headers.get('set-cookie') };
}

function sessionCookie(setCookie) {
  return String(setCookie || '').split(';')[0];
}

async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'estudio-reg-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SESSION_SECRET: 'a'.repeat(64),
      APP_TITLE: 'Estudio',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/registration`);
      if (res.ok) return { child, dataDir };
    } catch { /* aun no escucha */ }
  }
  console.log(log);
  throw new Error('El servidor no arranco');
}

async function main() {
  console.log('\n== Modo por defecto: solo el primer usuario puede registrarse ==');
  let srv = await startServer();
  {
    const st = await req('GET', '/api/registration');
    check('registro abierto en instancia vacia', st.data.open === true, JSON.stringify(st.data));

    const r = await req('POST', '/api/register', { username: 'oscar', password: 'clave-de-prueba-123' });
    check('crea el primer usuario', r.status === 200, r.status);
    check('devuelve cookie de sesion', !!sessionCookie(r.cookie));

    const me = await req('GET', '/api/me', null, sessionCookie(r.cookie));
    check('la cookie abre sesion', me.data.user === 'oscar', JSON.stringify(me.data));

    const st2 = await req('GET', '/api/registration');
    check('registro se cierra solo tras la primera cuenta', st2.data.open === false);

    const r2 = await req('POST', '/api/register', { username: 'otro', password: 'clave-de-prueba-123' });
    check('segundo registro rechazado con 403', r2.status === 403, r2.status);
    check('el motivo explica como pedir la cuenta', /administrador/i.test(r2.data.error || ''), r2.data.error);

    const pub = await fetch(`${BASE}/`, { redirect: 'manual' });
    const html = await pub.text();
    check('la pantalla publica el boton Crear cuenta', html.includes('Crear cuenta'));
  }
  srv.child.kill();
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n== Modo abierto (ALLOW_REGISTRATION=1) ==');
  srv = await startServer({ ALLOW_REGISTRATION: '1' });
  {
    check('registro abierto', (await req('GET', '/api/registration')).data.open === true);

    const bad = [
      ['contrasena corta', { username: 'ana', password: 'corta' }],
      ['usuario muy corto', { username: 'ab', password: 'clave-de-prueba-123' }],
      ['espacios en el nombre', { username: 'Ana Maria', password: 'clave-de-prueba-123' }],
      ['intento de traversal', { username: '../../etc', password: 'clave-de-prueba-123' }],
      ['simbolo no permitido', { username: 'user!', password: 'clave-de-prueba-123' }],
      ['usuario vacio', { username: '', password: 'clave-de-prueba-123' }],
    ];
    for (const [name, body] of bad) {
      const r = await req('POST', '/api/register', body);
      check(`rechaza: ${name}`, r.status === 400, `${r.status} ${JSON.stringify(r.data)}`);
    }

    const ok = await req('POST', '/api/register', { username: 'ana', password: 'clave-de-prueba-123' });
    check('acepta un usuario valido', ok.status === 200, JSON.stringify(ok.data));

    const dup = await req('POST', '/api/register', { username: 'ana', password: 'clave-de-prueba-123' });
    check('rechaza duplicado', dup.status === 400 && /ya existe/i.test(dup.data.error), JSON.stringify(dup.data));

    // Modo abierto: se pueden crear varias cuentas distintas.
    const r2 = await req('POST', '/api/register', { username: 'bruno', password: 'clave-de-prueba-123' });
    check('permite una segunda cuenta distinta', r2.status === 200, JSON.stringify(r2.data));

    // Aislamiento: la carpeta de un usuario no es visible para otro.
    const c1 = sessionCookie(ok.cookie), c2 = sessionCookie(r2.cookie);
    const mk = await req('POST', '/api/folders', { name: 'Clientes' }, c1);
    check('crea carpeta con su sesion', mk.status < 300, JSON.stringify(mk.data));
    const tree1 = await req('GET', '/api/folders', null, c1);
    const tree2 = await req('GET', '/api/folders', null, c2);
    check('la ve su propio arbol', JSON.stringify(tree1.data).includes('Clientes'), JSON.stringify(tree1.data));
    check('el otro usuario no la ve', !JSON.stringify(tree2.data).includes('Clientes'));
  }
  srv.child.kill();
  await new Promise((r) => setTimeout(r, 800));

  console.log('\n== Freno anti-abuso ==');
  srv = await startServer({ ALLOW_REGISTRATION: '1' });
  let srv2 = null;
  {
    const codes = [];
    for (let i = 0; i < 7; i++) {
      const r = await req('POST', '/api/register', { username: `us${i}`, password: 'clave-de-prueba-123' });
      codes.push(r.status);
    }
    const primeros = codes.slice(0, 5).every((c) => c === 200);
    check('los primeros 5 registros pasan', primeros, JSON.stringify(codes));
    check('el 6to ya recibe 429', codes[5] === 429, JSON.stringify(codes));
    check('el 7to tambien', codes[6] === 429, JSON.stringify(codes));

    // Y el login no se ve afectado por el freno del registro.
    const l = await req('POST', '/api/login', { username: 'us0', password: 'clave-de-prueba-123' });
    check('el login sigue funcionando', l.status === 200, l.status);

    // El freno no debe castigar los errores de validacion: quien teclea mal la
    // contrasena cinco veces y luego la acierta tiene que poder registrarse.
    console.log('\n== El freno no penaliza errores de validacion ==');
    srv.child.kill();
    await new Promise((r) => setTimeout(r, 800));
    srv2 = await startServer({ ALLOW_REGISTRATION: '1' });
    for (let i = 0; i < 8; i++) {
      const r = await req('POST', '/api/register', { username: `va${i}`, password: 'corta' });
      if (r.status !== 400) check(`intento ${i} de contrasena corta da 400`, false, r.status);
    }
    check('8 intentos invalidos no gastaron cupo', true);
    const bueno = await req('POST', '/api/register', { username: 'vale', password: 'clave-de-prueba-123' });
    check('el intento bueno siguiente si pasa', bueno.status === 200, JSON.stringify(bueno.data));
  }
  srv.child.kill();
  await new Promise((r) => setTimeout(r, 500));

  console.log(`\n${pass} ok, ${fail} fallo(s)\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });