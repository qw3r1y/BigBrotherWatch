#!/bin/bash
# ============================================================================
# OpSec Core — shared shell function library
#
# Distro-agnostic install/configure/scan/panic functions used by the OpSec
# web dashboard (server/opsec_server.py) and available for direct CLI use:
#   source core/opsec_core.sh
#   install_tor
#
# All output is plain (no ANSI codes) so it can be streamed as-is into the
# dashboard's live console panel.
# ============================================================================

set -u

# ---------------------------------------------------------------------------
# Package manager detection
# ---------------------------------------------------------------------------
detect_pkg_manager() {
    if command -v apt-get >/dev/null 2>&1; then echo "apt";
    elif command -v dnf >/dev/null 2>&1; then echo "dnf";
    elif command -v pacman >/dev/null 2>&1; then echo "pacman";
    elif command -v zypper >/dev/null 2>&1; then echo "zypper";
    else echo "unknown"; fi
}

PKG_MANAGER="$(detect_pkg_manager)"

# Whether privileged commands get a `sudo` prefix. The dashboard already
# requires running as root to start at all (see opsec_server.py's
# geteuid() check), so this rarely changes actual behavior — but some
# minimal environments don't have `sudo` installed/configured at all, and
# forcing it there would fail every single command. OPSEC_USE_SUDO is set
# by the web UI's "Use sudo" toggle (server/opsec_server.py passes it
# through as an env var); default is on, matching prior behavior exactly.
if [ "${OPSEC_USE_SUDO:-1}" = "0" ]; then
    SUDO=""
else
    SUDO="sudo"
fi

# Debian/Ubuntu package scripts (tzdata, locales, console-setup, keyboard-
# configuration, ...) can drop into an interactive debconf prompt — a
# language/timezone/keyboard menu — the moment they run without a frontend
# set. That prompt often talks to /dev/tty directly rather than stdout, so
# it never reaches the web console at all; it silently stalls the install
# waiting for input nobody can give it from the browser. These flags force
# apt/dpkg to always pick the packaged default and never block on a prompt.
APT_NONINTERACTIVE=($SUDO env DEBIAN_FRONTEND=noninteractive DEBCONF_NONINTERACTIVE_SEEN=true)
APT_SAFE_OPTS=(-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

pkg_update() {
    case "$PKG_MANAGER" in
        apt)    "${APT_NONINTERACTIVE[@]}" apt-get update -y ;;
        dnf)    $SUDO dnf makecache -y ;;
        pacman) $SUDO pacman -Sy --noconfirm ;;
        zypper) $SUDO zypper refresh ;;
        *) echo "[!] Unknown package manager, cannot update."; return 1 ;;
    esac
}

# pkg_install <apt_name> <dnf_name> <pacman_name> [zypper_name]
pkg_install() {
    local apt_name="$1" dnf_name="$2" pacman_name="$3" zypper_name="${4:-$2}"
    local name=""
    case "$PKG_MANAGER" in
        apt)    name="$apt_name" ;;
        dnf)    name="$dnf_name" ;;
        pacman) name="$pacman_name" ;;
        zypper) name="$zypper_name" ;;
    esac
    if [ -z "$name" ] || [ "$name" = "-" ]; then
        echo "[!] This package is not available on your distro's package manager. Skipping."
        return 2
    fi
    echo "[*] Installing $name via $PKG_MANAGER..."
    if [ "$PKG_MANAGER" = "apt" ]; then
        # Clear out anything left half-configured by an earlier failed
        # install before it can block this one too: dpkg tries to finish
        # configuring EVERY pending package on each run, not just the one
        # you asked for, so one broken leftover (e.g. a mail/AV package
        # that needed input it never got) can fail every install after it.
        "${APT_NONINTERACTIVE[@]}" dpkg --configure -a >/dev/null 2>&1 || true
    fi
    case "$PKG_MANAGER" in
        apt)    "${APT_NONINTERACTIVE[@]}" apt-get install -y "${APT_SAFE_OPTS[@]}" $name ;;
        dnf)    $SUDO dnf install -y $name ;;
        pacman) $SUDO pacman -S --noconfirm --needed $name ;;
        zypper) $SUDO zypper install -y $name ;;
        *) echo "[!] Unknown package manager."; return 1 ;;
    esac
    local install_rc=$?
    if [ $install_rc -eq 0 ]; then
        echo "[+] $name installed successfully."
        return 0
    fi
    # apt/dpkg can exit non-zero even when $name itself installed fine, if
    # some UNRELATED package on the system is stuck half-configured (dpkg
    # tries to finish configuring everything pending, not just $name, as
    # part of the same run). Check what we actually asked for before
    # calling it a failure.
    if [ "$PKG_MANAGER" = "apt" ]; then
        local all_ok=1 pkg
        for pkg in $name; do
            dpkg -s "$pkg" 2>/dev/null | grep -q "^Status:.*installed" || all_ok=0
        done
        if [ "$all_ok" = "1" ]; then
            echo "[!] apt reported an error, but $name is actually installed. Some OTHER package on this system is broken."
            echo "[*] Run 'Repair Package Manager' from Configure to clean that up."
            return 0
        fi
    fi
    echo "[-] Failed to install $name."
    return 1
}

pkg_remove() {
    local apt_name="$1" dnf_name="$2" pacman_name="$3"
    local name=""
    case "$PKG_MANAGER" in
        apt)    name="$apt_name" ;;
        dnf)    name="$dnf_name" ;;
        pacman) name="$pacman_name" ;;
    esac
    [ -z "$name" ] || [ "$name" = "-" ] && return 0
    echo "[*] Removing $name..."
    case "$PKG_MANAGER" in
        apt)    "${APT_NONINTERACTIVE[@]}" apt-get remove --purge -y $name && "${APT_NONINTERACTIVE[@]}" apt-get autoremove -y ;;
        dnf)    $SUDO dnf remove -y $name ;;
        pacman) $SUDO pacman -Rns --noconfirm $name ;;
    esac
}

# Clears packages stuck "half-configured" from an earlier failed install so
# they stop blocking every install after them. pkg_install already runs
# this automatically before each install, but it's exposed as its own
# Configure action too, for a package already stuck badly enough to need a
# second pass (apt-get install -f pulls in whatever missing dependency was
# the actual cause).
repair_packages() {
    case "$PKG_MANAGER" in
        apt)
            echo "[*] Finishing any half-configured packages..."
            "${APT_NONINTERACTIVE[@]}" dpkg --configure -a
            echo "[*] Fixing broken dependencies..."
            "${APT_NONINTERACTIVE[@]}" apt-get install -f -y "${APT_SAFE_OPTS[@]}"
            echo "[+] Repair pass finished. Try the install again."
            ;;
        dnf)
            echo "[*] Checking for broken dependencies..."
            $SUDO dnf check || true
            echo "[+] dnf doesn't leave packages half-configured the way dpkg can; nothing else to repair here."
            ;;
        pacman)
            echo "[!] pacman doesn't use this kind of two-phase install, so there's nothing to repair."
            return 1
            ;;
        *)
            echo "[!] No repair routine wired up for $PKG_MANAGER."
            return 1
            ;;
    esac
}

enable_service() {
    local svc="$1"
    $SUDO systemctl enable "$svc" >/dev/null 2>&1
    $SUDO systemctl restart "$svc" >/dev/null 2>&1
    if systemctl is-active --quiet "$svc"; then
        echo "[+] $svc is enabled and running."
    else
        echo "[!] $svc did not start — check 'systemctl status $svc'."
    fi
}

# ---------------------------------------------------------------------------
# Install functions
# ---------------------------------------------------------------------------

install_dependencies() {
    echo "[*] Installing build dependencies..."
    pkg_update
    pkg_install "build-essential wget tar xterm libsystemd-dev libssl-dev libpcre2-dev libz-dev" \
                "make gcc gcc-c++ wget tar systemd-devel openssl-devel pcre2-devel zlib-devel" \
                "base-devel wget tar"
    echo "[+] Dependencies ready."
}

install_tor() {
    pkg_install "tor" "tor" "tor"
    enable_service tor
    echo "[+] Tor SOCKS proxy available at 127.0.0.1:9050."
}

install_wireguard() {
    pkg_install "wireguard" "wireguard-tools" "wireguard-tools"
    echo "[+] WireGuard tools installed. Use the 'Generate WireGuard Keypair' action to create keys."
}

install_openvpn() {
    pkg_install "openvpn" "openvpn" "openvpn"
    echo "[+] OpenVPN installed. Place your .ovpn configs in /etc/openvpn/."
}

install_strongswan() {
    pkg_install "strongswan" "strongswan" "strongswan"
    echo "[+] strongSwan installed."
}

install_firejail() {
    if pkg_install "firejail" "firejail" "firejail"; then
        return 0
    fi
    echo "[*] Falling back to building Firejail 0.9.72 from source..."
    pkg_install "build-essential wget tar" "make gcc wget tar" "base-devel wget tar"
    local tmp="/tmp/firejail_install"
    mkdir -p "$tmp" && cd "$tmp" || return 1
    wget -O firejail.tar.xz "https://github.com/netblue30/firejail/releases/download/0.9.72/firejail-0.9.72.tar.xz" || { echo "[-] Download failed."; return 1; }
    tar -xf firejail.tar.xz
    cd firejail-0.9.72 || return 1
    ./configure >/dev/null 2>&1 && make >/dev/null 2>&1 && $SUDO make install >/dev/null 2>&1
    if command -v firejail >/dev/null 2>&1; then
        echo "[+] Firejail built and installed from source."
    else
        echo "[-] Firejail source build failed."
        return 1
    fi
}

install_ufw() {
    pkg_install "ufw" "-" "ufw"
    $SUDO ufw --force enable >/dev/null 2>&1
    $SUDO ufw default deny incoming >/dev/null 2>&1
    $SUDO ufw default allow outgoing >/dev/null 2>&1
    echo "[+] UFW enabled (deny incoming / allow outgoing)."
}

install_opensnitch() {
    pkg_install "opensnitch" "opensnitch" "opensnitch"
    enable_service opensnitchd
    echo "[+] Opensnitch daemon running. Launch the GUI manually with 'opensnitch-ui'."
}

install_tor_browser() {
    if pkg_install "torbrowser-launcher" "torbrowser-launcher" "-"; then
        echo "[*] Running torbrowser-launcher to fetch and verify the latest Tor Browser..."
        torbrowser-launcher --settings >/dev/null 2>&1
        echo "[+] Tor Browser Launcher installed. Run 'torbrowser-launcher' to download & launch it."
        return 0
    fi
    echo "[!] torbrowser-launcher isn't packaged for this distro."
    echo "[*] Download Tor Browser manually from https://www.torproject.org/download/ and verify its signature."
    return 1
}

install_dnscrypt() {
    pkg_install "dnscrypt-proxy" "dnscrypt-proxy" "dnscrypt-proxy"
    echo "[+] dnscrypt-proxy installed. Use the 'Enable DNSCrypt (Cloudflare)' action to configure it."
}

install_exiftool() {
    pkg_install "libimage-exiftool-perl" "perl-Image-ExifTool" "perl-image-exiftool"
    echo "[+] Exiftool installed. Strip metadata with: exiftool -all= <file>"
}

install_bleachbit() {
    pkg_install "bleachbit" "bleachbit" "bleachbit"
}

install_keepassxc() {
    pkg_install "keepassxc" "keepassxc" "keepassxc"
}

install_signal() {
    if [ "$PKG_MANAGER" = "apt" ]; then
        curl -s https://updates.signal.org/desktop/apt/keys.asc | $SUDO gpg --dearmor -o /usr/share/keyrings/signal-desktop-keyring.gpg
        echo "deb [arch=amd64 signed-by=/usr/share/keyrings/signal-desktop-keyring.gpg] https://updates.signal.org/desktop/apt xenial main" | \
            $SUDO tee /etc/apt/sources.list.d/signal-xenial.list >/dev/null
        pkg_update
        pkg_install "signal-desktop" "-" "-"
    else
        echo "[!] Automatic Signal install is only wired up for apt-based distros."
        echo "[*] On this distro, install Signal via Flatpak: flatpak install flathub org.signal.Signal"
        return 1
    fi
}

install_fail2ban() {
    pkg_install "fail2ban" "fail2ban" "fail2ban"
    enable_service fail2ban
}

install_rkhunter() {
    pkg_install "rkhunter" "rkhunter" "rkhunter"
    $SUDO rkhunter --update >/dev/null 2>&1
    $SUDO rkhunter --propupd >/dev/null 2>&1
    echo "[+] rkhunter installed, database updated."
}

install_chkrootkit() {
    pkg_install "chkrootkit" "chkrootkit" "-"
}

install_clamav() {
    pkg_install "clamav" "clamav" "clamav"
    $SUDO systemctl stop clamav-freshclam >/dev/null 2>&1
    $SUDO freshclam >/dev/null 2>&1
    $SUDO systemctl start clamav-freshclam >/dev/null 2>&1
    echo "[+] ClamAV installed and virus database updated."
}

install_suricata() {
    pkg_install "suricata" "suricata" "suricata"
    $SUDO suricata-update >/dev/null 2>&1
    enable_service suricata
}

install_ossec() {
    echo "[*] Cloning and building OSSEC HIDS (this can take a few minutes)..."
    pkg_install "build-essential make gcc" "make gcc" "base-devel"
    local tmp="/tmp/ossec_install"
    rm -rf "$tmp"
    git clone --depth 1 https://github.com/ossec/ossec-hids.git "$tmp" || { echo "[-] git clone failed."; return 1; }
    cd "$tmp" || return 1
    $SUDO ./install.sh
    echo "[+] OSSEC installation finished."
}

install_macchanger() {
    pkg_install "macchanger" "macchanger" "macchanger"
    echo "[+] macchanger installed. Randomize with: sudo macchanger -r <interface>"
}

install_lynis() {
    pkg_install "lynis" "lynis" "lynis"
    echo "[+] Lynis installed. Run a full audit from the Scans tab, or: sudo lynis audit system"
}

install_auditd() {
    pkg_install "auditd" "audit" "audit"
    enable_service auditd
    echo "[+] auditd installed and running. Audit events are logged to /var/log/audit/audit.log."
}

install_usbguard() {
    pkg_install "usbguard" "usbguard" "usbguard"
    command -v usbguard >/dev/null 2>&1 || { echo "[-] USBGuard install failed."; return 1; }
    if [ ! -s /etc/usbguard/rules.conf ]; then
        echo "[*] Generating an initial allow-list from currently-connected USB devices..."
        $SUDO mkdir -p /etc/usbguard
        $SUDO sh -c 'usbguard generate-policy > /etc/usbguard/rules.conf' 2>/dev/null
    fi
    enable_service usbguard
    echo "[+] USBGuard installed. Devices connected right now are allow-listed; new ones are blocked."
    echo "[!] Review /etc/usbguard/rules.conf before you rely on it, so you don't lock out your own keyboard/mouse."
}

install_mullvad() {
    case "$PKG_MANAGER" in
        apt)
            $SUDO curl -fsSLo /usr/share/keyrings/mullvad-keyring.asc https://repository.mullvad.net/deb/mullvad-keyring.asc || { echo "[-] Failed to fetch Mullvad signing key."; return 1; }
            echo "deb [signed-by=/usr/share/keyrings/mullvad-keyring.asc arch=$(dpkg --print-architecture)] https://repository.mullvad.net/deb/stable $(lsb_release -cs 2>/dev/null || echo stable) main" | \
                $SUDO tee /etc/apt/sources.list.d/mullvad.list >/dev/null
            pkg_update
            pkg_install "mullvad-vpn" "-" "-"
            ;;
        dnf)
            $SUDO dnf config-manager --add-repo https://repository.mullvad.net/rpm/stable/mullvad.repo >/dev/null 2>&1
            pkg_install "-" "mullvad-vpn" "-"
            ;;
        pacman)
            echo "[!] Mullvad ships via the AUR package 'mullvad-vpn-bin', install it with your AUR helper (e.g. yay -S mullvad-vpn-bin)."
            return 1
            ;;
        *)
            echo "[!] Automatic Mullvad install isn't wired up for $PKG_MANAGER."
            echo "[*] Download it from https://mullvad.net/en/download/vpn/linux"
            return 1
            ;;
    esac
    echo "[+] Mullvad VPN installed. Launch the app, or use the CLI: 'mullvad account login' then 'mullvad connect'."
}

install_protonvpn() {
    case "$PKG_MANAGER" in
        apt)
            local deb="/tmp/protonvpn-stable-release.deb"
            curl -fsSLo "$deb" "https://repo.protonvpn.com/debian/dists/stable/main/binary-all/protonvpn-stable-release_1.0.8_all.deb" || { echo "[-] Download failed."; return 1; }
            "${APT_NONINTERACTIVE[@]}" dpkg -i "$deb"
            pkg_update
            pkg_install "proton-vpn-gnome-desktop" "-" "-"
            ;;
        dnf)
            $SUDO dnf install -y "https://repo.protonvpn.com/fedora-$(rpm -E %fedora)-stable/protonvpn-stable-release/protonvpn-stable-release-1.0.2-1.noarch.rpm" >/dev/null 2>&1
            pkg_install "-" "proton-vpn-gnome-desktop" "-"
            ;;
        *)
            echo "[!] Automatic ProtonVPN install isn't wired up for $PKG_MANAGER."
            echo "[*] See the official Linux client guide: https://protonvpn.com/support/official-linux-client/"
            return 1
            ;;
    esac
    echo "[+] ProtonVPN installed. Launch it from your app menu (Proton VPN) or the CLI 'protonvpn-app'."
}

install_onionshare() {
    if pkg_install "onionshare" "onionshare" "onionshare"; then
        echo "[+] OnionShare installed. Launch it from your app menu, or use 'onionshare-cli --help'."
        return 0
    fi
    echo "[!] OnionShare isn't in this distro's repositories."
    echo "[*] Install it via Flatpak: flatpak install flathub org.onionshare.OnionShare"
    return 1
}

install_veracrypt() {
    if [ "$PKG_MANAGER" = "pacman" ]; then
        pkg_install "-" "-" "veracrypt" && { echo "[+] VeraCrypt installed."; return 0; }
    fi
    if command -v flatpak >/dev/null 2>&1; then
        echo "[*] Installing VeraCrypt via Flatpak..."
        $SUDO flatpak install -y flathub org.veracrypt.VeraCrypt && { echo "[+] VeraCrypt installed via Flatpak (run: flatpak run org.veracrypt.VeraCrypt)."; return 0; }
    fi
    echo "[!] VeraCrypt isn't in your distro's default repositories."
    echo "[*] Install Flatpak first, then: flatpak install flathub org.veracrypt.VeraCrypt"
    echo "    Or download the official installer from https://www.veracrypt.fr/en/Downloads.html"
    return 1
}

install_cryptomator() {
    if [ "$PKG_MANAGER" = "apt" ]; then
        if command -v add-apt-repository >/dev/null 2>&1; then
            $SUDO add-apt-repository -y ppa:sebastian-stenzel/cryptomator >/dev/null 2>&1
            pkg_update
            pkg_install "cryptomator" "-" "-" && { echo "[+] Cryptomator installed."; return 0; }
        fi
    fi
    if command -v flatpak >/dev/null 2>&1; then
        echo "[*] Installing Cryptomator via Flatpak..."
        $SUDO flatpak install -y flathub org.cryptomator.Cryptomator && { echo "[+] Cryptomator installed via Flatpak."; return 0; }
    fi
    echo "[!] Couldn't install Cryptomator automatically."
    echo "[*] Install Flatpak, then: flatpak install flathub org.cryptomator.Cryptomator"
    return 1
}

install_secure_delete() {
    pkg_install "secure-delete" "-" "-"
    echo "[+] secure-delete installed. Wipe a file: srm -v <file>. Wipe free space: sfill -v <mountpoint>."
}

install_auto_updates() {
    case "$PKG_MANAGER" in
        apt)
            pkg_install "unattended-upgrades" "-" "-"
            echo 'Unattended-Upgrade::Allowed-Origins { "\${distro_id}:\${distro_codename}-security"; };' | \
                $SUDO tee /etc/apt/apt.conf.d/51unattended-upgrades-opsec >/dev/null
            $SUDO systemctl enable --now unattended-upgrades >/dev/null 2>&1
            echo "[+] Unattended security upgrades enabled."
            ;;
        dnf)
            pkg_install "-" "dnf-automatic" "-"
            $SUDO sed -i 's/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf 2>/dev/null
            enable_service dnf-automatic-install.timer
            ;;
        *)
            echo "[!] No automatic-update mechanism wired up for $PKG_MANAGER — apply updates manually."
            return 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Configure actions
# ---------------------------------------------------------------------------

# configure_ports "22 21 3389 8080"
configure_ports() {
    local ports="${1:-22 21 3389}"
    if ! command -v ufw >/dev/null 2>&1; then
        echo "[-] UFW is not installed, install it first."
        return 1
    fi
    # Validate before handing anything to ufw: the ports field is free text
    # from the dashboard, so a typo or pasted junk shouldn't silently no-op
    # while still printing a false "blocked" success line (the previous
    # version discarded ufw's own exit code and always claimed success).
    local blocked=0 skipped=0
    for p in $ports; do
        if ! [[ "$p" =~ ^[0-9]+$ ]] || [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then
            echo "[!] Skipping '$p', not a valid port number (1-65535)."
            skipped=$((skipped + 1))
            continue
        fi
        if $SUDO ufw deny "$p" >/dev/null 2>&1; then
            echo "[+] Port $p blocked."
            blocked=$((blocked + 1))
        else
            echo "[-] ufw rejected port $p."
        fi
    done
    if [ "$blocked" -eq 0 ]; then
        echo "[-] No valid ports were blocked, leaving firewall defaults unchanged."
        return 1
    fi
    $SUDO ufw default deny incoming >/dev/null 2>&1
    $SUDO ufw default allow outgoing >/dev/null 2>&1
    $SUDO ufw reload >/dev/null 2>&1
    echo "[+] UFW rules reloaded ($blocked blocked, $skipped skipped)."
}

configure_dnscrypt() {
    if ! command -v dnscrypt-proxy >/dev/null 2>&1; then
        echo "[-] dnscrypt-proxy is not installed."
        return 1
    fi
    local cfg="/etc/dnscrypt-proxy/dnscrypt-proxy.toml"
    if [ -f "$cfg" ]; then
        $SUDO sed -i "s/^#\\?server_names = \\[.*\\]/server_names = ['cloudflare']/" "$cfg"
    fi
    $SUDO systemctl enable dnscrypt-proxy >/dev/null 2>&1
    $SUDO systemctl restart dnscrypt-proxy >/dev/null 2>&1
    echo "[+] dnscrypt-proxy set to Cloudflare and restarted."
}

configure_fail2ban() {
    if ! command -v fail2ban-client >/dev/null 2>&1; then
        echo "[-] Fail2ban is not installed."
        return 1
    fi
    $SUDO bash -c "cat > /etc/fail2ban/jail.local" <<'EOL'
[DEFAULT]
bantime  = 900
findtime = 600
maxretry = 3

[sshd]
enabled  = true
port     = ssh
maxretry = 3
EOL
    $SUDO systemctl restart fail2ban >/dev/null 2>&1
    echo "[+] Fail2ban baseline jail (sshd, 3 tries / 15 min ban) applied."
}

# configure_suricata_iface "eth0"
configure_suricata_iface() {
    local iface="$1"
    local cfg="/etc/suricata/suricata.yaml"
    [ -z "$iface" ] && { echo "[-] No interface given."; return 1; }
    # $iface reaches here from the dashboard's own request, not just the
    # dropdown it renders — validate before it goes anywhere near sed. It's
    # interpolated straight into a sed s/// below; an unvalidated value
    # containing "/" or ";" can break out of the substitution and, with
    # GNU sed's `e` command, run arbitrary shell. Real interface names
    # (eth0, wlan0, eth0.100, veth1234@if5, ...) all fit this charset.
    if ! [[ "$iface" =~ ^[A-Za-z0-9@._:-]+$ ]]; then
        echo "[-] '$iface' doesn't look like a valid interface name, refusing."
        return 1
    fi
    [ ! -f "$cfg" ] && { echo "[-] Suricata is not installed."; return 1; }
    $SUDO sed -i "s/^  - interface:.*$/  - interface: $iface/" "$cfg"
    $SUDO systemctl restart suricata >/dev/null 2>&1
    echo "[+] Suricata now watching interface $iface."
}

configure_tor() {
    if ! command -v tor >/dev/null 2>&1; then
        echo "[-] Tor is not installed."
        return 1
    fi
    $SUDO systemctl enable tor >/dev/null 2>&1
    $SUDO systemctl start tor >/dev/null 2>&1
    local rc="/etc/tor/torrc"
    grep -q "^SocksPort 9050" "$rc" 2>/dev/null || echo "SocksPort 9050" | $SUDO tee -a "$rc" >/dev/null
    $SUDO systemctl restart tor >/dev/null 2>&1
    echo "[+] Tor running, SOCKS proxy at 127.0.0.1:9050."
}

configure_usbguard() {
    if ! command -v usbguard >/dev/null 2>&1; then
        echo "[-] USBGuard is not installed."
        return 1
    fi
    echo "[*] Regenerating allow-list from currently-connected USB devices..."
    $SUDO mkdir -p /etc/usbguard
    $SUDO sh -c 'usbguard generate-policy > /etc/usbguard/rules.conf' || { echo "[-] Failed to generate policy."; return 1; }
    $SUDO systemctl restart usbguard >/dev/null 2>&1
    echo "[+] USBGuard policy regenerated. Devices connected right now are allowed; anything new is blocked."
    echo "[!] Keep your keyboard/mouse plugged in while running this, or they may be blocked on next boot."
}

wireguard_genkey() {
    if ! command -v wg >/dev/null 2>&1; then
        echo "[-] WireGuard tools are not installed."
        return 1
    fi
    $SUDO mkdir -p /etc/wireguard
    umask 077
    local priv pub
    priv=$(wg genkey)
    pub=$(echo "$priv" | wg pubkey)
    echo "[+] WireGuard keypair generated."
    echo "    Private key: $priv"
    echo "    Public key:  $pub"
    echo "[*] Store the private key securely — it is only printed here, not saved to disk."
}

list_interfaces() {
    ip -o link show | awk -F': ' '{print $2}' | grep -v '^lo$'
}

# ---------------------------------------------------------------------------
# Autostart — run the dashboard server on every boot via systemd, so it
# survives a reboot / shutdown without the user having to relaunch it.
# ---------------------------------------------------------------------------
OPSEC_SERVICE_NAME="opsec-dashboard"
OPSEC_SERVICE_FILE="/etc/systemd/system/${OPSEC_SERVICE_NAME}.service"

enable_autostart() {
    local repo_dir script_path py_bin
    repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    script_path="$repo_dir/server/opsec_server.py"
    py_bin="$(command -v python3)"
    if [ -z "$py_bin" ]; then
        echo "[-] python3 not found, cannot install the autostart service."
        return 1
    fi
    echo "[*] Writing systemd unit for the OpSec Dashboard..."
    $SUDO bash -c "cat > '$OPSEC_SERVICE_FILE'" <<EOF
[Unit]
Description=OpSec Dashboard
After=network.target

[Service]
Type=simple
ExecStart=$py_bin $script_path
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now "$OPSEC_SERVICE_NAME" >/dev/null 2>&1
    if systemctl is-enabled --quiet "$OPSEC_SERVICE_NAME" 2>/dev/null; then
        echo "[+] Autostart enabled. OpSec Dashboard will launch automatically on every boot."
    else
        echo "[-] Could not enable the autostart service, check 'systemctl status $OPSEC_SERVICE_NAME'."
        return 1
    fi
}

disable_autostart() {
    $SUDO systemctl disable --now "$OPSEC_SERVICE_NAME" >/dev/null 2>&1
    $SUDO rm -f "$OPSEC_SERVICE_FILE"
    $SUDO systemctl daemon-reload >/dev/null 2>&1
    echo "[+] Autostart disabled. OpSec Dashboard will not launch on the next boot."
}

autostart_status() {
    if systemctl is-enabled --quiet "$OPSEC_SERVICE_NAME" 2>/dev/null; then
        echo "enabled"
    else
        echo "disabled"
    fi
}

# ---------------------------------------------------------------------------
# Uninstall — generic per-tool removal (mirrors the install package names)
# ---------------------------------------------------------------------------
uninstall_tool() {
    local tool="$1"
    case "$tool" in
        tor)         pkg_remove "tor" "tor" "tor" ;;
        wireguard)   pkg_remove "wireguard" "wireguard-tools" "wireguard-tools" ;;
        openvpn)     pkg_remove "openvpn" "openvpn" "openvpn" ;;
        strongswan)  pkg_remove "strongswan" "strongswan" "strongswan" ;;
        ufw)         pkg_remove "ufw" "-" "ufw" ;;
        opensnitch)  pkg_remove "opensnitch" "opensnitch" "opensnitch" ;;
        suricata)    pkg_remove "suricata" "suricata" "suricata" ;;
        fail2ban)    pkg_remove "fail2ban" "fail2ban" "fail2ban" ;;
        rkhunter)    pkg_remove "rkhunter" "rkhunter" "rkhunter" ;;
        chkrootkit)  pkg_remove "chkrootkit" "chkrootkit" "-" ;;
        clamav)      pkg_remove "clamav" "clamav" "clamav" ;;
        firejail)    pkg_remove "firejail" "firejail" "firejail" ;;
        dnscrypt)    pkg_remove "dnscrypt-proxy" "dnscrypt-proxy" "dnscrypt-proxy" ;;
        macchanger)  pkg_remove "macchanger" "macchanger" "macchanger" ;;
        exiftool)    pkg_remove "libimage-exiftool-perl" "perl-Image-ExifTool" "perl-image-exiftool" ;;
        bleachbit)   pkg_remove "bleachbit" "bleachbit" "bleachbit" ;;
        keepassxc)   pkg_remove "keepassxc" "keepassxc" "keepassxc" ;;
        signal)      pkg_remove "signal-desktop" "-" "-" ;;
        lynis)       pkg_remove "lynis" "lynis" "lynis" ;;
        auditd)      pkg_remove "auditd" "audit" "audit" ;;
        usbguard)    pkg_remove "usbguard" "usbguard" "usbguard" ;;
        mullvad)     pkg_remove "mullvad-vpn" "mullvad-vpn" "mullvad-vpn-bin" ;;
        protonvpn)   pkg_remove "proton-vpn-gnome-desktop" "proton-vpn-gnome-desktop" "-" ;;
        onionshare)  pkg_remove "onionshare" "onionshare" "onionshare" ;;
        veracrypt)
            if command -v flatpak >/dev/null 2>&1 && flatpak list 2>/dev/null | grep -qi veracrypt; then
                $SUDO flatpak uninstall -y org.veracrypt.VeraCrypt
            else
                pkg_remove "-" "-" "veracrypt"
            fi
            ;;
        cryptomator)
            if command -v flatpak >/dev/null 2>&1 && flatpak list 2>/dev/null | grep -qi cryptomator; then
                $SUDO flatpak uninstall -y org.cryptomator.Cryptomator
            else
                pkg_remove "cryptomator" "-" "-"
            fi
            ;;
        secure_delete) pkg_remove "secure-delete" "-" "-" ;;
        *)
            echo "[!] No uninstall mapping for '$tool' — remove it manually if needed."
            return 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Panic mode — emergency network lockdown
# ---------------------------------------------------------------------------

PANIC_BACKUP="/etc/opsec-panic-ufw-backup.rules"
PANIC_FLAG="/run/opsec-panic-active"

panic_on() {
    if ! command -v ufw >/dev/null 2>&1; then
        echo "[-] UFW is required for panic mode — install it first."
        return 1
    fi
    echo "[!] ENGAGING PANIC MODE — blocking all inbound and outbound traffic except loopback."
    $SUDO ufw status verbose | $SUDO tee "$PANIC_BACKUP" >/dev/null
    $SUDO ufw default deny incoming >/dev/null 2>&1
    $SUDO ufw default deny outgoing >/dev/null 2>&1
    $SUDO ufw allow out on lo >/dev/null 2>&1
    $SUDO ufw allow in on lo >/dev/null 2>&1
    $SUDO ufw --force reload >/dev/null 2>&1
    $SUDO touch "$PANIC_FLAG"
    echo "[+] Panic mode engaged. All network traffic is blocked except loopback."
}

panic_off() {
    echo "[*] Disengaging panic mode — restoring normal outbound access."
    $SUDO ufw default deny incoming >/dev/null 2>&1
    $SUDO ufw default allow outgoing >/dev/null 2>&1
    $SUDO ufw --force reload >/dev/null 2>&1
    $SUDO rm -f "$PANIC_FLAG"
    echo "[+] Panic mode lifted. Previous rule snapshot kept at $PANIC_BACKUP."
}

# ---------------------------------------------------------------------------
# Security scans (long-running, streamed)
# ---------------------------------------------------------------------------

scan_chkrootkit() {
    command -v chkrootkit >/dev/null 2>&1 || { echo "[-] chkrootkit not installed."; return 1; }
    $SUDO chkrootkit
}

scan_rkhunter() {
    command -v rkhunter >/dev/null 2>&1 || { echo "[-] rkhunter not installed."; return 1; }
    $SUDO rkhunter --check --sk
}

scan_clamav() {
    command -v clamscan >/dev/null 2>&1 || { echo "[-] ClamAV not installed."; return 1; }
    $SUDO freshclam
    $SUDO clamscan -r "$HOME" -i
}

scan_lynis() {
    command -v lynis >/dev/null 2>&1 || { echo "[-] Lynis not installed."; return 1; }
    $SUDO lynis audit system
}

# ---------------------------------------------------------------------------
# Dispatcher — allows: opsec_core.sh <function> [args...]
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    fn="${1:-}"
    shift || true
    if [ -z "$fn" ]; then
        echo "Usage: $0 <function> [args...]"
        exit 1
    fi
    if declare -f "$fn" >/dev/null; then
        "$fn" "$@"
    else
        echo "[-] Unknown function: $fn"
        exit 1
    fi
fi
