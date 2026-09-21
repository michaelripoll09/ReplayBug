# syntax=docker/dockerfile:1.19
# Build all workspace packages from source. COPY exclusions ensure a local build
# never reuses host node_modules, dist output, Next output, or environment files.
FROM node:24-alpine AS workspace

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.17.0 --activate

COPY --exclude=**/node_modules --exclude=**/dist --exclude=**/.next --exclude=.env --exclude=.env.* --exclude=**/.env --exclude=**/.env.* --exclude=.git . .
RUN pnpm install --frozen-lockfile && chown -R node:node /workspace
USER node

FROM workspace AS api-build
RUN pnpm turbo run build --filter=@replaybug/api...
RUN pnpm --filter=@replaybug/api --prod deploy --legacy /workspace/deploy/api

FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=api-build --chown=node:node /workspace/deploy/api ./
USER node
EXPOSE 4001
CMD ["node", "dist/server.js"]

FROM workspace AS worker-build
RUN pnpm turbo run build --filter=@replaybug/worker...
RUN pnpm --filter=@replaybug/worker --prod deploy --legacy /workspace/deploy/worker

FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=worker-build --chown=node:node /workspace/deploy/worker ./
USER node
CMD ["node", "dist/index.js"]

FROM workspace AS web-build
ARG NEXT_PUBLIC_REPLAYBUG_API_URL=http://localhost:4001
ENV NEXT_PUBLIC_REPLAYBUG_API_URL=${NEXT_PUBLIC_REPLAYBUG_API_URL}
RUN pnpm turbo run build --filter=@replaybug/web...
RUN pnpm --filter=@replaybug/web --prod deploy --legacy /workspace/deploy/web

FROM node:24-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=web-build --chown=node:node /workspace/deploy/web ./
USER node
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000"]

FROM workspace AS demo-build
ARG VITE_REPLAYBUG_DSN=
ARG VITE_REPLAYBUG_ENVIRONMENT=production
ENV VITE_REPLAYBUG_DSN=${VITE_REPLAYBUG_DSN}
ENV VITE_REPLAYBUG_ENVIRONMENT=${VITE_REPLAYBUG_ENVIRONMENT}
RUN pnpm turbo run build --filter=@replaybug/demo...

FROM nginxinc/nginx-unprivileged:1.27-alpine AS demo
COPY docker/nginx-demo.conf /etc/nginx/conf.d/default.conf
COPY --from=demo-build --chown=101:101 /workspace/apps/demo/dist /usr/share/nginx/html
EXPOSE 8080
