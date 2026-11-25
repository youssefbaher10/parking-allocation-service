FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node app.js index.js ./
COPY --chown=node:node src ./src
USER node
EXPOSE 3001
CMD ["node","index.js"]
