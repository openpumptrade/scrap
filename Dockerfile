# Railway builds the repo root — this image runs the engine + page.
FROM node:22-alpine
WORKDIR /app
COPY engine/package.json engine/package-lock.json* ./
RUN npm install --omit=dev
COPY engine/src ./src
COPY engine/public ./public
COPY engine/scripts ./scripts
EXPOSE 4000
CMD ["node", "src/index.js"]
