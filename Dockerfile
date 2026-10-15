# Las aplicaciones se descargan ya compiladas desde el release oficial de
# cada proyecto upstream. No hay que compilar Rust en la imagen.
#
# Se fija la version por app para poder actualizar una sin tocar las demas.
FROM node:22-alpine

ARG GRIDCRAFT_VERSION=0.7.0
ARG WORDCRAFT_VERSION=0.7.0
ARG PDFCRAFT_VERSION=0.8.0
ARG PHOTOCRAFT_VERSION=0.9.0
ARG VECTORCRAFT_VERSION=0.11.0
ARG CADCRAFT_VERSION=0.7.0
# DeckCraft se sirve desde el release del upstream igual que las demas: el repo propio de Oscar
# (`oscarvillalobosm/deckcraft`) todavia no publica releases, y la build web que usa el navegador
# no lleva la nube de escritorio, asi que aqui solo aporta la suite.
ARG DECKCRAFT_VERSION=0.7.0

# Las apps de escritorio para Windows. No son las de arriba: las de aqui llevan la nube de
# Estudio, que las builds del upstream no tienen. Salen de los assets de un release de este
# mismo repo, con un tag por build de la suite.
#
# A diferencia de `fetch_app`, **que aqui SI puede fallar sin tumbar el despliegue**: si un
# ejecutable no llega —porque el release no existe todavia, o porque GitHub devuelve algo raro
# y deja un archivo a medias— la pagina de descargas deja de ofrecerlo y el resto de la suite
# entra igual. Un despliegue caido por un binario de 80 MB que todavia no se ha subido es
# justo el fallo caro de evitar.
ARG ESCRITORIO_REPO=oscarvillalobosm/estudio
ARG ESCRITORIO_TAG=escritorio-2026-10-15
ARG APP_TITLE="Estudio"
ENV NODE_ENV=production

RUN apk add --no-cache curl unzip

WORKDIR /app
RUN mkdir -p /app/public/apps /app/public/escritorio

# Cada build es un sitio estatico con URLs relativas: funciona bajo cualquier prefijo.
RUN set -eux; \
    fetch_app() { \
      app="$1"; ver="$2"; \
      curl -fsSL -o /tmp/app.zip \
        "https://github.com/storytold/${app}/releases/download/v${ver}/${app}-web-${ver}.zip"; \
      mkdir -p "/tmp/x/${app}"; \
      unzip -q /tmp/app.zip -d "/tmp/x/${app}"; \
      inner=$(find "/tmp/x/${app}" -mindepth 1 -maxdepth 1 -type d | head -1); \
      mkdir -p "/app/public/apps/${app}"; \
      if [ -n "$inner" ]; then mv "$inner"/* "/app/public/apps/${app}/"; \
      else mv "/tmp/x/${app}"/* "/app/public/apps/${app}/"; fi; \
      test -f "/app/public/apps/${app}/index.html"; \
    }; \
    fetch_app gridcraft   "${GRIDCRAFT_VERSION}"; \
    fetch_app wordcraft   "${WORDCRAFT_VERSION}"; \
    fetch_app pdfcraft    "${PDFCRAFT_VERSION}"; \
    fetch_app photocraft  "${PHOTOCRAFT_VERSION}"; \
    fetch_app vectorcraft "${VECTORCRAFT_VERSION}"; \
    fetch_app cadcraft   "${CADCRAFT_VERSION}"; \
    fetch_app deckcraft   "${DECKCRAFT_VERSION}"; \
    rm -rf /tmp/app.zip /tmp/x

# Los ejecutables de escritorio. `curl -f` falla en un 404, y una descarga cortada deja un
# archivo que parece bueno pero no lo es: por eso se pide el codigo, se mira que sea 200 y se
# comprueba que el tamano no sea cero antes de darlo por bueno. Lo que no pase el filtro se
# borra y se sigue.
RUN set -eu; \
    fetch_desktop() { \
      app="$1"; \
      out="/app/public/escritorio/${app}.exe"; \
      code=$(curl -sSL --retry 3 --retry-delay 2 --max-time 900 \
             -w '%{http_code}' -o "$out" \
             "https://github.com/${ESCRITORIO_REPO}/releases/download/${ESCRITORIO_TAG}/${app}.exe" \
             || echo 000); \
      if [ "$code" = "200" ] && [ -s "$out" ]; then \
        echo "escritorio ${app}: $(wc -c < "$out") bytes"; \
      else \
        echo "escritorio ${app}: no disponible (HTTP ${code}), la pagina lo omite"; \
        rm -f "$out"; \
      fi; \
    }; \
    for app in gridcraft wordcraft pdfcraft deckcraft; do fetch_desktop "$app"; done

# Sin dependencias npm: no hace falta install, el build es instantaneo.
COPY package.json ./
COPY src ./src
COPY public/login.html public/home.html public/app.html ./public/
COPY public/admin.html public/invitacion.html public/descargas.html ./public/

ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]