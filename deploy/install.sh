#!/usr/bin/env bash
# Installs a published release on the box, keeping the previous one beside it, and waits for /health/live.
#   sudo bash install.sh <release.tgz>
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
release=${1:?release tarball}
svc=ai-tlt-artistlockers etc=/etc/ai-tlt-artistlockers opt=/opt/ai-tlt-artistlockers

rm -rf $opt.new; install -d -m 755 $opt.new
tar -xzf "$release" -C $opt.new
# Live settings stay in /etc; the publish carries only the template.
ln -sfn $etc/appsettings.Production.json $opt.new/appsettings.Production.json
chown -R root:root $opt.new
find $opt.new -type d -exec chmod 755 {} +; find $opt.new -type f -exec chmod 644 {} +

systemctl stop $svc 2>/dev/null || true
rm -rf $opt.prev; [[ -d $opt ]] && mv $opt $opt.prev
mv $opt.new $opt

systemctl start $svc
for _ in $(seq 1 30); do
  if curl -fsk --max-time 3 https://localhost:9440/health/live >/dev/null 2>&1; then
    echo "Up: $(curl -sk --max-time 5 https://localhost:9440/health/ready)"; exit 0
  fi
  sleep 1
done
echo "Not up after 30s; restoring previous release when available." >&2
if [[ -d $opt.prev ]]; then
  systemctl stop $svc || true
  mv "$opt" "$opt.failed-$(date +%Y%m%d%H%M%S)"
  mv "$opt.prev" "$opt"
  systemctl start $svc
fi
journalctl -u $svc -n 40 --no-pager >&2
exit 1
