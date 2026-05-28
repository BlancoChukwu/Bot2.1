FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=650 --expose-gc"
ENV RUST_HOTPATH_ENABLED=false
ENV USE_PIPELINE_ORCHESTRATOR=true
ENV CHAIN=base

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9090/healthz || exit 1

CMD ["node", "dist/src/index.js"]
