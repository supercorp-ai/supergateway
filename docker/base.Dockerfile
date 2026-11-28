FROM node:20-alpine

# node:20-alpine no longer gets npm updates, and its npm 10.8.2 bundles a tar
# with a known flaw that `npx -y <server>` would use to unpack packages.
# 10.9.11 keeps Node 20 (it supports >=20.5.0) and bundles a fixed tar.
RUN npm install -g npm@10.9.11 --no-audit --no-fund && npm cache clean --force

ARG VERSION
ARG PACKAGE_SHA256
COPY .release/supergateway.tgz /tmp/supergateway.tgz
# The tarball can be an unpublished candidate or the exact published release.
RUN echo "$PACKAGE_SHA256  /tmp/supergateway.tgz" | sha256sum -c - \
    && npm install -g /tmp/supergateway.tgz --omit=dev --ignore-scripts --engine-strict --no-audit --no-fund \
    && test "$(supergateway --version)" = "$VERSION" \
    && rm /tmp/supergateway.tgz \
    && npm cache clean --force

EXPOSE 8000

ENTRYPOINT ["supergateway"]

CMD ["--help"]
