'use strict';
// Envio de correo por SMTP, sin dependencias.
//
// Node no trae cliente SMTP y este proyecto no usa npm, asi que se implementa
// lo justo: EHLO, STARTTLS opcional, AUTH LOGIN/PLAIN y el mensaje. Cubre
// Gmail, Outlook/Microsoft 365 y cualquier servidor que hable SMTP.
//
// Si no hay configuracion SMTP, `configured()` devuelve false y quien llama
// cae en el plan B: devolver el enlace de invitacion para compartirlo a mano.
// El sistema nunca se queda sin poder invitar por una falta de correo.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const CRLF = '\r\n';

function env(name) {
  const v = process.env[name];
  return v ? String(v).trim() : '';
}

// STARTTLS o puerto 465 implicito, segun lo que se haya configurado.
function implicitTls() {
  const p = Number(env('SMTP_PORT') || 587);
  return p === 465;
}

function configured() {
  return !!(env('SMTP_HOST') && env('SMTP_USER') && env('SMTP_PASSWORD') && env('SMTP_FROM'));
}

// Los servidores SMTPExplicitos devuelven 220 con un banner multi-linea.
// Se lee hasta la linea que acaba en un espacio (continuacion) y no en guion.
class SmtpSession {
  constructor(socket, secure) {
    this.socket = socket;
    this.secure = secure;
    this.buf = '';
    this.waiters = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('La conexion SMTP se cerro')));
  }

  _onData(chunk) {
    this.buf += chunk;
    // Una respuesta completa es una linea "250 ..."-terminada.
    const m = this.buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/);
    if (!m) return;
    const line = m[0];
    this.buf = this.buf.slice(line.length);
    const waiter = this.waiters.shift();
    if (!waiter) return;
    waiter.resolve({ code: Number(line.slice(0, 3)), text: line });
  }

  _fail(err) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(err);
  }

  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async send(cmd, expect) {
    this.socket.write(cmd + CRLF);
    const r = await this.read();
    if (expect && r.code !== expect) {
      throw new Error(`SMTP ${r.code} a "${cmd.split(' ')[0]}": ${r.text.trim()}`);
    }
    return r;
  }

  end() {
    try { this.socket.end(); } catch { /* ya estaba cerrado */ }
  }
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      const s = new SmtpSession(tls.connect({ ...opts, servername: opts.host }), true);
      // La sesion debe poder leer el banner de saludo antes de resolver.
      s.read().then(() => resolve(s), reject);
    };
    if (opts.secure) {
      const sock = tls.connect({ ...opts, servername: opts.host }, onReady);
      sock.on('error', reject);
    } else {
      const sock = net.connect(opts.port, opts.host, () => {
        const s = new SmtpSession(sock, false);
        s.read().then(() => resolve(s), reject);
      });
      sock.on('error', reject);
    }
  });
}

function encodeHeader(value) {
  // Cabeceras con acentos o caracteres fuera de ASCII van en RFC 2047.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMessage({ from, to, subject, text, html }) {
  const boundary = '----estudio' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${encodeHeader(from.name ? `${from.name} <${from.address}>` : from.address)}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@estudio>`,
    'MIME-Version: 1.0',
  ];

  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      html,
      `--${boundary}--`,
    ].join(CRLF);
    return headers.join(CRLF) + CRLF + CRLF + body;
  }

  headers.push('Content-Type: text/plain; charset=utf-8');
  return headers.join(CRLF) + CRLF + CRLF + text;
}

async function send({ to, subject, text, html }) {
  if (!configured()) throw new Error('No hay SMTP configurado');

  const host = env('SMTP_HOST');
  const port = Number(env('SMTP_PORT') || 587);
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASSWORD');

  const fromAddr = env('SMTP_FROM');
  const fromName = env('SMTP_FROM_NAME') || 'Estudio';
  const helo = env('SMTP_HELO') || host;

  const s = await connect({
    host, port, secure: implicitTls(),
    rejectUnauthorized: env('SMTP_INSECURE') !== '1',
  });

  try {
    const greeting = await s.read();
    if (greeting.code !== 220) throw new Error(`SMTP no listo: ${greeting.text.trim()}`);

    await s.send('EHLO ' + helo, 250);

    // STARTTLS si el servidor lo ofrece y no se pidió TLS implicito.
    if (!s.secure) {
      const r = await s.send('STARTTLS', 220).catch(() => null);
      if (r && r.code === 220) {
        s.end();
        const s2 = await connect({ host, port, secure: true, rejectUnauthorized: env('SMTP_INSECURE') !== '1' });
        return await dialogue(s2, user, pass, to, subject, text, html, fromAddr, fromName);
      }
    }
    return await dialogue(s, user, pass, to, subject, text, html, fromAddr, fromName);
  } catch (e) {
    s.end();
    throw e;
  }
}

async function dialogue(s, user, pass, to, subject, text, html, fromAddr, fromName) {
  try {
    await s.send('AUTH LOGIN', 334);
    await s.send(Buffer.from(user, 'utf8').toString('base64'), 334);
    await s.send(Buffer.from(pass, 'utf8').toString('base64'), 235);

    await s.send(`MAIL FROM:<${fromAddr}>`, 250);
    await s.send(`RCPT TO:<${to}>`, 250);
    await s.send('DATA', 354);

    // Los puntos sueltos rompen el protocolo: se escapan duplicando.
    const cuerpo = buildMessage({
      from: { address: fromAddr, name: fromName },
      to, subject, text, html,
    }).replace(/\r?\n/g, CRLF);
    s.socket.write(cuerpo.replace(/^\./gm, '..') + CRLF + '.' + CRLF);
    const fin = await s.read();
    if (fin.code !== 250) throw new Error(`SMTP ${fin.code} al enviar: ${fin.text.trim()}`);

    try { await s.send('QUIT', 221); } catch { /* algunos servidores no contestan a QUIT */ }
    s.end();
    return { ok: true, code: fin.code };
  } catch (e) {
    s.end();
    throw e;
  }
}

module.exports = { send, configured, buildMessage };
