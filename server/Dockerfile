# The relay as a container. Build from the repository root, because the relay
# shares the protocol code in ../src:
#
#   docker build -f server/Dockerfile -t liteboard-relay .
#
# uWebSockets.js ships prebuilt glibc binaries for x64 and arm64, so this
# works on Intel and Graviton machines (not on Alpine).

FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci
COPY tsconfig.json ./
COPY src src
COPY server server
RUN npm --prefix server run build \
    && npm --prefix server prune --omit=dev \
    && find server/node_modules/uWebSockets.js -name 'uws_*.node' ! -name 'uws_linux_*' -delete

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=build /app/server/package.json ./
COPY --from=build /app/server/node_modules node_modules
COPY --from=build /app/server/dist dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# SIGTERM makes the relay write everything buffered before it exits.
STOPSIGNAL SIGTERM
CMD ["node", "dist/bin.js"]
