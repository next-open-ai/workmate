FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    WORKMATE_DATA_DIR=/opt/workmate-data \
    WORKMATE_API_HOST=0.0.0.0 \
    WORKMATE_API_PORT=4318 \
    WORKMATE_AGENT_ENGINE=agentscope

WORKDIR /opt/workmate

COPY package.docker.json ./package.json
COPY README.md README-EN.md ./
COPY bin ./bin
COPY scripts/lib ./scripts/lib
COPY apps/api/dist ./apps/api/dist
COPY apps/renderer/dist ./apps/renderer/dist
COPY runtimes/agentscope-runtime ./runtimes/agentscope-runtime

RUN npm install --omit=dev --no-audit --no-fund
RUN chmod +x bin/workmate.mjs
RUN mkdir -p /opt/workmate-data && WORKMATE_DATA_DIR=/opt/workmate-data node bin/workmate.mjs init

EXPOSE 4318
VOLUME ["/opt/workmate-data"]

CMD ["node", "bin/workmate.mjs", "start"]
