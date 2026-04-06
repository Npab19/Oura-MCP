# --- Build stage ---
FROM node:22.22.1-alpine AS build

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Production stage ---
FROM node:22.22.1-alpine

WORKDIR /app

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist/ dist/

# Switch to non-root user
USER appuser

EXPOSE 3000

CMD ["node", "dist/index.js"]
