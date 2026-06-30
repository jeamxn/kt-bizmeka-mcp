# KT bizmeka EZ MCP server — Bun standalone binary
# Build the linux binary in a Bun image, then run it on a tiny base with no
# runtime installed (the binary embeds Bun).
FROM oven/bun:1.3 AS build
WORKDIR /app

# Install deps first (cached layer) using only manifests
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Build the standalone binary for the image's architecture
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p dist && \
    bun build src/server.ts --compile --minify --outfile dist/kt-bizmeka-mcp

# --- runtime: distroless-ish, just glibc; the binary brings its own runtime ---
FROM debian:bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/dist/kt-bizmeka-mcp /usr/local/bin/kt-bizmeka-mcp

# Deployed as a long-running HTTP service. stdio transport exits on stdin EOF
# (which makes a bare container restart-loop), so default to streamable-http here.
ENV MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000

# Dokploy/Traefik routes by domain; only expose, do not bind host ports.
EXPOSE 8000

ENTRYPOINT ["kt-bizmeka-mcp"]
