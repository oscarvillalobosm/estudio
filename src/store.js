'use strict';
// Documentos y carpetas por usuario.
//
// Toda ruta se construye desde (a) el nombre de usuario, ya validado al crear la
// cuenta, y (b) un id UUID que genera el servidor. Nunca desde texto del cliente.
// Aun asi se verifica que la ruta resuelta siga dentro de la carpeta del usuario.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB por documento
const MAX_DEPTH = 12; // tope de anidamiento de carpetas

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  userDir(username) {
    return path.join(this.dataDir, 'users', username);
  }

  _resolveFile(username, docId) {
    if (!UUID_RE.test(String(docId || ''))) {
      throw Object.assign(new Error('Documento invalido'), { status: 400 });
    }
    const dir = path.resolve(this.userDir(username), 'files');
    const file = path.resolve(dir, `${docId}.xlsx`);
    if (path.dirname(file) !== dir) {
      throw Object.assign(new Error('Ruta invalida'), { status: 400 });
    }
    return file;
  }

  _meta(username, name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.userDir(username), name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  _write(username, name, data) {
    const dir = this.userDir(username);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  }

  // ---- Documentos ----------------------------------------------------------
  _docs(username) { return this._meta(username, 'index.json', {}); }
  _saveDocs(username, docs) { this._write(username, 'index.json', docs); }

  list(username, app = null) {
    const all = Object.values(this._docs(username));
    const docs = app ? all.filter((d) => d.app === app) : all;
    return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(username, name, folderId = null, app = null) {
    name = String(name || 'documento').slice(0, 120);
    const docId = crypto.randomUUID();
    const docs = this._docs(username);
    docs[docId] = {
      id: docId,
      name,
      app: app || null,
      folderId: this._checkFolder(username, folderId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(this.userDir(username), 'files'), { recursive: true });
    this._saveDocs(username, docs);
    return docs[docId];
  }

  get(username, docId) {
    const doc = this._docs(username)[docId];
    if (!doc) throw Object.assign(new Error('Documento no encontrado'), { status: 404 });
    return doc;
  }

  read(username, docId) {
    const doc = this.get(username, docId);
    const file = this._resolveFile(username, docId);
    if (!fs.existsSync(file)) {
      throw Object.assign(new Error('El archivo del documento no existe'), { status: 404 });
    }
    return { doc, bytes: fs.readFileSync(file) };
  }

  write(username, docId, bytes, name = null) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw Object.assign(new Error('Contenido vacio'), { status: 400 });
    }
    if (bytes.length > MAX_BYTES) {
      throw Object.assign(new Error('El documento supera el limite de 100 MB'), { status: 413 });
    }
    const docs = this._docs(username);
    const doc = this.get(username, docId);
    const file = this._resolveFile(username, docId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Escritura atomica: se escribe aparte y se renombra.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);

    // Si la app manda un nombre nuevo, se adopta. Asi el archivo en el servidor
    // refleja el titulo que el usuario le dio en la app.
    if (name) doc.name = String(name).slice(0, 120);
    doc.updatedAt = new Date().toISOString();
    doc.size = bytes.length;
    docs[docId] = doc;
    this._saveDocs(username, docs);
    return doc;
  }

  remove(username, docId) {
    this.get(username, docId);
    const file = this._resolveFile(username, docId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const docs = this._docs(username);
    delete docs[docId];
    this._saveDocs(username, docs);
  }

  rename(username, docId, name) {
    name = String(name || '').trim().slice(0, 120);
    if (!name) throw Object.assign(new Error('El nombre esta vacio'), { status: 400 });
    const docs = this._docs(username);
    const doc = this.get(username, docId);
    doc.name = name;
    doc.updatedAt = new Date().toISOString();
    docs[docId] = doc;
    this._saveDocs(username, docs);
    return doc;
  }

  move(username, docId, folderId) {
    const docs = this._docs(username);
    const doc = this.get(username, docId);
    doc.folderId = this._checkFolder(username, folderId);
    doc.updatedAt = new Date().toISOString();
    docs[docId] = doc;
    this._saveDocs(username, docs);
    return doc;
  }

  // ---- Carpetas ------------------------------------------------------------
  _folders(username) { return this._meta(username, 'folders.json', {}); }
  _saveFolders(username, folders) { this._write(username, 'folders.json', folders); }

  _checkFolder(username, folderId) {
    if (folderId === null || folderId === undefined || folderId === '') return null;
    if (!UUID_RE.test(String(folderId))) {
      throw Object.assign(new Error('Carpeta invalida'), { status: 400 });
    }
    if (!this._folders(username)[folderId]) {
      throw Object.assign(new Error('Carpeta no encontrada'), { status: 404 });
    }
    return folderId;
  }

  // Altura de una carpeta contando hacia arriba; null si no existe.
  _depth(username, folderId) {
    const folders = this._folders(username);
    let depth = 0;
    let cur = folderId;
    const seen = new Set();
    while (cur) {
      if (seen.has(cur)) return Infinity; // ciclo: trata como invalido
      seen.add(cur);
      const f = folders[cur];
      if (!f) return null;
      depth += 1;
      if (depth > MAX_DEPTH) return Infinity;
      cur = f.parentId;
    }
    return depth;
  }

  listFolders(username) {
    const folders = this._folders(username);
    return Object.values(folders).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  createFolder(username, name, parentId = null) {
    name = String(name || '').trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('El nombre de la carpeta esta vacio'), { status: 400 });
    parentId = this._checkFolder(username, parentId);

    const baseDepth = parentId ? this._depth(username, parentId) : 0;
    if (baseDepth === null) throw Object.assign(new Error('Carpeta padre no encontrada'), { status: 404 });
    if (baseDepth >= MAX_DEPTH) {
      throw Object.assign(new Error(`No se pueden anidar mas de ${MAX_DEPTH} niveles`), { status: 400 });
    }

    const folders = this._folders(username);
    const id = crypto.randomUUID();
    folders[id] = { id, name, parentId, createdAt: new Date().toISOString() };
    this._saveFolders(username, folders);
    return folders[id];
  }

  renameFolder(username, folderId, name) {
    name = String(name || '').trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('El nombre de la carpeta esta vacio'), { status: 400 });
    const folders = this._folders(username);
    const folder = folders[folderId];
    if (!folder) throw Object.assign(new Error('Carpeta no encontrada'), { status: 404 });
    folder.name = name;
    this._saveFolders(username, folders);
    return folder;
  }

  moveFolder(username, folderId, parentId) {
    const folders = this._folders(username);
    const folder = folders[folderId];
    if (!folder) throw Object.assign(new Error('Carpeta no encontrada'), { status: 404 });

    parentId = this._checkFolder(username, parentId);
    if (parentId === folderId) {
      throw Object.assign(new Error('Una carpeta no puede contenerse a si misma'), { status: 400 });
    }
    // No se puede mover una carpeta dentro de si misma ni de una de sus hijas.
    if (parentId) {
      const folders2 = this._folders(username);
      let cur = parentId;
      const seen = new Set();
      while (cur) {
        if (cur === folderId) {
          throw Object.assign(
            new Error('Una carpeta no puede moverse dentro de si misma'),
            { status: 400 }
          );
        }
        if (seen.has(cur)) break;
        seen.add(cur);
        cur = folders2[cur].parentId;
      }
    }

    const newDepth = parentId ? this._depth(username, parentId) + 1 : 0;
    const oldDepth = this._depth(username, folderId);
    if (newDepth === null || oldDepth === null) {
      throw Object.assign(new Error('Arbol de carpetas inconsistente'), { status: 409 });
    }
    if (newDepth > MAX_DEPTH) {
      throw Object.assign(new Error(`No se pueden anidar mas de ${MAX_DEPTH} niveles`), { status: 400 });
    }

    folder.parentId = parentId;
    this._saveFolders(username, folders);
    return folder;
  }

  // Borra una carpeta vacia. Con contenido dentro, se rechaza: es mas seguro
  // que mover en cascada cosas que el usuario no espera mover.
  removeFolder(username, folderId) {
    const folders = this._folders(username);
    const folder = folders[folderId];
    if (!folder) throw Object.assign(new Error('Carpeta no encontrada'), { status: 404 });

    const hasSub = Object.values(folders).some((f) => f.parentId === folderId);
    if (hasSub) {
      throw Object.assign(
        new Error('La carpeta tiene subcarpetas. Borralas o muevelas primero.'),
        { status: 409 }
      );
    }
    const hasDocs = Object.values(this._docs(username)).some((d) => d.folderId === folderId);
    if (hasDocs) {
      throw Object.assign(
        new Error('La carpeta tiene documentos. Muevelos o borralos primero.'),
        { status: 409 }
      );
    }

    delete folders[folderId];
    this._saveFolders(username, folders);
  }

  // Ruta de una carpeta como lista de nombres, para mostrarla en la interfaz.
  folderPath(username, folderId) {
    const folders = this._folders(username);
    const out = [];
    let cur = folderId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const f = folders[cur];
      if (!f) break;
      out.unshift(f.name);
      cur = f.parentId;
    }
    return out;
  }
}

module.exports = { Store, UUID_RE, MAX_BYTES, MAX_DEPTH };