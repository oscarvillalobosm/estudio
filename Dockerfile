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
ARG APP_TITLE="Estudio"
ENV NODE_ENV=production

RUN apk add --no-cache curl unzip

WORKDIR /app
RUN mkdir -p /app/public/apps

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
    rm -rf /tmp/app.zip /tmp/x

# Sin dependencias npm: no hace falta install, el build es instantaneo.
COPY package.json ./
COPY src ./src
COPY public/login.html public/home.html public/app.html ./public/
COPY public/admin.html public/invitacion.html ./public/

ENV DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]