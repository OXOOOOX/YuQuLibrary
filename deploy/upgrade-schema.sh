#!/usr/bin/env bash
# The caller holds the YuQu release lock. This helper never starts services.
# check OLD_IMAGE NEW_IMAGE prints only the number of pending migrations.
# apply OLD_IMAGE NEW_IMAGE OLD_RELEASE NEXT_RELEASE requires stopped writers.
# Exit 1: no production migration attempted. Exit 20: inspect the maintenance
# backup and database before restarting any version. No data is auto-restored.
set -Eeuo pipefail
umask 077
export LC_ALL=C
base=/opt/yuqu
pg=yuqu-postgres-1
prod=yuqu_production
die() { echo "YuQu schema upgrade: $*" >&2; exit 1; }
usage() { die 'expected check OLD_IMAGE NEW_IMAGE or apply OLD_IMAGE NEW_IMAGE OLD_RELEASE NEXT_RELEASE'; }
case ${1:-} in
  check) [[ $# == 3 ]] || usage ;;
  apply) [[ $# == 5 ]] || usage ;;
  *) usage ;;
esac
mode=$1; old_image=$2; new_image=$3
[[ $(id -u) == 0 ]] || die 'root required'
for image in "$old_image" "$new_image"; do
  [[ $image =~ ^sha256:[a-f0-9]{64}$ && $(docker image inspect --format '{{.Id}}' "$image") == "$image" ]] ||
    die 'an immutable local image ID is required'
done
[[ $(docker inspect -f '{{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}' "$pg") == 'true yuqu postgres' ]] ||
  die 'unexpected YuQu database container'

work=$(mktemp -d /tmp/yuqu-schema.XXXXXXXX)
reader=''; owned_test=''; live_attempt=0
cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n $reader ]]; then docker rm -v "$reader" >/dev/null; fi
  if [[ -n $owned_test ]]; then
    docker exec "$pg" dropdb -U yuqu "$owned_test" || echo "Could not remove isolated database $owned_test" >&2
  fi
  rm -rf -- "$work"
  if (( rc && live_attempt )); then
    echo "Production migration was attempted. Keep writers stopped and inspect $backup." >&2
    exit 20
  fi
  if (( rc )); then exit 1; fi
  exit 0
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

db() {
  local name=$1; shift
  docker exec -i -e PGOPTIONS='-c timezone=UTC -c datestyle=ISO,YMD' "$pg" psql -X -qAt -v ON_ERROR_STOP=1 -U yuqu -d "$name" "$@"
}
ledger() {
  db "$1" -F ' ' -c "SELECT name,checksum FROM public.yuqu_schema_migrations ORDER BY name COLLATE \"C\"" </dev/null
}
image_sql() {
  local image=$1 target=$2
  mkdir "$target"
  # Read the immutable filesystem without executing any candidate code.
  reader=$(docker create --network none --entrypoint /bin/true "$image")
  docker cp "$reader:/app/db/migrations/." - > "$work/sql.tar"
  docker rm -v "$reader" >/dev/null; reader=''
  python3 - "$work/sql.tar" "$target" <<'PY'
import hashlib, pathlib, re, sys, tarfile
archive, target=sys.argv[1],pathlib.Path(sys.argv[2])
manifest={}
with tarfile.open(archive,'r:*') as tar:
    for m in tar:
        name=m.name.removeprefix('./')
        if m.isdir() and name in ('','.'): continue
        if not m.isfile() or not re.fullmatch(r'\d{4}_[a-z0-9_]+\.sql',name) or name in manifest:
            raise SystemExit('Unexpected migration directory entry')
        data=tar.extractfile(m).read()
        (target/name).write_bytes(data)
        manifest[name]=hashlib.sha256(data).hexdigest()
if not manifest: raise SystemExit('Empty migration directory')
(target/'manifest').write_bytes(''.join(f'{name} {manifest[name]}\n' for name in sorted(manifest)).encode('ascii'))
PY
}

image_sql "$old_image" "$work/old"
image_sql "$new_image" "$work/next"
ledger "$prod" > "$work/ledger"
cmp -s "$work/old/manifest" "$work/ledger" || die 'current image does not match the entire production ledger'
old_count=$(wc -l < "$work/ledger")
head -n "$old_count" "$work/next/manifest" > "$work/prefix"
cmp -s "$work/ledger" "$work/prefix" || die 'candidate removed, reordered or changed an applied migration'
tail -n "+$((old_count+1))" "$work/next/manifest" > "$work/pending"
pending=$(wc -l < "$work/pending")
if [[ $mode == check ]]; then printf '%d\n' "$pending"; exit 0; fi
old=$4; next=$5
for dir in "$old" "$next"; do
  [[ $dir =~ ^/opt/yuqu/releases/[A-Za-z0-9._-]+$ && -d $dir && $(realpath -e "$dir") == "$dir" ]] ||
    die 'expected a canonical release directory'
done
[[ $old != "$next" && $(readlink -f "$base/current") == "$old" ]] || die 'unexpected previous release'
if (( pending == 0 )); then exit 0; fi
writers_stopped() {
  local service instances
  for service in app ingestion; do
    instances=$(docker ps -q --filter label=com.docker.compose.project=yuqu --filter "label=com.docker.compose.service=$service") || die 'cannot determine writer state'
    [[ -z $instances ]] || die "$service must be stopped"
  done
}
writers_stopped
backup=$(mktemp -d "$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-before-$(basename "$next").XXXXXXXX")
echo "YuQu schema backup: $backup" >&2
printf '%s\n' "$old" "$next" > "$backup/releases.txt"
printf '%s\n' "$old_image" "$new_image" > "$backup/image-ids.txt"
cp "$work/old/manifest" "$backup/previous-migrations.txt"
cp "$work/next/manifest" "$backup/candidate-migrations.txt"
install -m 600 "$base/shared/runtime.env" "$backup/runtime.env"
install -m 600 "$base/shared/postgres.env" "$backup/postgres.env"
install -m 600 "$old/release.env" "$backup/previous-release.env"
install -m 600 "$next/release.env" "$backup/candidate-release.env"
docker exec "$pg" pg_dump -U yuqu -Fc -d "$prod" > "$backup/database.dump"
tar -C "$base/shared" -czf "$backup/media.tar.gz" media
(cd "$backup" && sha256sum database.dump media.tar.gz runtime.env postgres.env previous-release.env candidate-release.env > SHA256SUMS && sha256sum --quiet -c SHA256SUMS)

python3 - "$base/shared/media" "$backup" <<'PY'
import hashlib, json, pathlib, shutil, sys, tarfile
src, backup=map(pathlib.Path,sys.argv[1:])
def inventory(root):
    result={'.':None}
    for p in root.rglob('*'):
        if p.is_symlink() or not (p.is_dir() or p.is_file()): raise SystemExit('Unsupported media entry')
        name=p.relative_to(root).as_posix()
        if p.is_dir(): result[name]=None; continue
        h=hashlib.sha256()
        with p.open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024), b''): h.update(block)
        result[name]=h.hexdigest()
    return result
restored=backup/'restored-media'; restored.mkdir(mode=0o700)
seen=set()
with tarfile.open(backup/'media.tar.gz','r|gz') as tar:
    for m in tar:
        name=pathlib.PurePosixPath(m.name).relative_to('media')
        if '..' in name.parts or name in seen: raise SystemExit('Invalid media archive entry')
        seen.add(name); target=restored/name
        if m.isdir(): target.mkdir(parents=True,exist_ok=True)
        elif m.isfile():
            target.parent.mkdir(parents=True,exist_ok=True)
            with tar.extractfile(m) as source,target.open('xb') as out: shutil.copyfileobj(source,out)
        else: raise SystemExit('Unexpected media archive entry')
original=inventory(src)
if inventory(restored)!=original: raise SystemExit('Restored media differs from source')
(backup/'verified-media.json').write_text(json.dumps(original,sort_keys=True))
PY

# Use only pre-upgrade columns so additive columns never change the comparison.
# Row order in a restored heap is immaterial; only counts and row hashes leave SQL.
db "$prod" > "$backup/project-old-data.sql" <<'SQL'
SELECT format('SELECT %L, count(*), encode(sha256(convert_to(coalesce(string_agg(v, '''' ORDER BY v), ''''), ''UTF8'')), ''hex'') FROM (SELECT encode(sha256(convert_to(to_jsonb(s)::text, ''UTF8'')), ''hex'') AS v FROM (SELECT %s FROM %I.%I) s) h;',
 n.nspname||'.'||c.relname,string_agg(format('%I',a.attname),', ' ORDER BY a.attnum),n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid JOIN pg_attribute a ON a.attrelid=c.oid
WHERE n.nspname='yuqu' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
GROUP BY n.nspname,c.relname ORDER BY n.nspname,c.relname;
SELECT format('SELECT %L,last_value,is_called FROM %I.%I;',n.nspname||'.'||c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='yuqu' AND c.relkind='S' ORDER BY c.relname;
SQL
[[ -s $backup/project-old-data.sql ]] || die 'no YuQu business tables found'
# Migration filenames were restricted to ASCII identifiers when read from the image.
last_old=$(awk 'END {print $1}' "$work/old/manifest")
printf "SELECT name,checksum,applied_at FROM public.yuqu_schema_migrations WHERE name COLLATE \"C\"<='%s' ORDER BY name COLLATE \"C\";\n" "$last_old" >> "$backup/project-old-data.sql"
snapshot() { db "$1" -f - < "$backup/project-old-data.sql" > "$backup/$2"; }
snapshot "$prod" business-before.txt

testdb="yuqu_restore_$(date -u +%Y%m%d%H%M%S)_${BASHPID}_test"
# createdb refuses an existing name. Only a successful exclusive create grants ownership.
docker exec "$pg" createdb -U yuqu -T template0 "$testdb"
owned_test=$testdb
printf '%s\n' "$testdb" > "$backup/restore-database.txt"
docker exec -i "$pg" pg_restore -U yuqu --exit-on-error --no-owner -d "$testdb" < "$backup/database.dump" > "$backup/restore.log" 2>&1
snapshot "$testdb" business-restored.txt
cmp -s "$backup/business-before.txt" "$backup/business-restored.txt" || die 'restored business data differs from production'

# Run SQL through SPI inside one outer transaction. A migration cannot close that
# transaction or escape into psql backslash commands. Ledger entries use the
# exact file-byte checksums used by scripts/migrate.mjs.
python3 - "$work" "$backup/upgrade.sql" <<'PY'
import pathlib, secrets, sys
work,out=map(pathlib.Path,sys.argv[1:])
def manifest(p): return [l.split() for l in p.read_text().splitlines()]
old=manifest(work/'old/manifest')
pending=manifest(work/'pending')
def literal(data):
    tag='$yuqu_'+secrets.token_hex(16)+'$'
    while tag in data: tag='$yuqu_'+secrets.token_hex(16)+'$'
    return tag+data+tag
with out.open('w',encoding='utf-8',newline='\n') as sql:
    sql.write('SELECT pg_advisory_xact_lock(5173801);\n')
    def verify(entries):
        expected=','.join(f"('{name}','{checksum}')" for name,checksum in entries)
        sql.write(f"""DO $$ BEGIN
IF (SELECT count(*) FROM public.yuqu_schema_migrations)<>{len(entries)} OR EXISTS (
SELECT * FROM (VALUES {expected}) expected(name,checksum)
EXCEPT SELECT name,checksum FROM public.yuqu_schema_migrations
) THEN RAISE EXCEPTION 'YuQu migration ledger mismatch'; END IF; END $$;\n""")
    verify(old)
    for name,checksum in pending:
        text=(work/'next'/name).read_bytes().decode('utf-8')
        body='BEGIN EXECUTE '+literal(text)+'; END'
        sql.write('DO '+literal(body)+';\n')
        sql.write(f"INSERT INTO public.yuqu_schema_migrations(name,checksum) VALUES ('{name}','{checksum}');\n")
    verify(old+pending)
PY
migrate() { db "$1" --single-transaction -f - < "$backup/upgrade.sql" > "$backup/$2" 2>&1; }
migrate "$testdb" rehearsal.log || die 'isolated migration rehearsal failed'
snapshot "$testdb" business-rehearsed.txt
cmp -s "$backup/business-restored.txt" "$backup/business-rehearsed.txt" || die 'migration changes old data; separate reviewed transition required'
ledger "$testdb" > "$backup/rehearsed-ledger.txt"
cmp -s "$work/next/manifest" "$backup/rehearsed-ledger.txt" || die 'rehearsal ledger mismatch'
docker exec "$pg" dropdb -U yuqu "$testdb"
owned_test=''
writers_stopped
snapshot "$prod" business-pre-activation.txt
cmp -s "$backup/business-before.txt" "$backup/business-pre-activation.txt" || die 'business state changed during rehearsal'
live_attempt=1
migrate "$prod" production-migration.log || die 'production migration failed'
snapshot "$prod" business-upgraded.txt
cmp -s "$backup/business-before.txt" "$backup/business-upgraded.txt" || die 'production business snapshot differs'
ledger "$prod" > "$backup/upgraded-ledger.txt"
cmp -s "$backup/rehearsed-ledger.txt" "$backup/upgraded-ledger.txt" || die 'production migration ledger mismatch'
printf 'Verified %d new YuQu migrations and all previous business records.\n' "$pending"
