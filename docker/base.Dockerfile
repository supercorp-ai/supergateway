FROM node:24.21.0-alpine@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2

ARG VERSION
ARG PACKAGE_SHA256
COPY .release/supergateway.tgz /tmp/supergateway.tgz
# Install the exact gateway artifact; resolve its production dependencies normally.
RUN test -n "$VERSION" && test -n "$PACKAGE_SHA256" \
    && echo "$PACKAGE_SHA256  /tmp/supergateway.tgz" | sha256sum -c - \
    && mkdir -p /usr/local/lib/node_modules/supergateway \
    && tar -xzf /tmp/supergateway.tgz --strip-components=1 -C /usr/local/lib/node_modules/supergateway \
    && cd /usr/local/lib/node_modules/supergateway \
    && node -e 'if (require("./package.json").version !== process.argv[1]) process.exit(1)' "$VERSION" \
    && npm install --omit=dev --ignore-scripts --engine-strict --no-audit --no-fund \
    && ln -s /usr/local/lib/node_modules/supergateway/dist/index.js /usr/local/bin/supergateway \
    && chmod +x dist/index.js \
    && rm /tmp/supergateway.tgz \
    && npm cache clean --force

EXPOSE 8000

ENTRYPOINT ["supergateway"]

CMD ["--help"]
