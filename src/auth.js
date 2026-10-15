'use strict';
// Usuarios y sesiones. Sin dependencias externas: solo node:crypto.
//
// El nombre de usuario se usa como componente de ruta en disco, asi que se valida
// con una expresion estricta al crear la cuenta. Nunca se acepta una ruta de aqui
// para construir una ruta del sistema de archivos.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias
const SCRYPT_KEYLEN = 64;

class Auth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    this.users = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.users, null, 2), { mode: 0o600 });
  }

  static validUsername(name) {
    return typeof name === 'string' && USERNAME_RE.test(name);
  }

  create(username, password) {
    username = String(username || '').toLowerCase().trim();
    this.checkCreatable(username, password);
    return this._insert(username, password);
  }

  // Valida formato y disponibilidad SIN hashear. Existe separado de create()
  // para que el servidor pueda comprobar la solicitud (y aplicar su freno de
  // abuso) antes de pagar el coste de scrypt, que es lo unico caro aqui.
  checkCreatable(username, password) {
    username = String(username || '').toLowerCase().trim();
    if (!Auth.validUsername(username)) {
      throw new Error('Usuario invalido: 3-32 caracteres, solo minusculas, digitos, - y _');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('La contrasena debe tener al menos 8 caracteres');
    }
    if (this.users[username]) throw new Error('Ese usuario ya existe');
    return username;
  }

  _insert(username, password) {
    const salt = crypto.randomBytes(16).toString('hex');
    this.users[username] = {
      salt,
      hash: crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    this._save();
    return username;
  }

  verify(username, password) {
    username = String(username || '').toLowerCase().trim();
    const u = this.users[username];
    // Se calcula igual aunque el usuario no exista, para no filtrar por tiempo.
    const salt = u ? u.salt : 'no-existe';
    const candidate = crypto
      .scryptSync(String(password || ''), salt, SCRYPT_KEYLEN)
      .toString('hex');
    if (!u) return false;
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(u.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  list() {
    return Object.keys(this.users).sort();
  }

  hasUsers() {
    return Object.keys(this.users).length > 0;
  }

  // Modos de registro, de mas abierto a mas cerrado:
  //   open   -> cualquiera puede crear su cuenta (ALLOW_REGISTRATION=1)
  //   first  -> solo mientras no exista ninguna cuenta (comportamiento inicial)
  //   closed -> nadie puede crear cuentas; hay que usar `adduser` por consola
  // Por defecto se elige `first`: en una instancia nueva el primer visitante
  // puede quedarse con la cuenta, y en cuanto existe una la pantalla de registro
  // desaparece sola. Asi un despliegue publico no se llena de cuentas basura.
  registrationState() {
    const mode = String(process.env.REGISTRATION_MODE || '').toLowerCase()
      || (process.env.ALLOW_REGISTRATION === '1' ? 'open' : 'first');
    if (mode === 'open') return { open: true, mode, reason: null };
    if (mode === 'closed') {
      return { open: false, mode, reason: 'El registro esta cerrado en este servidor' };
    }
    if (this.hasUsers()) {
      return {
        open: false,
        mode: 'first',
        reason: 'La cuenta inicial ya fue creada. Pide al administrador que cree la tuya',
      };
    }
    return { open: true, mode: 'first', reason: null };
  }

  // Cookie firmada: usuario.expiracion.hmac -> no hace falta almacenar sesiones,
  // asi que sobrevive a reinicios del contenedor.
  issueToken(username) {
    const expires = Date.now() + SESSION_TTL_MS;
    const payload = `${username}.${expires}`;
    const sig = crypto.createHmac('sha256', this.secret).update(payload).digest('hex');
    return `${payload}.${sig}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [username, expires, sig] = parts;

    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(`${username}.${expires}`)
      .digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    if (Number(expires) < Date.now()) return null;
    if (!this.users[username]) return null;
    return username;
  }

  // Borra una cuenta. Se usa para retirar accesos que quedaron con una clave
  // conocida (por ejemplo una que se creo desde ADMIN_PASSWORD y acabo en un
  // repositorio). Las sesiones de ese usuario dejan de valer en el acto: el
  // token se valida contra users, asi que basta con quitarlo de ahi.
  remove(username) {
    username = String(username || '').toLowerCase().trim();
    if (!this.users[username]) return false;
    delete this.users[username];
    this._save();
    return true;
  }

  // El primer arranque crea el admin desde variables de entorno.
  bootstrap() {
    // RETIRAR_USERS=admin,otro retira esas cuentas al arrancar. Se ejecuta
    // ANTES del bootstrap para que una cuenta de esas no vuelva a crearse.
    const retirar = String(process.env.RETIRAR_USERS || '').split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => USERNAME_RE.test(s));
    for (const u of retirar) {
      console.log(`[auth] Cuenta retirada ${this.remove(u) ? 'OK' : '(no existia)'}: ${u}`);
    }

    if (Object.keys(this.users).length > 0) return;
    const user = process.env.ADMIN_USER;
    const pass = process.env.ADMIN_PASSWORD;
    if (!user || !pass) {
      console.warn('[auth] No hay usuarios. Crea el primero: node src/server.js adduser <user> <pass>');
      return;
    }
    this.create(user, pass);
    console.log(`[auth] Usuario administrador creado: ${user}`);
  }
}

module.exports = { Auth, USERNAME_RE };