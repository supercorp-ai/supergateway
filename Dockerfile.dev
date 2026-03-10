FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 8000

ENTRYPOINT ["node", "dist/index.js"]

CMD ["--help"]
