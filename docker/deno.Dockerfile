FROM denoland/deno:alpine-2.9.6@sha256:aa665f8777136863b5b8a0445a5cdfccff8103b5f40c9a877de5276b04facb1e AS deno
FROM base
# Deno's official Alpine image supplies an isolated glibc runtime.
COPY --from=deno /usr/local/lib/glibc/ /usr/local/lib/glibc/
COPY --from=deno /lib/ld-linux-* /lib/
COPY --from=deno /lib64/ /lib64/
COPY --from=deno /etc/ld.so.conf /etc/ld.so.cache /etc/
COPY --from=deno /bin/deno /usr/local/bin/deno
ENV DENO_USE_CGROUPS=1
ENV DENO_INSTALL_ROOT=/usr/local
