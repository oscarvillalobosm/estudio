'use strict';
// Pruebas del panel de administracion: roles, gestion de cuentas e invitaciones.
// Arranca servidores hijos con datos limpios y habla HTTP de verdad.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
let PORT = 8407;

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FALLA ${name} ${extra}`); }
}

async function req(method, p, body, cookie) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  let data = null;
  const txt = await res.text();
  try { data = JSON.parse(txt); } catch { data = txt; }
  return { status: res.status, data, cookie: res.headers.get('set-cookie'), text: txt };
}

function sessionCookie(setCookie) {
  return String(setCookie || '').split(';')[0];
}

async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'estudio-admin-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SESSION_SECRET: 'b'.repeat(64),
      REGISTRATION_MODE: 'open',
      APP_TITLE: 'Estudio',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/registration`);
      if (res.ok) return { child, dataDir, log: () => log };
    } catch { /* aun no escucha */ }
  }
  console.log(log);
  throw new Error('El servidor no arranco');
}

async function login(username, password) {
  const r = await req('POST', '/api/login', { username, password });
  return sessionCookie(r.cookie);
}

(async () => {
  console.log('\n== Roles ==');
  let srv = await startServer();
  {
    // La primera cuenta es admin por decision de producto.
    const r1 = await req('POST', '/api/register', { username: 'oscar', password: 'clave-de-prueba-123' });
    const c1 = sessionCookie(r1.cookie);
    const me = await req('GET', '/api/me', undefined, c1);
    check('la primera cuenta es admin', me.data.role === 'admin', JSON.stringify(me.data));

    // La segunda no.
    const r2 = await req('POST', '/api/register', { username: 'bruno', password: 'clave-de-prueba-123' });
    const c2 = sessionCookie(r2.cookie);
    const me2 = await req('GET', '/api/me', undefined, c2);
    check('la segunda cuenta es usuario normal', me2.data.role === 'user', JSON.stringify(me2.data));

    console.log('\n== Un usuario normal no entra al panel ==');
    const no = await req('GET', '/api/admin/users', undefined, c2);
    check('la API le responde 403', no.status === 403, no.status);
    const no2 = await req('GET', '/api/admin/users');
    check('sin sesion responde 401', no2.status === 401, no2.status);
    const pag = await req('GET', '/admin', undefined, c2);
    check('la pagina /admin responde 403', pag.status === 403, pag.status);
    const pagSin = await req('GET', '/admin');
    check('/admin sin sesion redirige al login', pagSin.status === 302, pagSin.status);

    console.log('\n== Gestion de cuentas ==');
    const lista = await req('GET', '/api/admin/users', undefined, c1);
    check('el admin ve la lista', lista.status === 200 && lista.data.users.length === 2, JSON.stringify(lista.data));
    const nadieSabeHash = JSON.stringify(lista.data).includes('"hash"') || JSON.stringify(lista.data).includes('"salt"');
    check('la lista NO expone hash ni sal', !nadieSabeHash);

    const crea = await req('POST', '/api/admin/users',
      { username: 'carla', password: 'clave-de-prueba-123' }, c1);
    check('el admin crea una cuenta', crea.status === 201, JSON.stringify(crea.data));
    check('la cuenta nueva no es admin', crea.data.user && crea.data.user.role === 'user',
      JSON.stringify(crea.data));

    const c3 = await login('carla', 'clave-de-prueba-123');
    check('la cuenta creada puede entrar', !!c3);

    const mala = await req('POST', '/api/admin/users',
      { username: 'carla', password: 'clave-de-prueba-123' }, c1);
    check('no se puede duplicar', mala.status === 400, JSON.stringify(mala.data));

    console.log('\n== Cambiar contrasena ==');
    const camb = await req('POST', '/api/admin/users/carla/password',
      { password: 'clave-nueva-456' }, c1);
    check('el admin cambia la contrasena', camb.status === 200, JSON.stringify(camb.data));
    const conVieja = await login('carla', 'clave-de-prueba-123');
    check('la contrasena vieja ya no sirve', !conVieja);
    const conNueva = await login('carla', 'clave-nueva-456');
    check('la nueva si sirve', !!conNueva);
    const corta = await req('POST', '/api/admin/users/carla/password', { password: 'corta' }, c1);
    check('rechaza contrasenas cortas', corta.status === 400, JSON.stringify(corta.data));
    // El rol no debe perderse al cambiar la contrasena.
    const info = await req('GET', '/api/admin/users', undefined, c1);
    const carla = info.data.users.find((u) => u.username === 'carla');
    check('conserva el rol al cambiar la contrasena', carla && carla.role === 'user',
      JSON.stringify(carla));

    console.log('\n== Promover y degradar ==');
    const promo = await req('POST', '/api/admin/users/carla/role', { role: 'admin' }, c1);
    check('el admin promueve a carla', promo.status === 200 && promo.data.user.role === 'admin',
      JSON.stringify(promo.data));
    const c3b = await login('carla', 'clave-nueva-456');
    const yaAdmin = await req('GET', '/api/admin/users', undefined, c3b);
    check('ahora carla puede entrar al panel', yaAdmin.status === 200, yaAdmin.status);

    const degrada = await req('POST', '/api/admin/users/carla/role', { role: 'user' }, c1);
    check('vuelve a usuario normal', degrada.status === 200 && degrada.data.user.role === 'user');

    const invalido = await req('POST', '/api/admin/users/carla/role', { role: 'super' }, c1);
    check('rechaza roles inventados', invalido.status === 400, JSON.stringify(invalido.data));

    console.log('\n== No dejar el servidor sin admin ==');
    const bajaOs = await req('POST', '/api/admin/users/oscar/role', { role: 'user' }, c1);
    check('no se puede degradar al unico admin', bajaOs.status === 400, JSON.stringify(bajaOs.data));

    console.log('\n== Borrar cuentas ==');
    const borrarse = await req('DELETE', '/api/admin/users/oscar', undefined, c1);
    check('no se puede borrar a uno mismo', borrarse.status === 400, JSON.stringify(borrarse.data));

    const borra = await req('DELETE', '/api/admin/users/carla', undefined, c1);
    check('el admin borra otra cuenta', borra.status === 200, JSON.stringify(borra.data));
    const sigueViva = await login('carla', 'clave-nueva-456');
    check('la cuenta borrada ya no entra', !sigueViva);

    console.log('\n== Invitaciones (sin SMTP: plan B = enlace) ==');
    const sinSmtp = await req('GET', '/api/admin/invitations', undefined, c1);
    check('el panel dice si hay SMTP', sinSmtp.data.smtp === false, JSON.stringify(sinSmtp.data));

    const invalida = await req('POST', '/api/admin/invitations', { email: 'no-es-correo' }, c1);
    check('rechaza un correo invalido', invalida.status === 400, JSON.stringify(invalida.data));

    const noPuede = await req('POST', '/api/admin/invitations', { email: 'x@y.com' }, c2);
    check('un usuario normal no puede invitar', noPuede.status === 403, noPuede.status);

    const inv = await req('POST', '/api/admin/invitations', { email: 'ana@ejemplo.com' }, c1);
    check('crea la invitacion', inv.status === 201, JSON.stringify(inv.data));
    check('devuelve el enlace', /\/invitacion\//.test(inv.data.link || ''), inv.data.link);
    check('avisa de que no hay SMTP', typeof inv.data.aviso === 'string', JSON.stringify(inv.data));
    check('no dice que se envio', inv.data.enviado === false);

    const token = (inv.data.link || '').split('/').pop();
    const mira = await req('GET', `/api/invitacion?token=${token}`);
    check('la invitacion es valida', mira.status === 200 && mira.data.valid === true, JSON.stringify(mira.data));

    const acepta = await req('POST', '/api/invitacion/aceptar',
      { token, username: 'ana', password: 'clave-de-prueba-123' });
    check('la invitada crea su cuenta', acepta.status === 200, JSON.stringify(acepta.data));
    const cAna = sessionCookie(acepta.cookie);
    const entraAna = await req('GET', '/api/me', undefined, cAna);
    check('entra con su sesion', entraAna.data.user === 'ana', JSON.stringify(entraAna.data));
    check('la invitada NO es admin', entraAna.data.role === 'user', JSON.stringify(entraAna.data));

    const reuso = await req('POST', '/api/invitacion/aceptar',
      { token, username: 'ana2', password: 'clave-de-prueba-123' });
    check('el enlace es de un solo uso', reuso.status === 400, JSON.stringify(reuso.data));

    const tokenFalso = await req('GET', '/api/invitacion?token=aaaaabbbbbcccccddddd');
    check('un token inventado no vale', tokenFalso.status === 400, JSON.stringify(tokenFalso.data));

    console.log('\n== Invitacion con usuario reservado ==');
    const inv2 = await req('POST', '/api/admin/invitations',
      { email: 'luis@ejemplo.com', username: 'luis' }, c1);
    const t2 = (inv2.data.link || '').split('/').pop();
    const acepta2 = await req('POST', '/api/invitacion/aceptar',
      { token: t2, username: 'otro', password: 'clave-de-prueba-123' });
    check('la cuenta acepta el nombre que se le reservo', acepta2.status === 200, JSON.stringify(acepta2.data));
    const entraLuis = await login('luis', 'clave-de-prueba-123');
    check('se creo con el nombre reservado, no con el enviado', !!entraLuis);

    const repetido = await req('POST', '/api/invitacion/aceptar',
      { token: t2, username: 'x', password: 'clave-de-prueba-123' });
    check('la segunda cuenta duplicada no se crea', repetido.status === 400, JSON.stringify(repetido.data));

    console.log('\n== Borrar invitacion ==');
    const inv3 = await req('POST', '/api/admin/invitations', { email: 'temporal@ejemplo.com' }, c1);
    const t3 = (inv3.data.link || '').split('/').pop();
    const del = await req('DELETE', '/api/admin/invitations', { token: t3 }, c1);
    check('el admin borra la invitacion', del.status === 200 && del.data.ok === true, JSON.stringify(del.data));
    const muerta = await req('GET', `/api/invitacion?token=${t3}`);
    check('ya no se puede aceptar', muerta.status === 400);
  }
  srv.child.kill();
  await new Promise((r) => setTimeout(r, 600));

  console.log('\n== Servidor sin admins: la siguiente cuenta los hereda ==');
  PORT = 8408;
  srv = await startServer();
  {
    const r1 = await req('POST', '/api/register', { username: 'primero', password: 'clave-de-prueba-123' });
    check('la primera es admin', JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/api/me`, {
      headers: { Cookie: sessionCookie(r1.cookie) } })).text()).role === 'admin');
    // Se borra el admin desde el propio panel: el servidor queda sin admins.
    const c1 = sessionCookie(r1.cookie);
    const b = await req('DELETE', '/api/admin/users/primero', undefined, c1);
    check('el admin puede borrarse a si mismo... no puede', b.status === 400);
  }
  srv.child.kill();
  await new Promise((r) => setTimeout(r, 600));

  console.log(`\n${pass} ok, ${fail} fallo(s)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });