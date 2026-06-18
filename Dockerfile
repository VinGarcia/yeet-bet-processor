# syntax=docker/dockerfile:1

# --- Stage 1: build ---
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
# pnpm 11 exits non-zero when a devDep (esbuild/ssh2/...) has an unapproved
# build script; allow them here since this build stage is thrown away and the
# runtime --prod install pulls none of those packages.
RUN pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# --- Stage 2: runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist

CMD ["node", "dist/apps/api/main.js"]
