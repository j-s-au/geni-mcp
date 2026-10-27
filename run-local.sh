#!/usr/bin/env bash
# Starts the Geni MCP server over stdio with settings from ~/.config/geni-mcp/env.
set -euo pipefail
ENV_FILE="${GENI_ENV_FILE:-$HOME/.config/geni-mcp/env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
exec node "$(dirname "$(readlink -f "$0")")/dist/index.js"
