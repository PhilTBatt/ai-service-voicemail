# check=skip=SecretsUsedInArgOrEnv
# (Docker only reads that directive on the first line. Its linter flags any ARG with "KEY" in
# its name as a secret; the only one here is Clerk's publishable key, public by design.)

# One image for the whole service (BUILD_PLAN Step 8): the API (which also serves the built
# dashboard), the worker, and the migration job all run it, each with its own command:
#   API        node apps/api/src/server.ts   (the default, below)
#   worker     node apps/api/src/worker.ts
#   migrations dbmate --env MIGRATION_DATABASE_URL --migrations-dir apps/api/src/db/migrations --no-dump-schema up
# Node runs the TypeScript source directly (decision 001), so the API has no build step; only
# the dashboard is built. Debian slim rather than Alpine, to match the glibc-based systems
# Azure runs.

# ─── Build: the dashboard, and the migration tool. Dev dependencies live only here. ────────
FROM node:26-slim AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared/src packages/shared/src
COPY apps/web apps/web
# Clerk's publishable key is public by design (decision 012): Vite writes it into the page.
# Every secret stays out of the build; the running container gets them from Key Vault.
ARG CLERK_PUBLISHABLE_KEY
ENV CLERK_PUBLISHABLE_KEY=${CLERK_PUBLISHABLE_KEY}
RUN test -n "${CLERK_PUBLISHABLE_KEY}" || (echo "CLERK_PUBLISHABLE_KEY build arg is required" && exit 1)
RUN npm run build --workspace @callmate/web

# dbmate is a dev dependency with a binary per platform; keep just the binary for this one.
RUN cp "$(node --input-type=module -e "import { resolveBinary } from 'dbmate'; console.log(resolveBinary())")" /usr/local/bin/dbmate

# ─── Run ──────────────────────────────────────────────────────────────────────────────────
FROM node:26-slim

# Links the published image to its repository on GitHub (decision 016).
LABEL org.opencontainers.image.source=https://github.com/PhilTBatt/ai-service-voicemail

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
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /usr/local/bin/dbmate /usr/local/bin/dbmate

# The API serves the built dashboard at / (config.ts DASHBOARD_DIST).
ENV DASHBOARD_DIST=/app/apps/web/dist

# The commit this image is built from (the Deploy workflow passes it): /readyz and the worker's
# check-in report it, so the release check can tell the new build from the old. Late in the
# file, so a new commit doesn't throw away the cached layers above.
ARG APP_VERSION
ENV APP_VERSION=${APP_VERSION}

# Files stay owned by root, so the app (running as the unprivileged node user) can read
# its code but not change it.
USER node
EXPOSE 3000

# node directly, not npm start: npm doesn't reliably pass SIGTERM on, which would skip
# graceful shutdown and cut off in-flight requests on every deploy.
CMD ["node", "apps/api/src/server.ts"]
