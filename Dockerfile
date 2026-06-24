# KT bizmeka EZ MCP server — stdio transport
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

# MCP servers speak over stdio; keep the process in the foreground.
ENTRYPOINT ["uv", "run", "--no-sync", "kt-bizmeka-mcp"]
