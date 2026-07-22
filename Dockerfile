# syntax=docker/dockerfile:1
# ───── build ───── (네이티브 의존성: mediasoup, better-sqlite3 컴파일)
FROM node:20-bookworm AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip build-essential git \
    && rm -rf /var/lib/apt/lists/*

# 클라이언트 빌드 (Vite → 정적)
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci
# 윈도우에서 만든 lockfile엔 리눅스용 optional 네이티브 바이너리가 빠짐(npm 고질병)
# → vite(rollup)·lightningcss의 현재 아키텍처 바이너리를 명시 보강
RUN cd client && npm i --no-save --force \
      lightningcss-linux-arm64-gnu @rollup/rollup-linux-arm64-gnu || true
COPY client ./client
RUN cd client && npm run build

# 서버 빌드 (tsc)
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY server ./server
RUN cd server && npm run build

# ───── runtime ─────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
ENV DATA_DIR=/data
RUN mkdir -p /data

# 코드 실행(/exec)은 격리된 runner 컨테이너로 분리됐으므로 본체엔 컴파일러·파이썬을
# 두지 않는다(공격면 축소). git push(/git)용 git 과 TLS 인증서만 둔다.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 서버 런타임(빌드된 node_modules엔 mediasoup 워커 바이너리 포함) + dist + 클라 정적
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/package.json ./package.json
COPY --from=build /app/client/dist /app/client/dist

EXPOSE 4000
EXPOSE 40000-40100/udp
EXPOSE 40000-40100/tcp
CMD ["node", "dist/index.js"]
