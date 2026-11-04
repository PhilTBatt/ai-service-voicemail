# API image. Node runs the TypeScript source directly (decision 001), so there's no build step.
# Debian slim rather than Alpine, to match the glibc-based systems Azure runs.
FROM node:26-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependency manifests first: this layer (and the slow npm ci) is reused from cache until
# a package.json or the lockfile changes. Every workspace's package.json is needed, or
# npm ci rejects the lockfile as out of sync.
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --workspace @callmate/api && npm cache clean --force

COPY packages/shared/src packages/shared/src
COPY apps/api/src apps/api/src

# Files stay owned by root, so the app (running as the unprivileged node user) can read
# its code but not change it.
USER node
EXPOSE 3000

# node directly, not npm start: npm doesn't reliably pass SIGTERM on, which would skip
# graceful shutdown and cut off in-flight requests on every deploy.
CMD ["node", "apps/api/src/server.ts"]
