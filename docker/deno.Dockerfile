FROM denoland/deno:alpine-2.9.6
RUN apk add --no-cache libstdc++
# Reuse the Node runtime and installed gateway from our base image.
COPY --from=base /usr/local/ /usr/local/
# Preserve the same optional non-root user as the other variants.
COPY --from=base /etc/passwd /etc/group /etc/
COPY --from=base --chown=node:node /home/node/ /home/node/

EXPOSE 8000
ENTRYPOINT ["supergateway"]
CMD ["--help"]
