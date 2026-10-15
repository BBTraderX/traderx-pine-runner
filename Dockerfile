FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY LICENSE README.md ./
USER node
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
# The process only needs to read its own files; Node's permission model blocks writes and child processes.
CMD ["node", "--permission", "--allow-fs-read=/app", "--allow-worker", "src/index.mjs"]
