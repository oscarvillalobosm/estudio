# Estudio

Suite de herramientascreative en el navegador: cinco aplicaciones, una cuenta por
usuario, y guardado en la nube o en el equipo.

Cada aplicación es un proyecto open source independiente compilado a WebAssembly:

| App | Upstream | Formato | Puente |
|---|---|---|---|
| Hojas de cálculo | [GridCraft](https://github.com/storytold/gridcraft) | `.xlsx` | nativo |
| Documentos | [WordCraft](https://github.com/storytold/wordcraft) | `.docx` | shim |
| PDF | [PdfCraft](https://github.com/storytold/pdfcraft) | `.pdf` | shim |
| Imagen | [PhotoCraft](https://github.com/storytold/photocraft) | `.psd` | shim |
| Vectorial | [VectorCraft](https://github.com/storytold/vectorcraft) | `.vectorcraft` | shim |

## Cómo funciona la integración

Ninguna de las cinco (salvo GridCraft) trae forma de conectar con un servidor: todas
guardan en el disco del usuario mediante la File System Access API. La solución es un
**shim** que el servidor inyecta en el `index.html` de cada app antes de enviarla:

- Intercepta `window.showSaveFilePicker` y devuelve un manejador de archivos falso cuyo
  `createWritable()` acumula los bytes y los manda a la página host por `postMessage`.
- También cubre la descarga por blob (`<a download>`) y el `<input type="file">` de apertura.
- Para abrir, intercepta `showOpenFilePicker` y le devuelve a la app un `File` con los
  bytes que estaban en el servidor.

La app cree que está trabajando en disco. En realidad nos entrega —o recibe— el archivo.

**No hay ningún fork del código upstream.** Solo reescribimos el HTML que ya servíamos.

## Requisitos

Node.js 20 o superior. **Sin dependencias de npm**: todo usa módulos nativos, así que no
hay `npm install`.

## Desarrollo local

Las builds web se descargan de los releases oficiales, no se compilan:

```sh
cd gridcraft-cloud
node src/server.js adduser tuusuario tuclave
node src/server.js
```

Abre <http://127.0.0.1:3000>.

Para actualizar una app basta con bajar su zip a `public/apps/<id>/`.

## Despliegue en Coolify

1. Sube esta carpeta a un repositorio de GitHub. El `.gitignore` ya excluye las builds
   web y los datos.

2. En Coolify: **New Resource → Application → Docker Compose**, apunta al repo.

3. Variables de entorno:

   ```
   SESSION_SECRET = <cadena larga y aleatoria>   # OBLIGATORIA
   ADMIN_USER     = <usuario inicial>
   ADMIN_PASSWORD = <clave inicial>
   APP_TITLE      = <nombre de tu suite>
   ```

   `ADMIN_USER` / `ADMIN_PASSWORD` solo se usan cuando no hay ningún usuario todavía.
   Para crear más después:
   `docker compose exec app node src/server.js adduser <user> <pass>`

4. **Declara un volumen montado en `/data`.** Sin él pierdes todos los documentos en
   cada redeploy.

5. En el dominio, activa **HTTPS** y pon `FORCE_SECURE=1` para que las cookies viajen
   con la marca `Secure`.

## Cuentas y registro

La pantalla de entrada tiene dos pestañas: **Entrar** y **Crear cuenta**. La pestaña de
registro aparece o se esconde según el modo, para que un despliegue público no se llene
de cuentas basura sin que el primer usuario quede encerrado sin forma de entrar:

| Modo | Cómo se activa | Comportamiento |
|---|---|---|
| `first` | Por defecto | Solo puede registrarse quien llegue a una instancia vacía. Al crearse la cuenta, la pestaña desaparece. |
| `open` | `ALLOW_REGISTRATION=1` | Cualquiera puede crear su cuenta. |
| `closed` | `REGISTRATION_MODE=closed` | Nadie. Las cuentas las crea un administrador por consola. |

El nombre de usuario admite de 3 a 32 caracteres: minúsculas, dígitos, `-` y `_`. Se
valida antes de tocar el disco porque forma parte de la ruta donde se guardan los
documentos. La contraseña necesita 8 caracteres o más.

Hay un freno anti-abuso: 5 cuentas creadas por IP cada 10 minutos. Solo cuentan las
cuentas que de verdad se crean, no los errores de validación, para que escribir mal la
contraseña cinco veces no bloquee a nadie.

Si prefieres dar de alta a la gente tú mismo en lugar de dejar que se auto-sirvan, usa
`REGISTRATION_MODE=closed` y crea cada cuenta con `adduser`.

### El panel de administración

En `/admin` un administrador ve las cuentas y las invitaciones. Desde ahí puede:

- **crear una cuenta** directamente, sin abrir el registro público;
- **cambiar la contraseña** de cualquiera;
- **dar o quitar el rol de administrador**, con la salvedad de que el servidor nunca se
  queda sin uno: sin administración no hay forma de recuperar el acceso;
- **eliminar una cuenta** (nunca la propia, ni la última administradora);
- **emitir una invitación** con un enlace de un solo uso y siete días de validez.

La primera cuenta que se crea es administradora. Si el servidor se queda sin
administradores, la siguiente cuenta que se cree hereda el rol.

Las invitaciones se envían por correo si hay SMTP configurado (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, y opcionalmente `SMTP_FROM_NAME`, `SMTP_HELO` y
`SMTP_INSECURE`). **Si no hay SMTP la invitación se genera igual** y aparece el enlace para
compartirlo a mano: un correo que no sale nunca pierde la invitación.

La lista de cuentas nunca incluye el hash ni la sal, ni para el propio administrador.

### Sesión por token

El navegador recibe una cookie `session` (HttpOnly, SameSite=Strict). El cliente de
escritorio no tiene almacén de cookies, así que `POST /api/token` devuelve ese mismo
token en el cuerpo y el cliente lo manda en cada petición como
`Authorization: Bearer <token>`.

No es una vía con más permisos: el servidor acepta cookie o cabecera y las dos pasan por
la misma verificación. Lo que `/api/token` no hace es emitir cookie, para que el token no
acabe también en el navegador.

## Notas de diseño

- **Las builds web se descargan en la imagen**, no se compilan. El Dockerfile baja el zip
  de cada release, así que el build tarda segundos y las versiones quedan fijadas por
  build arg (`GRIDCRAFT_VERSION`, etc.).
- **Cada app debe servirse en su propio `index.html` reescrito** y con las cabeceras de
  caché correctas: el `.wasm` es inmutable con hash, el `index.html` nunca.
- **El iframe debe ser del mismo origen** que la página host; por eso todo vive en el
  mismo contenedor.
- **Los archivos en disco se nombran por UUID**, nunca con el nombre que elige el
  usuario. El nombre es solo metadato, lo que elimina el path traversal por construcción.
- **Las rutas se validan en dos capas**: UUID estricto *y* comprobar que la ruta resuelta
  siga dentro de la carpeta del usuario.
- **Una carpeta no puede moverse dentro de sí misma ni de una de sus hijas**, para que el
  árbol no genere ciclos.
- **No se borra una carpeta con contenido**: hay que vaciarla primero.
- La marca de cada proyecto upstream (logos, nombre en la pestaña) se retira al arrancar
  el servidor, según los términos de marca de cada uno.

## Material de terceros

VectorCraft empaqueta fuentes bajo **SIL Open Font License 1.1** (Noto, Shippori Mincho,
y otras). La OFL permite empaquetar pero **exige atribución**: incluye esos créditos en
tu distributions. Las otras cuatro apps no incluyen material de terceros.

## Licencia

El código de esta aplicación es tuyo. Los motores vienen de los proyectos upstream, bajo
MIT OR Apache-2.0.
