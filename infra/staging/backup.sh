#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: infra/staging/backup.sh <output.dump>" >&2
  exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
env_file="$root/infra/staging/.env"
compose_file="$root/infra/staging/compose.yaml"

if [ ! -f "$env_file" ]; then
  echo "missing $env_file; copy .env.example and configure it" >&2
  exit 2
fi

docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
  sh -c 'exec pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$1"
