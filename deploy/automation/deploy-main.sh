#!/bin/bash
# Installed by the administrator. Invoked only by the restricted systemd request.
set -Eeuo pipefail
umask 077
export LC_ALL=C GIT_TERMINAL_PROMPT=0
base=/opt/yuqu
trusted=/usr/local/libexec/yuqu-deploy
origin=https://github.com/OXOOOOX/YuQuLibrary.git
sha=$1; run=$2
[[ $(id -u) == 0 && $sha =~ ^[0-9a-f]{40}$ && $(dirname "$run") == "$base/deployment-runs" && -d $run ]] || exit 64

phase() { echo "$1" > "$run/phase"; echo "Phase: $1"; }
fail() { echo "$*" >&2; exit 1; }
finish() { printf '%s %s\n' "$1" "$sha" > "$run/result"; }
phase locking
exec 8>"$base/shared/release.lock"
flock -w 900 8 || fail 'Release lock busy'
maintenance=$base/shared/deploy-maintenance
[[ ! -e $maintenance ]] || fail 'Previous schema transition needs review.'
old=$(readlink -e "$base/current")
[[ -d $old && $(dirname "$old") == "$base/releases" && -f $old/release.env ]] || fail 'Invalid current release.'
mirror=$base/main.git
if [[ ! -d $mirror ]]; then git init --quiet --bare "$mirror"; fi
repo() { git -c core.hooksPath=/dev/null --git-dir="$mirror" "$@"; }
head_of_main() {
  local line
  line=$(timeout 90 git ls-remote --exit-code "$origin" refs/heads/main) || return 1
  [[ $line =~ ^([0-9a-f]{40})[[:space:]]refs/heads/main$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}
phase fetching
timeout 240 git -c core.hooksPath=/dev/null -c fetch.fsckObjects=true --git-dir="$mirror" fetch --no-tags "$origin" '+refs/heads/main:refs/heads/main'
if [[ $(repo rev-parse refs/heads/main) != "$sha" ]]; then finish superseded; exit 0; fi
for file in automation/ssh-entry automation/request automation/deploy-main.sh upgrade-schema.sh compose.yaml; do
  repo show "$sha:deploy/$file" | cmp -s - "$trusted/${file##*/}" ||
    fail 'Install the reviewed changes to the host deployment tools first.'
done

compose() {
  local release=$1; shift
  docker compose -p yuqu --env-file "$release/release.env" -f "$trusted/compose.yaml" "$@" </dev/null
}
container_image() {
  local id
  id=$(compose "$1" ps -q "$2")
  [[ -n $id ]] && docker inspect -f '{{if .State.Running}}{{.Image}}{{end}}' "$id"
}
healthy() {
  local release=$1 image=$2 revision=$3
  for _ in {1..30}; do
    if [[ $(container_image "$release" app) == "$image" && $(container_image "$release" ingestion) == "$image" ]] &&
      curl --noproxy '*' -fsS --max-time 4 http://127.0.0.1:4210/api/health |
        python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(not (v.get("service")=="yuqu-library" and v.get("status")=="ok" and (not sys.argv[1] or v.get("revision")==sys.argv[1])))' "$revision" &&
      [[ $(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:4210/api/library) == 401 ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}
old_image=$(cat "$old/deployed-image-id.txt")
[[ $old_image =~ ^sha256:[a-f0-9]{64}$ && $(container_image "$old" app) == "$old_image" &&
   $(container_image "$old" ingestion) == "$old_image" ]] || fail 'Active image and release pointer differ.'
next=$base/releases/git-$sha
if [[ $old == "$next" ]]; then
  healthy "$old" "$old_image" "$sha" || fail 'Active release failed verification.'
  finish deployed; exit 0
fi

phase building
# Export only application/build files. Credentials and release.env stay outside the Docker build context.
paths=(.dockerignore package.json package-lock.json tsconfig.json apps/web packages db scripts workers/ingestion workers/codex-bridge/package.json deploy/Dockerfile deploy/compose.yaml)
repo ls-tree -r --format='%(objectmode)' "$sha" -- "${paths[@]}" > "$run/source-modes"
if grep -qxvE '100644|100755' "$run/source-modes"; then fail 'Unsupported source entry.'; fi
image=yuqu:git-$sha
if [[ ! -d $next ]]; then
  work=$(mktemp -d "$base/releases/.build-$sha.XXXXXXXX")
  trap 'if [[ -n ${work:-} && $(dirname "$work") == "$base/releases" && $(basename "$work") == ".build-$sha."* ]]; then rm -rf -- "$work"; fi' EXIT
  # tar must create traversable source subdirectories for the container's unprivileged user.
  (umask 022; repo archive --format=tar "$sha" -- "${paths[@]}" | tar --no-same-owner -xf - -C "$work")
  (
    set -a
    source "$old/release.env"
    set +a
    [[ $(docker image inspect "$YUQU_NODE_IMAGE" -f '{{.Id}}') == "$YUQU_NODE_IMAGE_ID" ]] || fail 'Node base image differs.'
    exec 9>/opt/rdb/shared/build.lock
    flock -w 900 9 || fail 'Shared build lock busy'
    docker build --resource memory=1536m --resource cpu-quota=100000 --resource cpu-period=100000 \
      --build-arg "NODE_IMAGE=$YUQU_NODE_IMAGE" --build-arg "YUQU_REVISION=$sha" \
      -f "$work/deploy/Dockerfile" -t "$image" "$work"
  )
  docker image inspect "$image" --format '{{.Id}}' > "$work/built-image-id.txt"
  sed "s|^YUQU_IMAGE=.*|YUQU_IMAGE=$image|" "$old/release.env" > "$work/release.env"
  [[ $(grep -cFx "YUQU_IMAGE=$image" "$work/release.env") == 1 ]]
  mv -T "$work" "$next"
  work=''
  trap - EXIT
fi
candidate=$(cat "$next/built-image-id.txt")
[[ $candidate =~ ^sha256:[a-f0-9]{64}$ && $(docker image inspect "$image" -f '{{.Id}}') == "$candidate" &&
   $(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$sha" ]] || fail 'Revision mismatch.'
docker run --rm --network none --read-only --user 1000:1000 --entrypoint sh "$candidate" -ec \
  'test -r /app/db/migrations/0001_bootstrap.sql && test -r /app/workers/ingestion/run.mjs && test -r /app/apps/web/.next/server/app/page.js'
phase preflight
pending=$("$trusted/upgrade-schema.sh" check "$old_image" "$candidate")
[[ $pending =~ ^[0-9]+$ ]] || fail 'Invalid migration plan.'
still_main() {
  local head
  head=$(head_of_main) || fail 'Cannot verify main.'
  if [[ $head != "$sha" ]]; then finish superseded; exit 0; fi
}
still_main

change_started=0
schema_started=0
cleanup() {
  local rc=$?
  trap - EXIT HUP TERM INT; set +e
  if (( rc != 0 && change_started )); then
    if (( schema_started )); then
      compose "$next" stop app ingestion
      echo 'Schema may have changed; maintenance evidence retained.' >&2
    else
      compose "$old" up -d --no-deps --no-build app ingestion && healthy "$old" "$old_image" '' ||
        echo 'Could not restore the previous application. Inspect this deployment.' >&2
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
active_leases() {
  docker exec yuqu-postgres-1 psql -XqAt -v ON_ERROR_STOP=1 -U yuqu -d yuqu_production -c \
    "SELECT (SELECT count(*) FROM yuqu.import_jobs WHERE status='downloading' AND lease_until>now())
          + (SELECT count(*) FROM yuqu.transcript_jobs WHERE status='processing' AND lease_until>now())
          + (SELECT count(*) FROM yuqu.chat_turns WHERE status='running' AND lease_until>now())
          + (SELECT count(*) FROM yuqu.chapter_batches WHERE status='running' AND lease_until>now())
          + (SELECT count(*) FROM yuqu.summary_nodes WHERE status='running' AND lease_until>now());"
}
if (( pending > 0 )); then
  phase draining
  deadline=$((SECONDS + 600))
  while :; do
    (( SECONDS < deadline )) || fail 'Active work did not drain.'
    active=$(active_leases)
    if [[ $active != 0 ]]; then sleep 5; continue; fi
    still_main
    change_started=1
    compose "$old" stop app ingestion
    active=$(active_leases)
    if [[ $active == 0 ]]; then break; fi
    # A worker claimed a job just before stop. Reopen the old API so it can finish.
    compose "$old" up -d --no-deps --no-build app ingestion
    healthy "$old" "$old_image" '' || fail 'Cannot restore while draining.'
    change_started=0
    sleep 5
  done
  phase migrating
  echo "$old -> $next ($run)" > "$maintenance"
  schema_started=1
  if "$trusted/upgrade-schema.sh" apply "$old_image" "$candidate" "$old" "$next"; then :
  else
    rc=$?
    if (( rc == 1 )); then schema_started=0; rm -f "$maintenance"; fi
    exit "$rc"
  fi
else
  still_main
fi
phase activating
change_started=1
compose "$next" up -d --no-build --no-deps app ingestion
healthy "$next" "$candidate" "$sha" || fail 'Candidate failed local readiness.'
phase verifying
public_ok=0
for _ in {1..5}; do
  if curl -fsS --max-time 10 "https://fish.sdspeed.com.cn/api/health?revision=$sha" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(not (d.get("status")=="ok" and d.get("revision")==sys.argv[1]))' "$sha"; then
    public_ok=1; break
  fi
  sleep 2
done
(( public_ok )) || fail 'Public revision mismatch.'
printf '%s\n' "$candidate" > "$next/deployed-image-id.txt"
ln -s "$old" "$run/previous"; mv -Tf "$run/previous" "$base/previous"
ln -s "$next" "$run/current"; mv -Tf "$run/current" "$base/current"
change_started=0
if (( schema_started )); then rm -f "$maintenance"; fi
finish deployed
