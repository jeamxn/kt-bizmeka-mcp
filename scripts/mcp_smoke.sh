#!/usr/bin/env bash
# Drive an MCP stdio server through initialize + tools/list and print the result.
# Usage: mcp_smoke.sh <command> [args...]
set -euo pipefail

req_init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
notif_inited='{"jsonrpc":"2.0","method":"notifications/initialized"}'
req_tools='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
req_man='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"bizmeka_man","arguments":{}}}'

printf '%s\n%s\n%s\n%s\n' "$req_init" "$notif_inited" "$req_tools" "$req_man" | "$@"
