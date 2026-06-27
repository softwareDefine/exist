# syntax=docker/dockerfile:1
# 격리된 코드 실행 전용 이미지.
# exist 본체와 분리되어 internal 네트워크(인터넷 차단)에서만 동작한다.
FROM node:20-bookworm-slim

WORKDIR /runner

# 코드 실행 툴체인: C/C++(build-essential), Python3.
# (Java/Go/Rust 는 이미지가 크게 불어나므로 필요할 때 추가)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 의존성 (런타임 네트워크는 차단되므로 빌드 시점에만 설치)
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

# 실제 권한 제한(non-root, cap_drop 등)은 docker-compose 에서 적용한다.
CMD ["node", "server.js"]
