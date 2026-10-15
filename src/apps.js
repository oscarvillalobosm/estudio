'use strict';
// Catalogo de aplicaciones de la suite.
//
// `bridge: 'native'`  -> la app trae su propio puente postMessage (solo GridCraft).
// `bridge: 'shim'`    -> interceptamos la File System Access API desde la pagina host.
//
// La version se fija al compilar la imagen: es la build web oficial del proyecto
// original, descargada desde su release.

const APPS = [
  {
    id: 'gridcraft',
    label: 'Hojas de calculo',
    tagline: 'Formulas, graficos y tablas dinamicas',
    file: 'xlsx',
    bridge: 'native',
    from: 1, to: 3,
    colors: ['#16a34a', '#15803d'],
  },
  {
    id: 'wordcraft',
    label: 'Documentos',
    tagline: 'Procesador de textos completo',
    file: 'docx',
    bridge: 'shim',
    from: 1, to: 3,
    colors: ['#2563eb', '#1d4ed8'],
  },
  {
    id: 'pdfcraft',
    label: 'PDF',
    tagline: 'Editar, firmar, OCR y combinar',
    file: 'pdf',
    bridge: 'shim',
    from: 1, to: 3,
    colors: ['#dc2626', '#b91c1c'],
  },
  {
    id: 'photocraft',
    label: 'Imagen',
    tagline: 'Capas, filtros y retoque (PSD)',
    file: 'psd',
    bridge: 'shim',
    from: 1, to: 3,
    colors: ['#7c3aed', '#6d28d9'],
  },
  {
    id: 'vectorcraft',
    label: 'Vectorial',
    tagline: 'Ilustracion y logotipos',
    file: 'vectorcraft',
    bridge: 'shim',
    from: 1, to: 3,
    colors: ['#ea580c', '#c2410c'],
  },
];

const BY_ID = Object.fromEntries(APPS.map((a) => [a.id, a]));

// Extension -> app. The server uses this to route a document to the editor that
// can open it, both when the client does not say which app a document belongs to
// (a desktop shell) and when it needs to repair documents stored before that was
// known. The extension is the only thing both sides always agree on.
const BY_FILE = Object.fromEntries(APPS.map((a) => [a.file.toLowerCase(), a.id]));

// Which app opens this file name, or null when the extension is not one of ours.
function appForFile(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  return BY_FILE[ext] || null;
}

// An id de app viene siempre de la URL: se valida contra el catalogo en vez de
// usarlo para construir rutas.
function isApp(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
}

module.exports = { APPS, BY_ID, isApp, appForFile };