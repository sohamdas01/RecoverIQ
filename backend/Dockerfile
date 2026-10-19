# Build context is the repository root (see docker-compose.yml): the backend imports
# ../../drizzle/schema.js and resolves its dependencies through the npm workspace root.
FROM node:22-alpine

WORKDIR /app

# Install production dependencies from the root workspace lockfile (backend workspace only)
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci --omit=dev -w backend

# Copy only what the backend needs at runtime: shared DB schema + migrations, then backend source
COPY drizzle/ drizzle/
COPY backend/ backend/

WORKDIR /app/backend

# Expose backend service port
EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

# Health check using standard readiness probe
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health/ready || exit 1

CMD ["node", "server.js"]
