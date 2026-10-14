'use strict';
// Script que se inyecta dentro del index.html de cada app.
//
// Por que funciona: el servidor reescribe ese index.html antes de enviarlo, asi que
// este codigo corre en el MISMO origen que la pagina host y puede:
//   - interceptar la File System Access API, que es por donde las cinco apps guardan
//   - capturar descargas por blob, por si alguna variante usa esa via
//   - devolver archivos del servidor cuando la app pide abrir
//
// La app cree que esta trabajando en disco. En realidad nos entrega los bytes.

const SHIM = `
<script>
(function () {
  var APP = document.currentScript && document.currentScript.dataset.app || '';

  function emit(msg) { parent.postMessage(msg, location.origin); }

  function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
  }
  function collect(data) {
    if (data instanceof Blob) return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return Promise.resolve(toU8(data));
  }

  // ============ GUARDAR ============
  if (window.showSaveFilePicker) {
    window.showSaveFilePicker = function (opts) {
      opts = opts || {};
      var name = opts.suggestedName || 'documento';
      var mime = (opts.types && opts.types[0] && opts.types[0].accept)
        ? Object.keys(opts.types[0].accept)[0] : '';
      var chunks = [], pos = 0;

      return Promise.resolve({
        kind: 'file', name: name,
        createWritable: function () {
          return Promise.resolve({
            write: function (data) {
              return collect(data).then(function (u8) { chunks.push(u8); pos += u8.length; return pos; });
            },
            truncate: function () { return Promise.resolve(); },
            seek: function () { return Promise.resolve(); },
            close: function () {
              var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
              var out = new Uint8Array(total), o = 0;
              for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
              emit({ suite: 'saved', app: APP, name: name, mime: mime, bytes: out.buffer });
              return Promise.resolve();
            },
            abort: function () { return Promise.resolve(); },
          });
        },
        queryPermission: function () { return Promise.resolve('granted'); },
        requestPermission: function () { return Promise.resolve('granted'); },
        isSameEntry: function () { return Promise.resolve(false); },
      });
    };
  }

  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.href || '';
    if (this.hasAttribute('download') && href.indexOf('blob:') === 0) {
      var self = this;
      fetch(href).then(function (r) { return r.blob(); })
        .then(function (b) { return b.arrayBuffer().then(function (buf) {
          emit({ suite: 'saved', app: APP, name: self.getAttribute('download') || 'archivo', mime: b.type, bytes: buf });
        }); })
        .catch(function (e) { emit({ suite: 'error', error: String(e) }); });
      return;
    }
    return originalClick.apply(this, arguments);
  };

  // ============ ABRIR ============
  var pending = null;   // { name, bytes }

  function fakeFile() {
    return new File([pending.bytes], pending.name, { type: '' });
  }

  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (e.origin !== location.origin) return;
    if (d.suite === 'open') {
      pending = { name: d.name, bytes: new Uint8Array(d.bytes) };
      emit({ suite: 'open-armed', app: APP, name: d.name });
    }
  });

  if (window.showOpenFilePicker) {
    window.showOpenFilePicker = function () {
      if (!pending) return Promise.reject(new Error('No hay documento pendiente'));
      var f = fakeFile();
      return Promise.resolve([{
        kind: 'file', name: pending.name,
        getFile: function () { return Promise.resolve(f); },
        queryPermission: function () { return Promise.resolve('granted'); },
        requestPermission: function () { return Promise.resolve('granted'); },
        isSameEntry: function () { return Promise.resolve(false); },
      }]);
    };
  }

  var originalInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file' && pending) {
      try {
        var dt = new DataTransfer();
        dt.items.add(fakeFile());
        this.files = dt.files;
      } catch (err) { /* el navegador puede bloquearlo */ }
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    return originalInputClick.apply(this, arguments);
  };

  emit({ suite: 'ready', app: APP });
})();
</script>`;

module.exports = { SHIM };