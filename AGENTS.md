# AGENTS.md — Estudio (suite de herramientas web)

Documento de referencia del proyecto. Léelo antes de tocar código.

## Qué es este proyecto

Una suite web con cinco herramientas de creación, cada una embebida en el navegador y
guardada en un servidor con cuentas de usuario. No es un clon de nada: cada app es un
proyecto open source independiente compilado a WebAssembly, y aquí se integran.

| App | Upstream | Formato | Puente |
|---|---|---|---|
| Hojas de cálculo | storytold/gridcraft | `.xlsx` | nativo |
| Documentos | storytold/wordcraft | `.docx` | shim |
| PDF | storytold/pdfcraft | `.pdf` | shim |
| Imagen | storytold/photocraft | `.psd` | shim |
| Vectorial | storytold/vectorcraft | `.vectorcraft` | shim |

Fuera de alcance por ahora: FilmCraft (video, inviable en una pestaña por el límite de
memoria del navegador) y LightCraft (biblioteca de fotos, otro modelo de producto).

## El punto clave del diseño: el shim

**Solo GridCraft trae puente de servidor.** Las otras cuatro guardan en el disco del
usuario mediante la File System Access API. Se comprobó una por una que las cuatro usan
exactamente el mismo mecanismo.

La solución, en `src/shim.js`:

1. El servidor reescribe el `index.html` de cada app al servirla: quita el `<title>`, el
   favicon con la marca, e inyecta el shim antes de `</head>`.
2. El shim corre **en el mismo origen** que la página host (requisito: el iframe no puede
   ser de otro origen).
3. Intercepta `window.showSaveFilePicker` y devuelve un `FileSystemFileHandle` falso cuyo
   `createWritable()` acumula los `write()` y en `close()` manda los bytes por
   `postMessage`.
4. Para abrir, intercepta `showOpenFilePicker` y devuelve un handle cuyo `getFile()` da un
   `File` construido con los bytes del servidor.

**No hay ningún fork del código upstream.** Ese es el motivo de que esto sea mantenible:
no hay conflictos de rebase contra proyectos que sacan releases cada semana.

Si añades una sexta app, el flujo es: bajar su zip a `public/apps/<id>/`, añadir una
entrada a `src/apps.js`, y listo. Si usa otro mecanismo de guardado, ampliar el shim.

## Verificado empíricamente (no asumir)

Guardado capturado y validado por número mágico:

- `.docx` → `PK\x03\x04` + `word/document.xml`
- `.pdf`  → `%PDF-1.7`
- `.psd`  → `8BPS`
- `.vectorcraft` → JSON `{ "format": "v…`
- `.xlsx` → puente nativo

Apertura probada con ciclo completo en WordCraft: guardar → recargar → abrir → recuperar.

**Antes de dar por buena cualquier app nueva, pruébala así.** Es exactamente como se
descubrieron las dos vías de guardado (el shim original solo interceptaba `<a download>` y
falló con WordCraft, que usa `showSaveFilePicker`).

## Trampas del código — no repetirlas

1. **`path.resolve(BASE, '/x')` descarta BASE.** Node resuelve de derecha a izquierda; si
   ve un argumento que empieza por `/` busca en la raíz del disco. Quitar la barra
   inicial antes de resolver. Esto hizo que *todos* los archivos estáticos dieran 404 sin
   que se notara.
2. **Una petición de directorio (`/app/`) hay que terminarla en `index.html` a mano.**
   `fs.existsSync(dir)` es true pero `isFile()` es false.
3. **No asignar `iframe.src` dentro del manejador de `ready`.** Recarga el iframe, que
   vuelve a anunciar que está listo → bucle infinito, pantalla parpadeando.
4. **eframe en WASM mide el canvas al arrancar y no reacciona a cambios de contenedor.**
   Hace falta `ResizeObserver` + un `Event('resize')` sintético dentro del iframe.
5. **`is_secret_param` del upstream solo filtra `password`/`*Password`.** Si algún día se
   pasa un token por un comando, se escribiría en claro en el journal.

## Seguridad — invariantes

- **`/api/` y `/apps/` exigen sesión.** Si se olvida `/apps/`, cualquiera entra por URL
  directa y usa el editor sin cuenta (bypass de pago). Fue un bug real.
- **Los archivos en disco se nombran por UUID**, nunca con el nombre del usuario. El
  nombre es solo metadato → el path traversal desaparece por construcción.
- **Validación en dos capas**: UUID estricto *y* comprobar que la ruta resuelta siga
  dentro de la carpeta del usuario (`file.startsWith(root + path.sep)`).
- **Una carpeta no puede moverse dentro de sí misma ni de una de sus hijas**, para que el
  árbol no genere ciclos.
- **No se borra una carpeta con contenido**: se rechaza con 409.
- Contraseñas con `scrypt`; cookie de sesión firmada con HMAC; comparación en tiempo
  constante; mismo mensaje para usuario inexistente y clave incorrecta.

## Rendimiento

- Las builds suman ~178 MB de WASM sin comprimir. **gzip los deja en ~69 MB** (61%). El
  `src/server.js` lo comprime y **cachea el resultado en memoria**: sin caché, VectorCraft
  costaba 1325 ms por petición; con caché, 181 ms.
- Los `.wasm` y `.js` llevan hash de contenido → `Cache-Control: immutable`. El
  `index.html` va `no-store` porque se reescribe en cada arranque.
- El launcher **no carga ninguna app**; el WASM solo se descarga al abrir una app.

## Cómo trabajar aquí

```sh
node src/server.js adduser <usuario> <clave>   # crear cuenta
node src/server.js                             # arrancar en :3000
```

Sin dependencias npm: no hay `npm install`. Todo usa módulos nativos de Node 20+.

Para actualizar una app: bajar su zip del release oficial a `public/apps/<id>/` y
reiniciar. Las versiones se fijan por build arg en el Dockerfile
(`GRIDCRAFT_VERSION`, `WORDCRAFT_VERSION`, …).

## Trampa: `fetch_app` en el Dockerfile fallaba en imagen limpia

El despliegue en Coolify moria siempre en el paso 5/8, el `RUN` que descarga las
cinco builds. La causa era una sola palabra: en la rama que aplana la carpeta interna
del zip, el `mv` iba a `/app/public/apps/${app}/` sin haber creado ese directorio. La
otra rama si lo creaba, y como en local `public/apps/<id>/` ya existia, nunca se
noto. En una imagen limpia el `mv` falla con exit code 1 y se cae el build entero.

**Por que no se detecta antes:** el sintoma (el deploy falla) no se parece nada a la
causa (falta un `mkdir`). Sin la traza de `set -eux` es indescifrable.

## Trampa: la cola de Coolify NO estaba bloqueada

Se diagnostico durante horas como "la cola no procesa los trabajos" porque se
consultaba `GET /api/v1/applications/{uuid}/deployments`, que devuelve **404**. Un 404
se lee como "no hay registros" y se concluyo que la cola estaba muerta.

La ruta correcta es `GET /api/v1/deployments` (global). Y de las rutas de despliegue,
`POST /api/v1/applications/{uuid}/deploy` **da 404 en Coolify 4.4.2**; las que funcionan
son `POST .../start` y `POST .../restart`.

**Regla:** un 404 en una API de panel no significa "vacio", significa "ruta equivocada".
Comprobar la lista global antes de declarar algo bloqueado.

## Trampa: el voto anti-abuso no puede contar los errores de validacion

El registro limita a 5 cuentas creadas por IP cada 10 minutos. La primera version contaba
toda peticion a `/api/register`, y las pruebas loDetectaron al instante: seis rechazos por
validacion (contrasena corta, nombre con espacios, `../../etc`...) agotaban el cupo y el
usuario que al final tecleaba bien recibia 429 y se quedaba sin poder registrarse nunca.

El criterio correcto: **lo caro es scrypt, asi que se cuentan las cuentas que se crean de
verdad, no los mensajes de error.** Por eso `Auth.create()` esta partido en dos:
`checkCreatable()` valida formato y disponibilidad sin hashear, y `_insert()` es la unica
que paga el scrypt. El servidor comprueba primero y aplica el freno despues.

Relacionado: `Auth.create()` sigue existiendo para el CLI y el bootstrap, y llama a las dos
mitades. Si anades otra forma de dar de alta usuarios, no te saltes `checkCreatable()`.

## La sesion viaja en cookie o en cabecera, y son la misma

El navegador lleva la cookie `session` (HttpOnly, SameSite=Strict). El cliente nativo de
escritorio no tiene almacen de cookies, asi que `POST /api/token` devuelve el mismo token en
el cuerpo y el cliente lo presenta en `Authorization: Bearer`.

**No es una via con mas permisos.** `currentUser()` acepta las dos y las dos pasan por el
mismo `auth.verifyToken()`. La cabecera es solo otro transporte del mismo token.

Dos cosas que no se deben romper:

- **`/api/token` no emite cookie.** Si lo hiciera, el token acabaria tambien en el almacen
  del navegador, que es justo lo que un cliente nativo no puede usar pero un navegador si.
- **El token nunca vuelve en la respuesta de un comando.** En el cliente de escritorio viaja
  al lado del resultado y solo `poll()` decide que se le cuenta al motor.

## Riesgos conocidos

- **Los cinco proyectos upstream están en alpha y sacan releases diarios.** Funcionan hoy
  porque el Dockerfile fija versiones. Al actualizar, probar de verdad: no hay CI.
- **Los motores no han sido validados con archivos reales y complejos.** El puente
  funciona; que los cálculos y los formatos sobrevivan a un documento de producción es
  otra pregunta, y sigue sin respuesta.
- **VectorCraft pesa 62 MB de WASM** y trae fuentes bajo OFL: exige atribución al
  distribuir. Las otras cuatro no incluyen material de terceros.
- **La marca de cada upstream debe retirarse** al publicar (logos, `<title>`,
  favicon, nombre en el ribbon). La licencia de código lo permite; la de marca no.

## Licencia

El código de esta aplicación es libre. Los motores vienen de los proyectos upstream bajo
MIT OR Apache-2.0. Consulta la marca de cada uno antes de publicar.
