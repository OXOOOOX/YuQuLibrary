#!/bin/bash
# One-time host installation / explicit update of the trusted deployment tools.
# Usage: sudo bash deploy/automation/install.sh /path/to/dedicated-public-key
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $# == 1 && -f $1 ]] || exit 64
here=$(cd "$(dirname "$0")" && pwd)
trusted=/usr/local/libexec/yuqu-deploy
home=/var/lib/yuqu-deploy
user=yuqu-deploy
key=$(cat "$1")
[[ $key =~ ^ssh-ed25519\ ([A-Za-z0-9+/=]+)(\ [^[:cntrl:]]*)?$ ]] || { echo 'Expected one Ed25519 public key.' >&2; exit 1; }
public_key="ssh-ed25519 ${BASH_REMATCH[1]}"
if ! id "$user" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir "$home" --shell /bin/sh "$user"
fi
[[ $(getent passwd "$user" | cut -d: -f6,7) == "$home:/bin/sh" && $(id -Gn "$user") == "$user" ]] ||
  { echo 'Unexpected deployment account settings.' >&2; exit 1; }
install -d -o root -g root -m 0755 "$trusted" "$home" "$home/.ssh"
exec 8>/opt/yuqu/shared/release.lock
flock -w 600 8
for f in ssh-entry request deploy-main.sh; do install -o root -g root -m 0755 "$here/$f" "$trusted/$f"; done
install -o root -g root -m 0644 "$here/stage-source.py" "$trusted/stage-source.py"
install -o root -g root -m 0755 "$here/../upgrade-schema.sh" "$trusted/upgrade-schema.sh"
install -o root -g root -m 0644 "$here/../compose.yaml" "$trusted/compose.yaml"
policy=$(mktemp)
trap 'rm -f -- "$policy"' EXIT
printf '%s ALL=(root) NOPASSWD: %s/request\n' "$user" "$trusted" > "$policy"
visudo -cf "$policy"
install -o root -g root -m 0440 "$policy" /etc/sudoers.d/yuqu-deploy
auth=$(mktemp "$home/.ssh/authorized_keys.XXXXXX")
printf 'restrict,command="%s/ssh-entry" %s\n' "$trusted" "$public_key" > "$auth"
chmod 0644 "$auth"
mv -T "$auth" "$home/.ssh/authorized_keys"
echo 'Installed the restricted YuQu deployment entry.'
