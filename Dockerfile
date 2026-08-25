# ---- build stage -----------------------------------------------------------
# Dev dependencies (TypeScript) exist only here, so they never reach the image
# that runs in production.
FROM node:24-alpine AS build

WORKDIR /app

# Manifests first, so the dependency layer is cached across code changes.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- production dependencies ----------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

# dumb-init reaps zombies and, more importantly, forwards SIGTERM to node so
# the graceful shutdown in server.ts actually runs on `docker stop`.
RUN apk add --no-cache dumb-init

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db ./db

# Never run the app as root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
