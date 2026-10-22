FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libgtk-3-0 libnss3 libasound2 libx11-xcb1 libxkbfile1 libgbm1 libatk-bridge2.0-0 libdrm2 libxss1 xvfb xauth dbus && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm install --global @openai/codex@0.152.0
COPY . .
CMD ["bash", "scripts/test-linux.sh"]
