FROM base
RUN apk add --no-cache python3=3.14.7-r1 coreutils=9.11-r0
COPY --from=ghcr.io/astral-sh/uv:0.12.15@sha256:62f8c047d0a0e9ece6b53fc63df902585a67a47a7f318ddec4a37db586edc8e3 /uv /uvx /bin/
