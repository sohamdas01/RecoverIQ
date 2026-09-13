# Multi-stage production build for Next.js frontend
FROM node:22-alpine AS builder

WORKDIR /app

# Install all dependencies including build tools
COPY package*.json ./
RUN npm ci

# Copy application source
COPY . .

# Build Next.js production bundle
ARG NEXT_PUBLIC_BACKEND_URL=http://localhost:4000/api
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NODE_ENV=production

RUN npm run build

# Production runner stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000 || exit 1

CMD ["npm", "start"]
