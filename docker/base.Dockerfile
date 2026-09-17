FROM node:20-alpine

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
