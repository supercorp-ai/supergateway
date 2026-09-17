FROM base
RUN apk add --no-cache python3 coreutils
COPY --from=ghcr.io/astral-sh/uv:0.12.15 /uv /uvx /bin/
