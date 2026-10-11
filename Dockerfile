# Build the React/Ant Design X UI. Only compiled static assets reach runtime.
FROM node:22-bookworm-slim AS frontendbuild
WORKDIR /frontend
COPY frontend/package.json ./
COPY tests/check_npm_peers.mjs /checks/check_npm_peers.mjs
RUN node /checks/check_npm_peers.mjs \
 && npm install --no-audit --no-fund \
 && npm ls antd @ant-design/x @ant-design/icons --depth=0
COPY frontend/ ./
RUN npm run build

FROM ubuntu:24.04 AS toxbuild
ARG TOXCORE_REF=v0.2.23
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates build-essential cmake pkg-config libsodium-dev && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${TOXCORE_REF}" --recurse-submodules https://github.com/TokTok/c-toxcore.git /src/toxcore \
 && cmake -S /src/toxcore -B /tmp/toxbuild -DCMAKE_BUILD_TYPE=Release -DBOOTSTRAP_DAEMON=OFF -DUNITTEST=OFF -DAUTOTEST=OFF -DENABLE_SHARED=ON -DENABLE_STATIC=OFF -DBUILD_TOXAV=OFF -DDHT_BOOTSTRAP=OFF \
 && cmake --build /tmp/toxbuild -j2 \
 && cmake --install /tmp/toxbuild

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 python3-pip python3-venv libsodium23 libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=toxbuild /usr/local/lib/ /usr/local/lib/
RUN ldconfig && python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ /app/backend/
COPY --from=frontendbuild /frontend/dist/ /app/frontend/
# Fail loudly if the React JS/CSS or favicon is missing from the runtime image.
RUN python3 -c "from pathlib import Path; p=Path('/app/frontend'); assert (p/'index.html').is_file(); assert (p/'logo.svg').is_file(); assert list((p/'assets').glob('*.js')); assert list((p/'assets').glob('*.css'))"
# Fail the build if the native library cannot create and reopen a real Tox ID.
RUN python -m backend.tox_smoke
RUN useradd --uid 10001 --create-home wtox && mkdir /data && chown -R wtox:wtox /data
USER wtox
ENV PYTHONUNBUFFERED=1
EXPOSE 6066
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "6066", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
