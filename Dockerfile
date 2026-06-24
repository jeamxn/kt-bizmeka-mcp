# KT bizmeka EZ MCP server
FROM python:3.12-slim

# uv: fast, reproducible installs from pyproject + uv.lock
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (cached layer) using only manifests
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-install-project --no-dev

# Now copy the source and install the project itself
COPY src ./src
RUN uv sync --frozen --no-dev

# Deployed as a long-running HTTP service. stdio transport exits on stdin EOF
# (which makes a bare container restart-loop), so default to streamable-http here.
ENV MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000

# Dokploy/Traefik routes by domain; only expose, do not bind host ports.
EXPOSE 8000

ENTRYPOINT ["uv", "run", "--no-sync", "kt-bizmeka-mcp"]
