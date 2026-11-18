ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
WORKDIR /app

# Copy manifests first so dependency installation remains cacheable.  The
# build must receive NODE_IMAGE as an immutable, previously verified digest.
COPY package.json package-lock.json tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY workers/codex-bridge/package.json workers/codex-bridge/package.json
COPY workers/ingestion/package.json workers/ingestion/package.json
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && rm -rf apps/web/.next/cache \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# The web server bundle is built by Next, while ingestion and migrations use
# the shared domain sources.  No .env, model, test, Harmony or local-media
# files enter the runtime image.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build /app/db ./db
COPY --from=build /app/workers/ingestion ./workers/ingestion

RUN mkdir -p /data/media && chown node:node /data/media
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
