# syntax=docker/dockerfile:1

FROM golang:1.25-alpine AS go-builder
RUN apk add --no-cache git
WORKDIR /app/go-bridge
COPY go-bridge/go.mod go-bridge/go.sum ./
RUN go mod download
COPY go-bridge/ ./
RUN go build -o bridge .

FROM node:22-alpine AS node-builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV UPLOAD_DIR=/data/uploads
ENV BRIDGE_URL=http://127.0.0.1:3001
ENV WOZAPI_V2_BRIDGE_URL=http://127.0.0.1:3003
ENV WOZAPI_V2_BRIDGE_PORT=3003
ENV NODE_URL=http://127.0.0.1:3000
ENV BRIDGE_DB_PATH=/data/wooapi_bridge.db
ENV WOZAPI_ENGINE=whatsmeow

RUN apk add --no-cache ca-certificates tini
COPY --from=node-builder /app/package*.json ./
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/dist ./dist
COPY --from=node-builder /app/src ./src
COPY --from=node-builder /app/server.ts ./server.ts
COPY --from=node-builder /app/docs ./docs
COPY --from=node-builder /app/migrations ./migrations
COPY --from=go-builder /app/go-bridge/bridge ./go-bridge/bridge

RUN mkdir -p /data/uploads
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "./go-bridge/bridge & npm run engine:v2 & npm run start"]
