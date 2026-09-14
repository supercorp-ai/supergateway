#!/bin/bash
set -e
F=/home/lumen/.npm-global/lib/node_modules/supergateway/dist/gateways/stdioToStatelessStreamableHttp.js
cp -a "$F.prepatch.bak" "$F" && sudo systemctl restart desktop-commander-mcp
