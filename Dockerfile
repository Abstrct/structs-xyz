# syntax=docker/dockerfile:1
# Structs XYZ: the built client, served by server/serve.mjs (static files only, no dependencies).
# The page talks to the chain and to each guild directly.
#
#   docker build -t structs-xyz .
#   docker run --rm -p 8080:8080 structs-xyz                    # → http://localhost:8080
#
# VITE_* settings are baked into the client at build time (pass them with --build-arg).

ARG NODE_VERSION=24
ARG PNPM_VERSION=9.15.9

# ── Build the client ────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Endpoints the client talks to directly; unset means the defaults in src/ (the public testnet).
ARG VITE_LCD_URL
ARG VITE_RPC_URL
ARG VITE_RPC_WS_URL
ARG VITE_GRASS_URL
ARG VITE_DEFAULT_GUILD
# Where the site is published (canonical links, Open Graph, sitemap); default https://structs.xyz.
ARG VITE_SITE_URL
RUN pnpm build

# ── Run ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --chown=node:node server ./server
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/serve.mjs"]
