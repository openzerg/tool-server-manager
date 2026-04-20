FROM oven/bun:alpine AS builder
RUN apk add --no-cache git
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY src/ src/
COPY tsconfig.json ./
RUN bun build --compile src/main.ts --outfile tool-server-manager
FROM alpine:latest
RUN apk add --no-cache ca-certificates libstdc++
WORKDIR /app
COPY --from=builder /app/tool-server-manager /app/tool-server-manager
RUN chmod +x /app/tool-server-manager
EXPOSE 25021
ENTRYPOINT ["/app/tool-server-manager"]
