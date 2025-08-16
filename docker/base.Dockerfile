FROM node:20-alpine

RUN npm install -g supergateway

EXPOSE 8000

ENTRYPOINT ["supergateway"]

CMD ["--help"]
