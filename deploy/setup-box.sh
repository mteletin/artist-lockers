#!/usr/bin/env bash
# Prepares the dedicated Artist Lockers LXC after ASP.NET Core 10 is installed:
# the service user and its directories, one signing key per peer (identity, gallery, tools, Codex), the pinned certificate of each, the
# TLS certificate Kestrel serves to the public proxy, the settings file and the systemd unit.
# Re-runnable: what exists is kept. Private keys are generated only for a settings file that does not exist yet, and never
# printed; the public halves land in /etc/ai-tlt-artistlockers/public for peer trust registration.
#   sudo bash setup-box.sh
# A peer's certificate is read from its file on this box when it has one (the gallery's, the tools', the Codex's), otherwise from what it
# serves now (identity), and printed. ARTISTLOCKERS_<PEER>_SHA256 overrides either.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
svc=ai-tlt-artistlockers
etc=/etc/$svc opt=/opt/$svc lib=/var/lib/$svc
tls_names=${ARTISTLOCKERS_TLS_NAMES:-"DNS:ai-tlt-artistlockers,DNS:artistlockers.eu,DNS:www.artistlockers.eu,DNS:localhost,IP:127.0.0.1"}
# peer section host:port local-certificate
peers=(
  "identity Identity ${ARTISTLOCKERS_IDENTITY_HOST:-192.168.8.80}:443 -"
  "gallery Gallery 192.168.8.86:9443 /etc/ai-tlt-gallery/tls/gallery.crt"
  "tools Tools 192.168.8.86:9444 /etc/ai-tlt-tools/tls/tools.crt"
  "codex Codex 192.168.8.86:9446 /etc/ai-tlt-codex/tls/codex.crt"
)

command -v dotnet >/dev/null || { echo "Install aspnetcore-runtime-10.0 first." >&2; exit 1; }
id -u $svc >/dev/null 2>&1 || useradd --system --home-dir $lib --no-create-home --shell /usr/sbin/nologin $svc
install -d -o root -g root -m 755 $opt
install -d -o root -g $svc -m 750 $etc $etc/tls
install -d -o root -g root -m 755 $etc/public
install -d -o $svc -g $svc -m 750 $lib
install -d -o $svc -g $svc -m 700 $lib/keys

fingerprint() { openssl x509 -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':'; }

if [[ ! -f $etc/appsettings.Production.json ]]; then
  work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
  for entry in "${peers[@]}"; do
    read -r peer section address file <<<"$entry"
    override=ARTISTLOCKERS_${section^^}_SHA256
    if [[ -n ${!override:-} ]]; then pin=${!override}
    elif [[ $file != - && -f $file ]]; then pin=$(fingerprint < "$file")
    else pin=$(openssl s_client -connect "$address" -servername "ai-tlt-$peer" </dev/null 2>/dev/null | fingerprint)
    fi
    [[ ${#pin} -eq 64 ]] || { echo "Could not read the $peer certificate ($address); set $override." >&2; exit 1; }
    printf 'Pinned %-8s %s (%s).\n' "$peer" "$pin" "$address"
    echo "$pin" > "$work/$section.pin"
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/$section.key" 2>/dev/null
    openssl pkey -in "$work/$section.key" -pubout -out "$etc/public/artistlockers-$peer.pem"
    chmod 644 "$etc/public/artistlockers-$peer.pem"
  done
  umask 027
  WORK="$work" python3 - "$here/../appsettings.example.json" "$etc/appsettings.Production.json" <<'PY'
import json, os, sys
settings = json.load(open(sys.argv[1], encoding="utf-8"))
for section in ("Identity", "Gallery", "Tools", "Codex"):
    base = os.path.join(os.environ["WORK"], section)
    settings[section]["CertificateSha256"] = open(base + ".pin", encoding="ascii").read().strip()
    settings[section]["Signing"]["PrivateKeyPem"] = open(base + ".key", encoding="ascii").read()
json.dump(settings, open(sys.argv[2], "w", encoding="utf-8"), indent=2)
PY
  umask 022
  chown root:$svc $etc/appsettings.Production.json; chmod 640 $etc/appsettings.Production.json
  echo "Settings written to $etc/appsettings.Production.json; public keys in $etc/public."
fi

# Self-signed: only HAProxy (verify none, on the private network) and local health checks talk to it.
if [[ ! -f $etc/tls/artistlockers.crt ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -subj "/CN=ai-tlt-artistlockers" -addext "subjectAltName=$tls_names" \
    -keyout $etc/tls/artistlockers.key -out $etc/tls/artistlockers.crt 2>/dev/null
  chown root:$svc $etc/tls/artistlockers.key $etc/tls/artistlockers.crt
  chmod 640 $etc/tls/artistlockers.key; chmod 644 $etc/tls/artistlockers.crt
  echo "TLS certificate created ($tls_names)."
fi

install -m 644 "$here/ai-tlt-artistlockers.service" /etc/systemd/system/$svc.service
systemctl daemon-reload
systemctl enable $svc >/dev/null 2>&1
echo "Box ready. Next: register the public keys on identity, the gallery, the tools, the Codex, then install.sh <release.tgz>."
