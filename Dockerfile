# KT bizmeka EZ MCP — remote HTTP server (OAuth 2.1 + Postgres).
#
# Runs the TypeScript source directly on the Bun runtime (NOT a --compile
# binary): the db backend loads the `postgres` driver dynamically, and running
# on the full runtime avoids any single-binary bundling surprises with the
# driver. The local stdio `exe` is still produced separately via `bun run build`.
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1.3 AS runtime
WORKDIR /app

# App + deps
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Remote service defaults. STORAGE=db turns on the OAuth Authorization Server.
# DATABASE_URL, MASTER_KEY and PUBLIC_URL are injected at deploy time (dokploy).
ENV MCP_TRANSPORT=http \
    STORAGE=db \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000 \
    NODE_ENV=production

# Run as the non-root user the Bun image ships with.
USER bun

# Dokploy/Traefik routes by domain; only expose, never bind host ports.
EXPOSE 8000

# Container-level healthcheck hits the unauthenticated /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun --eval "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
