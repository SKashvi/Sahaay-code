FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY db ./db
COPY public ./public

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -q -O - http://127.0.0.1:4000/healthz || exit 1

# Run the schema migration then start the server. Safe to run on every
# deploy, schema.sql only creates things that do not already exist.
CMD ["sh", "-c", "node db/migrate.js && node src/server.js"]
