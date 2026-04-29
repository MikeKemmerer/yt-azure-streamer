#!/usr/bin/env bash
set -euo pipefail

# This script is intended to run inside the VM via cloud-init.
# It installs streamer, scheduler, and schedule-sync into /usr/local/bin
# and installs/enables their systemd units.

echo "Installing service scripts into /usr/local/bin..."

install -m 755 /opt/yt/services/streamer/streamer.sh /usr/local/bin/streamer.sh
install -m 755 /opt/yt/services/scheduler/scheduler.sh /usr/local/bin/scheduler.sh
install -m 755 /opt/yt/scripts/schedule-sync.sh /usr/local/bin/schedule-sync.sh

echo "Installing systemd units..."

install -m 644 /opt/yt/systemd/streamer.service /etc/systemd/system/streamer.service
install -m 644 /opt/yt/systemd/scheduler.service /etc/systemd/system/scheduler.service
install -m 644 /opt/yt/systemd/schedule-sync.service /etc/systemd/system/schedule-sync.service
install -m 644 /opt/yt/systemd/schedule-sync.timer /etc/systemd/system/schedule-sync.timer

echo "Reloading systemd..."
systemctl daemon-reload

echo "Enabling services and timers..."
systemctl enable streamer.service
systemctl enable scheduler.service
systemctl enable schedule-sync.timer

echo "Installation complete."
