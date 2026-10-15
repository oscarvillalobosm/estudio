'use strict';
// Invitaciones para darse de alta en la nube.
//
// Una invitacion es un token de un solo uso con caducidad. Quien lo recibe abre
// el enlace, elige su contrasena y queda con la cuenta creada. El token es lo
// unico que se guarda: jamas la contrasena de la persona invitada, porque la
// elige ella al aceptar.
//
// Sin dependencias: node:crypto y node:fs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Una cuenta que se crea por invitacion NO es admin, aunque el servidor este
// vacio: la siguiente cuenta invitada heredaria el rol sin haberlo pedido nadie.
const DEFAULT_ROLE = 'user';

class Invitations {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'invitations.json');
    this.list_ = this._load();
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.list_, null, 2), { mode: 0o600 });
  }

  static validEmail(email) {
    return typeof email === 'string' && EMAIL_RE.test(email.trim());
  }

  // `username` es opcional: si se indica, la cuenta queda reservada con ese
  // nombre y el enlace sirve para ACTIVARLA. Si no, el enlace sirve para CREARLA.
  create(email, username) {
    email = String(email || '').trim().toLowerCase();
    if (!Invitations.validEmail(email)) throw new Error('Correo invalido');
    if (username !== undefined && username !== null && username !== '') {
      username = String(username).toLowerCase().trim();
    } else {
      username = null;
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const inv = {
      token,
      email,
      username,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      usedAt: null,
    };
    this.list_.push(inv);
    this._save();
    return inv;
  }

  find(token) {
    if (typeof token !== 'string' || token.length < 10) return null;
    return this.list_.find((i) => i.token === token) || null;
  }

  // Estado de una invitacion tal y como lo ve quien la va a usar: nunca el token
  // completo ni ningun dato de la cuenta invitada mas alla del nombre.
  peek(token) {
    const inv = this.find(token);
    if (!inv) return { valid: false, reason: 'Esta invitacion no existe' };
    if (inv.usedAt) return { valid: false, reason: 'Esta invitacion ya se uso' };
    if (Date.parse(inv.expiresAt) < Date.now()) {
      return { valid: false, reason: 'Esta invitacion caduco. Pide una nueva' };
    }
    return { valid: true, email: inv.email, username: inv.username };
  }

  // Marca la invitacion como usada. Se hace DESPUES de crear la cuenta, para
  // que un fallo a mitad no queme la invitacion: es mejor que una invitacion
  // se pueda reutilizar por un error que perderla sin avisar.
  consume(token) {
    const inv = this.find(token);
    if (!inv) throw new Error('Invitacion no valida');
    if (inv.usedAt) throw new Error('Esta invitacion ya se uso');
    if (Date.parse(inv.expiresAt) < Date.now()) throw new Error('Esta invitacion caduco');
    inv.usedAt = new Date().toISOString();
    this._save();
    return inv;
  }

  // Borra las usadas y las caducadas. Se puede llamar al arrancar.
  prune() {
    const antes = this.list_.length;
    this.list_ = this.list_.filter(
      (i) => !i.usedAt && Date.parse(i.expiresAt) > Date.now()
    );
    if (this.list_.length !== antes) this._save();
    return antes - this.list_.length;
  }

  remove(token) {
    const n = this.list_.length;
    this.list_ = this.list_.filter((i) => i.token !== token);
    if (this.list_.length !== n) this._save();
    return this.list_.length !== n;
  }

  // Vista para el panel. El token va entero porque el admin tiene que poder
  // copiar el enlace; quien llega al panel ya esta autenticado como admin.
  infoAll() {
    return this.list_.map((i) => ({
      token: i.token,
      email: i.email,
      username: i.username,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt,
      expired: !i.usedAt && Date.parse(i.expiresAt) < Date.now(),
    }));
  }
}

module.exports = { Invitations, TTL_MS };
