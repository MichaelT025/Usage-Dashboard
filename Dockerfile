# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/dist/public/ ./public/
EXPOSE 7878
ENV BIND_ADDRESS=0.0.0.0
ENV NODE_ENV=production
CMD ["node", "dist/cli.js", "--dash", "--no-open"]
