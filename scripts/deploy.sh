#!/usr/bin/env bash
# Run on your own VPS, from the cloned private wtox repository.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine and Compose plugin first." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required." >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo "Missing .env; copy .env.example and configure secrets and SITE_DOMAIN." >&2
  exit 1
fi
if grep -Eq 'REPLACE_WITH|^SITE_DOMAIN=chat.example.com$' .env; then
  echo ".env still contains placeholders; refuse deployment." >&2
  exit 1
fi
chmod 600 .env
docker compose config -q
echo "Building wtox. Dockerfile includes native identity create/restore test."
docker compose build web
echo "Starting services. No plaintext application port is published."
docker compose up -d --remove-orphans
docker compose ps
echo "Review logs with: docker compose logs --tail=80 web caddy"
