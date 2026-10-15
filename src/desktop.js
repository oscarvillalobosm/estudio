'use strict';
// Catalogo de las apps de escritorio para Windows, y de lo que hay realmente en disco.
//
// Es hermano de `apps.js` pero distinto en lo importante: `apps.js` describe lo que el
// navegador puede abrir, y el servidor **falla** si le falta una build web. Aqui el que
// descargue tiene que poder seguir entrando igual si una app no llego a la imagen: por eso
// no hay ninguna lista fija de "esto existe", se comprueba el disco y se informa de lo que
// se encontro. Una pagina de descargas que ofrece un archivo que no esta es peor que una
// que no lo ofrece.

const fs = require('node:fs');
const path = require('node:path');

const DESKTOP_DIR = path.join(__dirname, '..', 'public', 'escritorio');

// Un ejecutable por app. El nombre es el del binario: no hay instalador, se descarga y se
// ejecuta, asi que el archivo **es** la aplicacion.
const DESKTOP = [
  {
    id: 'gridcraft',
    file: 'gridcraft.exe',
    label: 'Hojas de calculo',
    tagline: 'Formulas, graficos y tablas dinamicas',
    glyph: '▦',
  },
  {
    id: 'wordcraft',
    file: 'wordcraft.exe',
    label: 'Documentos',
    tagline: 'Procesador de textos completo',
    glyph: '▤',
  },
  {
    id: 'pdfcraft',
    file: 'pdfcraft.exe',
    label: 'PDF',
    tagline: 'Editar, firmar, OCR y combinar',
    glyph: '▧',
  },
  {
    id: 'deckcraft',
    file: 'deckcraft.exe',
    label: 'Presentaciones',
    tagline: 'Diapositivas, diseno y exportacion',
    glyph: '▥',
  },
];

// Un ejecutable por app, y de que color es su icono: los mismos tonos que usa el panel,
// para que el escritorio y la web se reconozcan como la misma suite.
const COLORS = {
  gridcraft: ['#16a34a', '#15803d'],
  wordcraft: ['#2563eb', '#1d4ed8'],
  pdfcraft: ['#dc2626', '#b91c1c'],
  deckcraft: ['#db2777', '#be185d'],
};

function human(bytes) {
  if (!Number.isFinite(bytes)) return '';
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(0)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Lo que hay en disco ahora mismo. Se llama en cada peticion a proposito: es una lectura de
// cuatro `stat`, y asi la pagina nunca ofrece algo que la imagen no traiga.
function disponibles() {
  const out = [];
  for (const app of DESKTOP) {
    const file = path.join(DESKTOP_DIR, app.file);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size === 0) continue;
      out.push({
        ...app,
        colors: COLORS[app.id] || ['#3b82f6', '#1d4ed8'],
        bytes: st.size,
        size: human(st.size),
        path: file,
      });
    } catch {
      // No esta en esta imagen: no se ofrece. Siguiente.
    }
  }
  return out;
}

// Resuelve un nombre pedido a algo real dentro del directorio. Devuelve null si no existe o
// si el nombre intenta salirse (`..`, una barra...). Es la unica puerta que usa el servidor
// para dar binarios, asi que la comprobacion va aqui y no repartida por el enrutador.
function resolver(nombre) {
  const limpio = path.basename(String(nombre || ''));
  if (limpio !== nombre || limpio !== DESKTOP.find((a) => a.file === limpio)?.file) return null;
  const file = path.join(DESKTOP_DIR, limpio);
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return file;
}

module.exports = { DESKTOP_DIR, disponibles, resolver, human };