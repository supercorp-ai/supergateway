#!/bin/bash
set -e
F=/home/lumen/.npm-global/lib/node_modules/supergateway/dist/gateways/stdioToStatelessStreamableHttp.js
[ -f "$F.prepatch.bak" ] || cp -a "$F" "$F.prepatch.bak"
patch "$F" < "$(dirname "$0")/stateless-reliability.dist.patch"
node --check "$F" && sudo systemctl restart desktop-commander-mcp
