#!/bin/sh
# Brings the Pi's copy of Direct Connection up to date with GitHub, and
# restarts the server only when something changed. Installed as
# /usr/local/sbin/direct-connection-update and run by the update timer — see
# deploy/pi/SETUP.md.
#
# Runs as root only to restart the service. Everything that touches what came
# from GitHub — git, npm — runs as the server's own user, dc. npm installs
# with --ignore-scripts: no package's install script runs here.
set -eu

DIR=/opt/direct-connection
as_dc() { runuser -u dc -- env HOME=/var/lib/direct-connection "$@"; }

cd "$DIR"
as_dc git fetch --quiet origin main
if [ "$(as_dc git rev-parse HEAD)" = "$(as_dc git rev-parse origin/main)" ]; then
  exit 0
fi
as_dc git merge --ff-only --quiet origin/main
as_dc npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
systemctl restart direct-connection
echo "Direct Connection updated to $(as_dc git rev-parse --short HEAD)"
