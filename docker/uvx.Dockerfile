FROM base
RUN apk add --no-cache python3 coreutils
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
