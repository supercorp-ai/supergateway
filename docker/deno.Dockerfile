FROM denoland/deno:alpine-2.9.6
RUN apk add --no-cache libstdc++
# Reuse the Node runtime and installed gateway from our base image.
COPY --from=base /usr/local/ /usr/local/

EXPOSE 8000
ENTRYPOINT ["supergateway"]
CMD ["--help"]
