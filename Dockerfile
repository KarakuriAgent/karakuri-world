# Expects .docker-build/ to be prepared by scripts/prepare-docker-build.mjs
# (or via: npm run docker:prepare). This directory contains production-ready
# node_modules and compiled dist output.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY .docker-build/package.json ./package.json
COPY .docker-build/package-lock.json ./package-lock.json
COPY .docker-build/node_modules ./node_modules
COPY .docker-build/dist ./dist

USER node
CMD ["node", "dist/src/index.js"]
