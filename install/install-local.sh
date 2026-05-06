#!/usr/bin/env bash
set -euo pipefail

# Local (non-Azure) installer for yt-azure-streamer.
# Deploys the same streaming stack on bare metal or a local VM,
# using local storage (or NFS/SMB/SSHFS) instead of Azure Blob Storage
# and local files instead of Key Vault.
#
# Usage: sudo ./install-local.sh

# ─── Colours ────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
fatal() { error "$@"; exit 1; }

prompt() {
  local varname="$1" question="$2" default="${3:-}"
  local input
  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "${CYAN}?${NC} ${question} [${default}]: ")" input
    printf -v "$varname" '%s' "${input:-$default}"
  else
    while true; do
      read -rp "$(echo -e "${CYAN}?${NC} ${question}: ")" input
      if [[ -n "$input" ]]; then
        printf -v "$varname" '%s' "$input"
        break
      fi
      warn "This field is required."
    done
  fi
}

# ─── Root check ─────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  fatal "This script must be run as root (use sudo)."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${CYAN}yt-azure-streamer — Local Installation${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
info "This installer configures the streaming stack without Azure dependencies."
info "Videos are served from local storage, NFS, SMB, or SSHFS."
echo ""

# ─── Detect distro ──────────────────────────────────────────────────

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  DISTRO_FAMILY=""
  case "$ID" in
    ubuntu|debian|linuxmint|pop) DISTRO_FAMILY="debian" ;;
    fedora|rhel|centos|rocky|alma) DISTRO_FAMILY="rhel" ;;
    *) DISTRO_FAMILY="unknown" ;;
  esac
else
  DISTRO_FAMILY="unknown"
fi

if [[ "$DISTRO_FAMILY" == "unknown" ]]; then
  warn "Unrecognized distro. Assuming Debian/Ubuntu-compatible package management."
  DISTRO_FAMILY="debian"
fi
ok "Detected: ${PRETTY_NAME:-Unknown} ($DISTRO_FAMILY family)"

# ─── Video storage configuration ───────────────────────────────────

echo ""
info "=== Video Storage ==="
echo ""
echo "  [1] Local directory (videos already on this machine)"
echo "  [2] NFS share (Linux NAS or server)"
echo "  [3] SMB/CIFS share (Windows share, Synology, QNAP, Samba)"
echo "  [4] SSHFS (remote Linux box over SSH)"
echo ""
prompt STORAGE_TYPE "Choose video storage type" "1"

VIDEO_DIR="/mnt/videos"
FSTAB_ENTRY=""
MOUNT_PACKAGES=""

case "$STORAGE_TYPE" in
  1)
    prompt VIDEO_DIR "Path to video directory" "/mnt/videos"
    if [[ ! -d "$VIDEO_DIR" ]]; then
      warn "Directory '$VIDEO_DIR' does not exist."
      read -rp "$(echo -e "${CYAN}?${NC} Create it? [Y/n]: ")" CREATE_DIR
      if [[ "${CREATE_DIR,,}" != "n" ]]; then
        mkdir -p "$VIDEO_DIR"
        ok "Created $VIDEO_DIR"
      fi
    fi
    ;;
  2)
    info "NFS share configuration"
    prompt NFS_SERVER "NFS server address (hostname or IP)"
    prompt NFS_EXPORT "Export path (e.g. /export/videos)"
    prompt NFS_VERSION "NFS version" "4"
    MOUNT_PACKAGES="nfs-common"
    mkdir -p "$VIDEO_DIR"
    FSTAB_ENTRY="${NFS_SERVER}:${NFS_EXPORT} ${VIDEO_DIR} nfs vers=${NFS_VERSION},defaults,_netdev 0 0"
    ;;
  3)
    info "SMB/CIFS share configuration"
    prompt SMB_SERVER "SMB server address (hostname or IP)"
    prompt SMB_SHARE "Share name (e.g. Videos)"
    prompt SMB_USER "Username"
    read -rsp "$(echo -e "${CYAN}?${NC} Password (hidden): ")" SMB_PASS
    echo ""
    prompt SMB_DOMAIN "Domain (press Enter for none)" ""
    MOUNT_PACKAGES="cifs-utils"
    mkdir -p "$VIDEO_DIR"
    # Write credentials file
    mkdir -p /etc/yt
    cat > /etc/yt/smb-credentials <<EOF
username=${SMB_USER}
password=${SMB_PASS}
EOF
    if [[ -n "$SMB_DOMAIN" ]]; then
      echo "domain=${SMB_DOMAIN}" >> /etc/yt/smb-credentials
    fi
    chmod 600 /etc/yt/smb-credentials
    FSTAB_ENTRY="//${SMB_SERVER}/${SMB_SHARE} ${VIDEO_DIR} cifs credentials=/etc/yt/smb-credentials,_netdev,uid=0,gid=0,file_mode=0644,dir_mode=0755 0 0"
    ;;
  4)
    info "SSHFS configuration"
    prompt SSHFS_USER "Remote SSH username"
    prompt SSHFS_HOST "Remote host (hostname or IP)"
    prompt SSHFS_PATH "Remote path (e.g. /home/user/videos)"
    prompt SSHFS_KEY "SSH key path" "$HOME/.ssh/id_ed25519"
    MOUNT_PACKAGES="sshfs"
    mkdir -p "$VIDEO_DIR"
    if [[ ! -f "$SSHFS_KEY" ]]; then
      warn "SSH key '$SSHFS_KEY' not found. Mount may fail without a valid key."
    fi
    FSTAB_ENTRY="${SSHFS_USER}@${SSHFS_HOST}:${SSHFS_PATH} ${VIDEO_DIR} fuse.sshfs _netdev,IdentityFile=${SSHFS_KEY},allow_other,reconnect,ServerAliveInterval=15 0 0"
    ;;
  *)
    fatal "Invalid choice. Expected 1-4."
    ;;
esac

ok "Video directory: $VIDEO_DIR"

# ─── Stream key ─────────────────────────────────────────────────────

echo ""
info "=== YouTube Stream Key ==="
echo ""
read -rsp "$(echo -e "${CYAN}?${NC} YouTube stream key (hidden; press Enter to set later): ")" STREAM_KEY
echo ""
if [[ -n "$STREAM_KEY" ]]; then
  ok "Stream key provided."
else
  warn "No stream key set. Set it later via the web UI or:"
  echo "    echo 'YOUR_KEY' | sudo tee /etc/yt/secrets/stream-key"
fi

# ─── Web UI credentials ────────────────────────────────────────────

echo ""
info "=== Web UI Credentials ==="
info "The web UI uses HTTP basic auth."
echo ""
prompt WEB_USER "Web UI username (press Enter to skip)" ""
WEB_PASS=""
if [[ -n "$WEB_USER" ]]; then
  while true; do
    read -rsp "$(echo -e "${CYAN}?${NC} Web UI password (hidden): ")" WEB_PASS
    echo ""
    if [[ -z "$WEB_PASS" ]]; then
      warn "Password cannot be empty."
      continue
    fi
    read -rsp "$(echo -e "${CYAN}?${NC} Confirm password: ")" WEB_PASS2
    echo ""
    if [[ "$WEB_PASS" != "$WEB_PASS2" ]]; then
      warn "Passwords do not match. Try again."
      continue
    fi
    break
  done
  ok "Web UI credentials set."
else
  warn "No web UI credentials set. The UI will be unprotected."
  warn "Set credentials later by running: sudo /usr/local/bin/setup-local-auth.sh"
fi

# ─── Hostname / domain ──────────────────────────────────────────────

echo ""
info "=== Web Access ==="
echo ""
DEFAULT_HOST=$(hostname -f 2>/dev/null || hostname)
prompt SITE_HOST "Hostname or domain for web UI" "$DEFAULT_HOST"

# Determine if this looks like a real domain (for Let's Encrypt) or local access
if [[ "$SITE_HOST" =~ \. ]] && ! [[ "$SITE_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && ! [[ "$SITE_HOST" =~ \.local$ ]]; then
  prompt USE_TLS "Enable automatic TLS via Let's Encrypt? (y/n)" "y"
  if [[ "${USE_TLS,,}" == "y" ]]; then
    SITE_ADDRESS="$SITE_HOST"
    ok "TLS enabled: Caddy will auto-provision Let's Encrypt certificate for $SITE_HOST"
  else
    SITE_ADDRESS="http://${SITE_HOST}"
    ok "Plain HTTP on $SITE_HOST"
  fi
else
  SITE_ADDRESS="http://${SITE_HOST}"
  ok "Plain HTTP on $SITE_HOST"
fi

# ─── Name prefix ────────────────────────────────────────────────────

echo ""
prompt NAME_PREFIX "Instance name (used for identification)" "streamer"

# ─── Summary ────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${CYAN}Installation Summary${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Instance name:   $NAME_PREFIX"
echo "  Video storage:   $VIDEO_DIR"
if [[ -n "$FSTAB_ENTRY" ]]; then
  echo "  Mount type:      $(echo "$FSTAB_ENTRY" | awk '{print $3}')"
fi
echo "  Stream key:      $(if [[ -n "$STREAM_KEY" ]]; then echo 'provided'; else echo 'not set (set later)'; fi)"
echo "  Web UI creds:    $(if [[ -n "$WEB_USER" ]]; then echo "${WEB_USER} / ********"; else echo 'not set'; fi)"
echo "  Site address:    $SITE_ADDRESS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -rp "$(echo -e "${CYAN}?${NC} Proceed with installation? [Y/n]: ")" PROCEED
if [[ "${PROCEED,,}" == "n" ]]; then
  info "Installation cancelled."
  exit 0
fi

# ─── Install packages ───────────────────────────────────────────────

echo ""
info "Installing packages..."

if [[ "$DISTRO_FAMILY" == "debian" ]]; then
  # Add Caddy repository
  if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg >/dev/null 2>&1
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  fi
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm ffmpeg caddy fonts-dejavu-core $MOUNT_PACKAGES
elif [[ "$DISTRO_FAMILY" == "rhel" ]]; then
  dnf install -y nodejs npm ffmpeg caddy google-noto-sans-fonts $MOUNT_PACKAGES
fi

# Disable the default apt-installed caddy service; we use our own unit
systemctl stop caddy.service 2>/dev/null || true
systemctl disable caddy.service 2>/dev/null || true

ok "Packages installed."

# ─── Configure mount (if remote storage) ───────────────────────────

if [[ -n "$FSTAB_ENTRY" ]]; then
  info "Configuring video storage mount..."

  # Test mount first
  info "Testing mount..."
  if mount -a -o _netdev 2>/dev/null && mountpoint -q "$VIDEO_DIR" 2>/dev/null; then
    ok "Mount verified."
  else
    # Add to fstab and try
    if ! grep -qF "$VIDEO_DIR" /etc/fstab; then
      echo "$FSTAB_ENTRY" >> /etc/fstab
    fi
    mount "$VIDEO_DIR" 2>/dev/null || true
    if mountpoint -q "$VIDEO_DIR" 2>/dev/null; then
      ok "Mount configured and verified."
    else
      warn "Could not verify mount at '$VIDEO_DIR'. You may need to configure it manually."
      warn "fstab entry added: $FSTAB_ENTRY"
    fi
  fi
else
  # Ensure local directory exists
  mkdir -p "$VIDEO_DIR"
fi

# ─── Write configuration ───────────────────────────────────────────

info "Writing configuration..."

mkdir -p /etc/yt/secrets
chmod 700 /etc/yt/secrets

# Mode file
echo "local" > /etc/yt/mode

# Name prefix (used by scripts for identification)
echo "$NAME_PREFIX" > /etc/yt/nameprefix

# Local config
cat > /etc/yt/local.conf <<EOF
VIDEO_DIR=${VIDEO_DIR}
SITE_ADDRESS=${SITE_ADDRESS}
EOF

# Stream key
if [[ -n "$STREAM_KEY" ]]; then
  echo "$STREAM_KEY" > /etc/yt/secrets/stream-key
  chmod 600 /etc/yt/secrets/stream-key
fi

# Schedule (initial)
if [[ ! -f /etc/yt/schedule.json ]]; then
  cp "$SCRIPT_DIR/schedule.json" /etc/yt/schedule.json
  info "Initial schedule copied to /etc/yt/schedule.json"
fi

ok "Configuration written to /etc/yt/"

# ─── Caddy configuration ───────────────────────────────────────────

info "Configuring Caddy..."
mkdir -p /etc/yt/caddy
sed "s|CADDY_SITE_ADDRESS|${SITE_ADDRESS}|g" "$SCRIPT_DIR/caddy/Caddyfile" > /etc/yt/caddy/Caddyfile

# Web UI auth
if [[ -n "$WEB_USER" && -n "$WEB_PASS" ]]; then
  HASH=$(caddy hash-password --plaintext "$WEB_PASS")
  cat > /etc/yt/caddy/auth.conf <<EOF
basic_auth {
  ${WEB_USER} ${HASH}
}
EOF
  chmod 600 /etc/yt/caddy/auth.conf
  ok "Web UI authentication configured."
else
  echo "# No auth configured" > /etc/yt/caddy/auth.conf
  warn "Web UI has no authentication. Set it later with: sudo /usr/local/bin/setup-local-auth.sh"
fi

# ─── Install scripts ───────────────────────────────────────────────

info "Installing scripts to /usr/local/bin..."
install -m 755 "$SCRIPT_DIR/services/streamer/streamer.sh"   /usr/local/bin/streamer.sh
install -m 755 "$SCRIPT_DIR/services/scheduler/scheduler.sh" /usr/local/bin/scheduler.sh
install -m 755 "$SCRIPT_DIR/scripts/generate-playlist.sh"    /usr/local/bin/generate-playlist.sh
install -m 755 "$SCRIPT_DIR/scripts/update.sh"               /usr/local/bin/yt-update.sh

# Create a simple local auth setup script for later use
cat > /usr/local/bin/setup-local-auth.sh <<'AUTHEOF'
#!/usr/bin/env bash
set -euo pipefail
echo "Set web UI credentials for yt-azure-streamer"
read -rp "Username: " USER
read -rsp "Password: " PASS; echo ""
HASH=$(caddy hash-password --plaintext "$PASS")
mkdir -p /etc/yt/caddy
cat > /etc/yt/caddy/auth.conf <<EOF
basic_auth {
  ${USER} ${HASH}
}
EOF
chmod 600 /etc/yt/caddy/auth.conf
systemctl reload caddy.service 2>/dev/null || systemctl restart caddy.service
echo "Authentication configured. Caddy reloaded."
AUTHEOF
chmod 755 /usr/local/bin/setup-local-auth.sh

ok "Scripts installed."

# ─── Install systemd units ─────────────────────────────────────────

info "Installing systemd units..."
install -m 644 "$SCRIPT_DIR/systemd/streamer-local.service" /etc/systemd/system/streamer.service
install -m 644 "$SCRIPT_DIR/systemd/scheduler.service"      /etc/systemd/system/scheduler.service
install -m 644 "$SCRIPT_DIR/systemd/caddy.service"          /etc/systemd/system/caddy.service
install -m 644 "$SCRIPT_DIR/systemd/web-backend.service"    /etc/systemd/system/web-backend.service

systemctl daemon-reload

# ─── Clone repo to /opt/yt (if not already there) ──────────────────

if [[ ! -d /opt/yt ]]; then
  info "Cloning repository to /opt/yt..."
  REPO_URL=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)
  if [[ -n "$REPO_URL" ]]; then
    git clone "$REPO_URL" /opt/yt
    ok "Cloned to /opt/yt"
  else
    # Fallback: copy current directory
    cp -a "$SCRIPT_DIR" /opt/yt
    ok "Copied to /opt/yt"
  fi
elif [[ "$SCRIPT_DIR" != "/opt/yt" ]]; then
  info "/opt/yt already exists — skipping clone."
fi

# ─── Enable & start services ───────────────────────────────────────

info "Enabling services..."
systemctl enable streamer.service
systemctl enable scheduler.service
systemctl enable caddy.service
systemctl enable web-backend.service

info "Starting services..."
systemctl start web-backend.service
systemctl start caddy.service
systemctl start scheduler.service
# Note: scheduler will start/stop streamer based on schedule

ok "Services started."

# ─── Done ───────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Installation Complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Web UI:    $SITE_ADDRESS"
echo "  Videos:    $VIDEO_DIR"
echo ""
if [[ -z "$STREAM_KEY" ]]; then
  echo "  Set your YouTube stream key:"
  echo "    echo 'YOUR_KEY' | sudo tee /etc/yt/secrets/stream-key"
  echo ""
fi
if [[ -z "$WEB_USER" ]]; then
  echo "  Set web UI credentials:"
  echo "    sudo /usr/local/bin/setup-local-auth.sh"
  echo ""
fi
echo "  Manage schedule via the web UI or edit /etc/yt/schedule.json"
echo "  Update the installation:  sudo /usr/local/bin/yt-update.sh"
echo "  View logs:                journalctl -u streamer -f"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
