FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose backend service port
EXPOSE 4000

ENV PORT=4000
ENV NODE_ENV=production

# Health check using standard readiness probe
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health/ready || exit 1

CMD ["node", "server.js"]
