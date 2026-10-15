'use strict';
// Comprueba que el script de la pagina arranca.
//
// Una pagina en blanco no es un fallo de red ni del WASM: es un ReferenceError o
// un TypeError en el script de la pagina, y el navegador no lo enseña si no se
// mira la consola. Por eso se ejecuta aqui el script de public/app.html contra
// un DOM minimo: si algo se ejecuta en el tope antes de tiempo, se para aqui y
// no en produccion, a oscuras, con todas las apps en blanco.
//
// El stub es de mentira a proposito. Solo tiene que llegar hasta donde el script
// toca la pagina; lo que viene despues (peticiones, canvas) da igual.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FALLA ${name} ${extra}`); }
}

// ---- El stub ----------------------------------------------------------------

const elemento = () => ({
  textContent: '', innerHTML: '', value: '', className: '',
  style: {}, dataset: {}, children: [], scrollTop: 0, scrollLeft: 0,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, removeEventListener() {},
  appendChild() {}, insertBefore() {}, remove() {}, replaceChildren() {},
  querySelector: () => null, querySelectorAll: () => [],
  setAttribute() {}, getAttribute: () => null, focus() {}, click() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
});

function instalarStub() {
  const noop = () => {};
  globalThis.document = {
    getElementById: elemento, createElement: elemento, createDocumentFragment: elemento,
    querySelector: () => null, querySelectorAll: () => [], currentScript: null,
    addEventListener: noop, removeEventListener: noop, body: elemento(), documentElement: elemento(),
  };
  globalThis.window = {
    addEventListener: noop, removeEventListener: noop, location: {},
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    getComputedStyle: () => ({}),
  };
  globalThis.location = { pathname: '/gridcraft/', origin: 'https://estudio.test', search: '' };
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  // Peticiones que nunca responden: el script sigue hasta el final del tope y ya.
  globalThis.fetch = () => new Promise(() => {});
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  globalThis.setTimeout = () => 0; globalThis.clearTimeout = noop;
  globalThis.setInterval = () => 0; globalThis.clearInterval = noop;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.alert = noop; globalThis.confirm = () => true;
  // El arranque es una promesa que nunca acaba: su rechazo no es de nadie.
  process.on('unhandledRejection', () => {});
}

// ---- Las comprobaciones -----------------------------------------------------

console.log('script de la pagina');

// El prefijo del puente sale de `appId`, que viene de la URL, y no de `APP`,
// que arranca en `null` hasta que `boot()` lo llena. Con `APP` en el tope, el
// script muere antes de arrancar y todas las apps quedan en blanco.
check('el prefijo del puente se arma con appId', /const PREFIX = appId/.test(HTML));
check('appId esta declarado antes de usarse como prefijo',
  HTML.indexOf('const appId =') !== -1
  && HTML.indexOf('const appId =') < HTML.indexOf('const PREFIX ='));
check('ningun mensaje del puente lleva el id de una app escrito a mano',
  !/'(?:gridcraft|cadcraft):/.test(HTML));

// Y la prueba de verdad: ejecutar el script.
{
  const bloques = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  check('la pagina tiene un script que ejecutar', bloques.length > 0, `bloques: ${bloques.length}`);

  const js = bloques.map((b) => b[1]).join('\n');
  instalarStub();
  let fallo = null;
  try {
    new Function(js)();
  } catch (e) {
    fallo = e;
  }
  check('el script arranca sin ReferenceError ni TypeError',
    fallo === null, fallo ? `${fallo.constructor.name}: ${fallo.message}` : '');
}

console.log(`\n${pass} ok, ${fail} fallo(s)\n`);
process.exit(fail ? 1 : 0);
