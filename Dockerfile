# Stage 1: Build — compile TypeScript backend + Vite frontend
FROM node:22-bookworm AS build
WORKDIR /app

# Install build tools for native modules (LiteParse and other optional addons)
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y ca-certificates python3 make g++ \
    && sed -i 's|http://mirrors.tuna.tsinghua.edu.cn/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests for dependency installation
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/learning-agent/package.json apps/learning-agent/tsconfig.json apps/learning-agent/
COPY apps/learning-agent/web/package.json apps/learning-agent/web/tsconfig.json apps/learning-agent/web/
# Vendored xlsx tarball — both package.json files pull it in via a `file:` dependency,
# so it must exist before npm ci runs.
COPY vendor/ vendor/

RUN npm config set registry https://registry.npmmirror.com && npm ci

# Copy source code
COPY apps/learning-agent/src apps/learning-agent/src/
COPY apps/learning-agent/web/src apps/learning-agent/web/src/
# Vite copies public/ verbatim into dist/ (provider brand icons, fonts, pptist
# bundle, web manifest). Without it those paths are absent from the image and
# the SPA fallback answers with index.html, so every asset renders as a broken
# image instead of a 404.
COPY apps/learning-agent/web/public apps/learning-agent/web/public/
COPY apps/learning-agent/web/vite.config.ts apps/learning-agent/web/index.html apps/learning-agent/web/

RUN npm run build

# Stage 2: Production runtime — web UI mode
FROM node:22-bookworm AS runtime
WORKDIR /app

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y ca-certificates \
    && sed -i 's|http://mirrors.tuna.tsinghua.edu.cn/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    INNO_HOME=/var/lib/my-learning-agent \
    INNO_CONFIG_DIR=/etc/my-learning-agent \
    INNO_DATA_DIR=/var/lib/my-learning-agent/data \
    INNO_WORKSPACE_DIR=/srv/my-learning-workspace \
    INNO_PORT=3000

# Copy the FULL node_modules from build stage (no pruning).
# npm prune --production is unreliable with workspaces: it can drop
# packages like @earendil-works/pi-ai that are depended on by workspace
# packages but nested due to version conflicts with pi-web-ui.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/learning-agent/node_modules ./apps/learning-agent/node_modules

# Copy compiled artifacts from build stage
COPY --from=build /app/apps/learning-agent/dist ./apps/learning-agent/dist
COPY --from=build /app/apps/learning-agent/web/dist ./apps/learning-agent/web/dist

#COPY config.example.json /etc/my-learning-agent/config.json
#RUN mkdir -p /var/lib/my-learning-agent/data /srv/my-learning-workspace

EXPOSE 3000

CMD ["node", "apps/learning-agent/dist/server.js"]
