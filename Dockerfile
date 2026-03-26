FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY .docker-build/package.json ./package.json
COPY .docker-build/package-lock.json ./package-lock.json
COPY .docker-build/node_modules ./node_modules
COPY .docker-build/dist ./dist

CMD ["node", "dist/src/index.js"]
