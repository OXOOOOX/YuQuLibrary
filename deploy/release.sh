#!/usr/bin/env bash
set -euo pipefail
# Run as root from an immutable /opt/yuqu/releases/<id> source directory.
# runtime.env and postgres.env are prepared separately, never build inputs.
release=$(pwd -P)
[[ "$release" =~ ^/opt/yuqu/releases/[a-zA-Z0-9-]+$ ]] || { echo 'Invalid release directory'; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'Root required for private runtime configuration'; exit 1; }
[[ ! -e /opt/yuqu/current ]] || { echo 'Initial deployment only; future updates require a backup and rollback plan.'; exit 1; }
exec 8>/opt/yuqu/shared/release.lock
flock -n 8 || { echo 'Another YuQu release is active'; exit 1; }
exec 9>/opt/rdb/shared/build.lock
flock -w 60 9 || { echo 'Another server build is active'; exit 1; }
set -a
source ./release.env
set +a
[[ $(docker image inspect "$YUQU_NODE_IMAGE" --format '{{.Id}}') == "$YUQU_NODE_IMAGE_ID" ]] || { echo 'Node base image changed'; exit 1; }
[[ $(df --output=avail -B1 /opt/yuqu | tail -1) -gt 2200000000 ]] || { echo 'Need at least 2.2 GB available for this build'; exit 1; }
[[ $(awk '/MemAvailable/{print $2}' /proc/meminfo) -gt 1100000 ]] || { echo 'Need at least 1.1 GB available memory'; exit 1; }
docker compose -f deploy/compose.yaml config --quiet
docker build --resource memory=1536m --resource cpu-quota=100000 --resource cpu-period=100000 \
  --build-arg "NODE_IMAGE=$YUQU_NODE_IMAGE" -f deploy/Dockerfile -t "$YUQU_IMAGE" .
flock -u 9
docker compose -f deploy/compose.yaml up -d postgres
docker compose -f deploy/compose.yaml run --rm migrate
docker compose -f deploy/compose.yaml up -d --no-build app ingestion
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:4210/api/health >/dev/null; then
    ln -sfn "$release" /opt/yuqu/current
    docker image inspect "$YUQU_IMAGE" --format '{{.Id}}' > deployed-image-id.txt
    echo 'YuQu HTTP is ready; verify database, mail, media and public HTTPS separately.'
    exit 0
  fi
  sleep 2
done
echo 'YuQu startup failed; current pointer was not changed. Inspect only YuQu container logs.'
exit 1
