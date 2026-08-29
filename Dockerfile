FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
# npm install resolves native/optional packages for the container's Linux
# platform; npm ci rejects cross-platform lockfiles generated on Windows.
RUN npm install --omit=dev --no-audit

COPY src ./src
COPY public ./public
COPY README.md ./README.md

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "src/index.js"]
