# Expects .docker-build/ to be prepared by scripts/prepare-docker-build.mjs
# (or via: npm run docker:prepare). This directory contains production-ready
# node_modules and compiled dist output.
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    apache2-utils \
    fontconfig \
    fonts-noto-cjk \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY .docker-build/package.json ./package.json
COPY .docker-build/package-lock.json ./package-lock.json
COPY .docker-build/node_modules ./node_modules
COPY .docker-build/dist ./dist

RUN mkdir -p /app/logs && chown node:node /app/logs

USER node
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["sh", "-c", "exec node dist/src/index.js 2>&1 | rotatelogs -e -l /app/logs/%Y-%m-%d.log 86400"]
