"""
Tool + action registry for the OpSec dashboard.

Pure metadata + status-check logic — no installation logic lives here.
Actual install/configure/scan work happens in core/opsec_core.sh, invoked
by server.py as subprocesses so behaviour stays identical whether you drive
it from the web UI or the command line.
"""
import os
import re
import shutil
import subprocess

# Tool categories, in dashboard display order.
CATEGORIES = [
    ("network", "Network & VPN"),
    ("monitoring", "Firewall & Monitoring"),
    ("malware", "Malware & Rootkit Defense"),
    ("privacy", "Privacy & Hygiene"),
    ("apps", "Secure Apps"),
    ("hardening", "System Hardening"),
]

# id -> metadata. `check` describes how to determine live status.
TOOLS = {
    "tor": {
        "label": "Tor", "category": "network",
        "description": "Anonymizing SOCKS proxy (127.0.0.1:9050).",
        "install_fn": "install_tor", "check": {"type": "service_or_bin", "service": "tor", "bin": "tor"},
    },
    "wireguard": {
        "label": "WireGuard", "category": "network",
        "description": "Modern, fast VPN tunnel.",
        "install_fn": "install_wireguard", "check": {"type": "bin", "bin": "wg"},
    },
    "openvpn": {
        "label": "OpenVPN", "category": "network",
        "description": "Classic VPN client/server.",
        "install_fn": "install_openvpn", "check": {"type": "bin", "bin": "openvpn"},
    },
    "strongswan": {
        "label": "strongSwan", "category": "network",
        "description": "IPsec/IKEv2 VPN suite.",
        "install_fn": "install_strongswan", "check": {"type": "bin", "bin": "ipsec"},
    },
    "ufw": {
        "label": "UFW", "category": "monitoring",
        "description": "Uncomplicated firewall for inbound/outbound rules.",
        "install_fn": "install_ufw", "check": {"type": "bin", "bin": "ufw"},
    },
    "opensnitch": {
        "label": "OpenSnitch", "category": "monitoring",
        "description": "Outbound connection monitor & application firewall.",
        "install_fn": "install_opensnitch", "check": {"type": "service_or_bin", "service": "opensnitchd", "bin": "opensnitch-ui"},
    },
    "suricata": {
        "label": "Suricata", "category": "monitoring",
        "description": "Network intrusion detection / prevention.",
        "install_fn": "install_suricata", "check": {"type": "service_or_bin", "service": "suricata", "bin": "suricata"},
    },
    "fail2ban": {
        "label": "Fail2Ban", "category": "monitoring",
        "description": "Bans IPs after repeated failed logins.",
        "install_fn": "install_fail2ban", "check": {"type": "service_or_bin", "service": "fail2ban", "bin": "fail2ban-client"},
    },
    "ossec": {
        "label": "OSSEC HIDS", "category": "monitoring",
        "description": "Host intrusion detection & log analysis.",
        "install_fn": "install_ossec", "check": {"type": "path", "path": "/var/ossec"},
    },
    "rkhunter": {
        "label": "rkhunter", "category": "malware",
        "description": "Rootkit hunter & system auditor.",
        "install_fn": "install_rkhunter", "check": {"type": "bin", "bin": "rkhunter"},
    },
    "chkrootkit": {
        "label": "chkrootkit", "category": "malware",
        "description": "Rootkit detection scanner.",
        "install_fn": "install_chkrootkit", "check": {"type": "bin", "bin": "chkrootkit"},
    },
    "clamav": {
        "label": "ClamAV", "category": "malware",
        "description": "Antivirus / malware scanner.",
        "install_fn": "install_clamav", "check": {"type": "bin", "bin": "clamscan"},
    },
    "firejail": {
        "label": "Firejail", "category": "hardening",
        "description": "Sandboxes applications to limit blast radius.",
        "install_fn": "install_firejail", "check": {"type": "bin", "bin": "firejail"},
    },
    "auto_updates": {
        "label": "Auto Security Updates", "category": "hardening",
        "description": "Unattended install of security patches.",
        "install_fn": "install_auto_updates", "check": {"type": "service", "service": "unattended-upgrades"},
    },
    "lynis": {
        "label": "Lynis", "category": "hardening",
        "description": "System auditing & hardening benchmark, run it from Scans.",
        "install_fn": "install_lynis", "check": {"type": "bin", "bin": "lynis"},
    },
    "auditd": {
        "label": "auditd", "category": "hardening",
        "description": "Linux kernel audit daemon that records security-relevant events.",
        "install_fn": "install_auditd", "check": {"type": "service_or_bin", "service": "auditd", "bin": "auditctl"},
    },
    "usbguard": {
        "label": "USBGuard", "category": "hardening",
        "description": "Allow-lists USB devices; blocks unauthorized ones by default.",
        "install_fn": "install_usbguard", "check": {"type": "service_or_bin", "service": "usbguard", "bin": "usbguard"},
    },
    "mullvad": {
        "label": "Mullvad VPN", "category": "network",
        "description": "Privacy-first WireGuard/OpenVPN VPN, no-logs, anonymous accounts.",
        "install_fn": "install_mullvad", "check": {"type": "any_bin", "bins": ["mullvad", "mullvad-vpn"]},
    },
    "protonvpn": {
        "label": "ProtonVPN", "category": "network",
        "description": "Secure VPN from the Proton team, with a Linux app & CLI.",
        "install_fn": "install_protonvpn", "check": {"type": "any_bin", "bins": ["protonvpn-app", "protonvpn"]},
    },
    "onionshare": {
        "label": "OnionShare", "category": "apps",
        "description": "Share files & host sites anonymously over the Tor network.",
        "install_fn": "install_onionshare", "check": {"type": "any_bin", "bins": ["onionshare", "onionshare-cli"]},
    },
    "veracrypt": {
        "label": "VeraCrypt", "category": "privacy",
        "description": "On-the-fly encrypted volumes & full-disk encryption.",
        "install_fn": "install_veracrypt", "check": {"type": "any_bin", "bins": ["veracrypt"]},
    },
    "cryptomator": {
        "label": "Cryptomator", "category": "privacy",
        "description": "Client-side, transparent encryption for cloud-synced folders.",
        "install_fn": "install_cryptomator", "check": {"type": "any_bin", "bins": ["cryptomator"]},
    },
    "secure_delete": {
        "label": "secure-delete", "category": "privacy",
        "description": "Securely wipe files & free space (srm, sfill, sswap).",
        "install_fn": "install_secure_delete", "check": {"type": "bin", "bin": "srm"},
    },
    "dnscrypt": {
        "label": "DNSCrypt", "category": "privacy",
        "description": "Encrypts DNS traffic.",
        "install_fn": "install_dnscrypt", "check": {"type": "service_or_bin", "service": "dnscrypt-proxy", "bin": "dnscrypt-proxy"},
    },
    "macchanger": {
        "label": "MAC Changer", "category": "privacy",
        "description": "Randomizes network interface MAC addresses.",
        "install_fn": "install_macchanger", "check": {"type": "bin", "bin": "macchanger"},
    },
    "exiftool": {
        "label": "ExifTool", "category": "privacy",
        "description": "Strips metadata from files/images.",
        "install_fn": "install_exiftool", "check": {"type": "bin", "bin": "exiftool"},
    },
    "bleachbit": {
        "label": "BleachBit", "category": "privacy",
        "description": "Disk & privacy cleaner.",
        "install_fn": "install_bleachbit", "check": {"type": "bin", "bin": "bleachbit"},
    },
    "tor_browser": {
        "label": "Tor Browser", "category": "apps",
        "description": "Anonymous browsing via the Tor network.",
        "install_fn": "install_tor_browser", "check": {"type": "bin", "bin": "torbrowser-launcher"},
    },
    "keepassxc": {
        "label": "KeePassXC", "category": "apps",
        "description": "Offline password manager.",
        "install_fn": "install_keepassxc", "check": {"type": "bin", "bin": "keepassxc"},
    },
    "signal": {
        "label": "Signal", "category": "apps",
        "description": "End-to-end encrypted messaging.",
        "install_fn": "install_signal", "check": {"type": "bin", "bin": "signal-desktop"},
    },
}

# Configure-tab actions. `params` are simple text/select inputs the frontend
# renders. `requires` names the tool_id this action needs installed first
# (frontend shows a "install X first" hint and disables Run until it's there).
# `group` clusters related actions in the Configure UI. `recommended` + `why`
# mark the sensible starting points for someone who doesn't know where to
# begin (shown as a "Recommended" tag with a one-line reason on the card).
ACTIONS = {
    "configure_ports": {
        "label": "Close Remote-Access Ports (UFW)",
        "description": "Deny SSH/FTP/RDP + any custom ports, default deny inbound.",
        "params": [{"name": "ports", "type": "text", "default": "22 21 3389", "placeholder": "space-separated ports"}],
        "requires": "ufw", "group": "Firewall",
        "recommended": True,
        "why": "The single highest-impact change on this page: it closes the ports attackers scan for first.",
    },
    "configure_fail2ban": {
        "label": "Apply Fail2Ban Baseline Jail",
        "description": "3 tries / 15 min ban on SSH.",
        "params": [],
        "requires": "fail2ban", "group": "Firewall",
        "recommended": True,
        "why": "Pairs naturally with closing ports above: it bans anyone who keeps trying anyway.",
    },
    "configure_usbguard": {
        "label": "Generate USBGuard Policy",
        "description": "Allow-list every USB device connected right now; block new ones.",
        "params": [],
        "requires": "usbguard", "group": "Firewall",
    },
    "configure_suricata_iface": {
        "label": "Set Suricata Interface",
        "description": "Point Suricata's monitoring at a specific NIC.",
        "params": [{"name": "iface", "type": "select_iface", "default": ""}],
        "requires": "suricata", "group": "Monitoring",
    },
    "configure_tor": {
        "label": "Configure Tor SOCKS Proxy",
        "description": "Enables Tor and ensures SocksPort 9050.",
        "params": [],
        "requires": "tor", "group": "Anonymity & VPN",
    },
    "configure_dnscrypt": {
        "label": "Enable DNSCrypt (Cloudflare)",
        "description": "Points dnscrypt-proxy at Cloudflare and restarts it.",
        "params": [],
        "requires": "dnscrypt", "group": "Anonymity & VPN",
    },
    "wireguard_genkey": {
        "label": "Generate WireGuard Keypair",
        "description": "Prints a fresh private/public keypair (not stored).",
        "params": [],
        "requires": "wireguard", "group": "Anonymity & VPN",
    },
    "repair_packages": {
        "label": "Repair Package Manager",
        "description": "Finishes any half-configured package and fixes broken dependencies.",
        "params": [],
        "group": "Maintenance",
        "why": "apt/dpkg leaves a package \"half-configured\" if its setup script fails, and that one leftover "
               "can then make every future install fail too, even for something unrelated. Run this if an "
               "install reports an error but the tool still seems to work, or before retrying one that failed.",
    },
}

# Scans tab. `tool` is the tool_id whose binary the scan actually shells out
# to (frontend shows install status + disables Run until it's present).
SCANS = {
    "scan_rkhunter": {"label": "rkhunter", "tool": "rkhunter",
                       "description": "Rootkit hunter: audits the system for known rootkit signatures and suspicious file changes."},
    "scan_chkrootkit": {"label": "chkrootkit", "tool": "chkrootkit",
                         "description": "A second, independent rootkit detector, good to run alongside rkhunter for cross-checking."},
    "scan_clamav": {"label": "ClamAV", "tool": "clamav",
                     "description": "Full antivirus scan of your home directory for known malware signatures."},
    "scan_lynis": {"label": "Lynis Audit", "tool": "lynis",
                    "description": "Whole-system security audit and hardening benchmark, with a scored report at the end."},
}

LOG_SOURCES = {
    "suricata": "/var/log/suricata/fast.log",
    "ossec": "/var/ossec/logs/alerts/alerts.log",
    "fail2ban": "/var/log/fail2ban.log",
    "ufw": "/var/log/ufw.log",
}

# One-click playbooks. Each runs its `tools` (installing only the missing
# ones) then its `actions` in order, streaming everything to a live console.
# `then: "monitor"` / `"scans"` jumps to that tab when the playbook finishes.
#
# `detail`  - one sentence on who this is for / what problem it solves (shown
#             under the tagline on the card).
# `time`    - rough wall-clock estimate for a clean install.
# `level`   - Beginner / Intermediate / Advanced, shown as a small tag.
# `accent`  - cosmetic only; consolidated in CSS to neutral/green/amber/red.
SCENARIOS = {
    "anonymity": {
        "label": "Anonymity Shield",
        "tagline": "Route traffic through Tor, encrypt DNS, and randomize your MAC address.",
        "detail": "For anyone who wants their everyday browsing untraceable back to them, without changing how they use the machine day to day.",
        "time": "~6 min", "level": "Beginner",
        "icon": "mask", "accent": "violet",
        "tools": ["tor", "tor_browser", "dnscrypt", "macchanger"],
        "actions": [{"name": "configure_tor"}, {"name": "configure_dnscrypt"}],
        "then": None,
    },
    "hardening": {
        "label": "Server Lockdown",
        "tagline": "Firewall on, remote-access ports closed, brute-force bans, audit logging & auto-patching.",
        "detail": "The baseline every internet-facing box should have before it goes live: a locked-down perimeter and a paper trail if something goes wrong.",
        "time": "~8 min", "level": "Intermediate",
        "icon": "lock", "accent": "cyan",
        "tools": ["ufw", "fail2ban", "auditd", "rkhunter", "auto_updates"],
        "actions": [
            {"name": "configure_ports", "params": {"ports": "22 21 3389"}},
            {"name": "configure_fail2ban"},
        ],
        "then": None,
    },
    "detection": {
        "label": "Detection Stack",
        "tagline": "Deploy the IDS/HIDS stack and drop straight into live monitoring.",
        "detail": "For when you want eyes on the wire right now: network intrusion detection, host integrity checks, and a live feed the moment it's done.",
        "time": "~10 min", "level": "Intermediate",
        "icon": "radar", "accent": "green",
        "tools": ["suricata", "opensnitch", "fail2ban", "ossec"],
        "actions": [{"name": "configure_fail2ban"}],
        "then": "monitor",
    },
    "privacy": {
        "label": "Data Hygiene",
        "tagline": "Metadata stripping, disk cleaning, secure deletion, encrypted volumes & a password vault.",
        "detail": "A spring-cleaning pass for a machine that's accumulated cruft: leftover metadata, recoverable deleted files, and passwords scattered across browsers.",
        "time": "~5 min", "level": "Beginner",
        "icon": "broom", "accent": "blue",
        "tools": ["exiftool", "bleachbit", "secure_delete", "veracrypt", "keepassxc"],
        "actions": [],
        "then": None,
    },
    "journalist": {
        "label": "Source Protection",
        "tagline": "For journalists & whistleblowers: anonymous browsing, anonymous file drops, encrypted chat & vaults.",
        "detail": "Built around protecting a source, not just a device: anonymous submission drop, encrypted messaging, and vaults for anything that can't leak.",
        "time": "~9 min", "level": "Advanced",
        "icon": "mask", "accent": "violet",
        "tools": ["tor", "tor_browser", "onionshare", "signal", "keepassxc", "veracrypt", "secure_delete"],
        "actions": [{"name": "configure_tor"}],
        "then": None,
    },
    "workstation": {
        "label": "Laptop Hardening",
        "tagline": "Everyday daily-driver defense: firewall, app sandboxing, encrypted DNS, MAC rotation & a vault.",
        "detail": "The sensible default for a personal laptop that leaves the house: contained apps, a firewall that's actually on, and DNS that isn't logged by your ISP.",
        "time": "~7 min", "level": "Beginner",
        "icon": "lock", "accent": "blue",
        "tools": ["ufw", "firejail", "macchanger", "dnscrypt", "bleachbit", "keepassxc", "auto_updates"],
        "actions": [
            {"name": "configure_dnscrypt"},
            {"name": "configure_ports", "params": {"ports": "22 21 3389"}},
        ],
        "then": None,
    },
    "homeserver": {
        "label": "Home Server Guard",
        "tagline": "Harden a self-hosted box: firewall, brute-force bans, IDS, audit logging, malware & rootkit defense.",
        "detail": "For a NAS, media server, or self-hosted app sitting on your network around the clock: it needs to defend itself, not just trust the LAN.",
        "time": "~11 min", "level": "Intermediate",
        "icon": "lock", "accent": "green",
        "tools": ["ufw", "fail2ban", "suricata", "auditd", "rkhunter", "clamav", "auto_updates"],
        "actions": [
            {"name": "configure_ports", "params": {"ports": "22 21 3389"}},
            {"name": "configure_fail2ban"},
        ],
        "then": "monitor",
    },
    "malware": {
        "label": "Malware Sweep",
        "tagline": "Install the rootkit/AV/audit toolkit and jump straight to running scans.",
        "detail": "Run this the moment something feels off: a slow machine, a strange process, an app that showed up on its own. Installs the toolkit and starts scanning immediately.",
        "time": "~6 min", "level": "Beginner",
        "icon": "radar", "accent": "amber",
        "tools": ["clamav", "rkhunter", "chkrootkit", "lynis", "firejail", "opensnitch"],
        "actions": [],
        "then": "scans",
    },
    "comms": {
        "label": "Encrypted Comms",
        "tagline": "Private messaging & credentials: Signal, a password vault, Tor routing and encrypted DNS.",
        "detail": "For keeping conversations and credentials off the record: end-to-end messaging, a local vault instead of a browser's saved passwords, and Tor for anything sensitive.",
        "time": "~6 min", "level": "Beginner",
        "icon": "mask", "accent": "cyan",
        "tools": ["signal", "keepassxc", "tor", "dnscrypt", "wireguard"],
        "actions": [{"name": "configure_tor"}, {"name": "configure_dnscrypt"}],
        "then": None,
    },
    "vpn_multi": {
        "label": "VPN Toolkit",
        "tagline": "Set up every major VPN protocol side by side, so you always have a working tunnel.",
        "detail": "For people who need options: a corporate WireGuard config, a client's OpenVPN profile, and a no-logs commercial VPN, all installed and ready to switch between.",
        "time": "~9 min", "level": "Intermediate",
        "icon": "lock", "accent": "cyan",
        "tools": ["wireguard", "openvpn", "strongswan", "mullvad", "protonvpn"],
        "actions": [{"name": "wireguard_genkey"}],
        "then": None,
    },
    "public_wifi": {
        "label": "Public Wi-Fi Defense",
        "tagline": "Lock a laptop down before it touches an airport, cafe, or hotel network.",
        "detail": "Everything you want active before joining a network you don't control: a VPN tunnel up first, a firewall that denies by default, and a MAC address that isn't tracking you between visits.",
        "time": "~7 min", "level": "Beginner",
        "icon": "mask", "accent": "blue",
        "tools": ["mullvad", "wireguard", "ufw", "macchanger", "dnscrypt"],
        "actions": [{"name": "configure_dnscrypt"}, {"name": "configure_ports", "params": {"ports": "22 21 3389"}}],
        "then": None,
    },
    "incident_response": {
        "label": "Incident Response Kit",
        "tagline": "Deep forensics after a suspected compromise: rootkits, malware, audit trails, and a full system audit.",
        "detail": "For after the fact, not before: assumes something may already be wrong and installs everything needed to find out what, backed by an audit trail going forward.",
        "time": "~10 min", "level": "Advanced",
        "icon": "radar", "accent": "danger",
        "tools": ["clamav", "rkhunter", "chkrootkit", "lynis", "auditd"],
        "actions": [],
        "then": "scans",
    },
    "file_vault": {
        "label": "Vault & Backup",
        "tagline": "Encrypted volumes, cloud-safe folders, a password manager, and secure deletion.",
        "detail": "For anyone storing something that would matter if it leaked: full encrypted volumes for local storage, transparent encryption for anything synced to the cloud.",
        "time": "~5 min", "level": "Beginner",
        "icon": "broom", "accent": "blue",
        "tools": ["veracrypt", "cryptomator", "keepassxc", "secure_delete"],
        "actions": [],
        "then": None,
    },
    "app_sandbox": {
        "label": "App Isolation",
        "tagline": "Contain untrusted apps and lock down what any USB device can do.",
        "detail": "For running software you don't fully trust, or plugging in hardware you don't fully trust: everything stays sandboxed and every new USB device is blocked by default.",
        "time": "~5 min", "level": "Intermediate",
        "icon": "lock", "accent": "amber",
        "tools": ["firejail", "opensnitch", "usbguard"],
        "actions": [{"name": "configure_usbguard"}],
        "then": None,
    },
    "researcher": {
        "label": "OSINT Research Rig",
        "tagline": "Anonymous browsing, anonymous drops, and a rotating MAC for open-source research.",
        "detail": "For research that shouldn't be traceable back to the researcher: every request routed through Tor, a way to publish anonymously, and a MAC address that changes.",
        "time": "~7 min", "level": "Advanced",
        "icon": "mask", "accent": "violet",
        "tools": ["tor", "tor_browser", "onionshare", "macchanger"],
        "actions": [{"name": "configure_tor"}],
        "then": None,
    },
    "essentials": {
        "label": "Essentials Only",
        "tagline": "The lightweight baseline: firewall, auto-updates, a cleaner, and a password vault.",
        "detail": "For a first pass on any machine, or someone who wants real protection without fifteen new background services. Four tools, nothing exotic.",
        "time": "~4 min", "level": "Beginner",
        "icon": "shield", "accent": "green",
        "tools": ["ufw", "auto_updates", "bleachbit", "keepassxc"],
        "actions": [{"name": "configure_ports", "params": {"ports": "22 21 3389"}}],
        "then": None,
    },
    "paranoid": {
        "label": "Maximum Paranoia",
        "tagline": "The works: anonymity, firewall lockdown, IDS, sandboxing, USB control and malware defense.",
        "detail": "Everything this dashboard knows how to do, applied at once. Overkill for most people, correct for some of them.",
        "time": "~18 min", "level": "Advanced",
        "icon": "shield", "accent": "danger",
        "tools": ["tor", "dnscrypt", "macchanger", "ufw", "fail2ban", "auditd",
                  "usbguard", "rkhunter", "clamav", "firejail", "auto_updates"],
        "actions": [
            {"name": "configure_tor"},
            {"name": "configure_dnscrypt"},
            {"name": "configure_ports", "params": {"ports": "22 21 3389"}},
            {"name": "configure_fail2ban"},
        ],
        "then": "monitor",
    },
}


def detect_pkg_manager():
    for mgr, bin_ in (("apt", "apt-get"), ("dnf", "dnf"), ("pacman", "pacman"), ("zypper", "zypper")):
        if shutil.which(bin_):
            return mgr
    return "unknown"


def _systemctl_active(service: str) -> bool:
    try:
        r = subprocess.run(["systemctl", "is-active", "--quiet", service], timeout=3)
        return r.returncode == 0
    except Exception:
        return False


def service_names_needing_check():
    """Every distinct systemd unit any tool's status check depends on."""
    names = {m["check"]["service"] for m in TOOLS.values() if m["check"]["type"] in ("service", "service_or_bin")}
    return sorted(names)


def batch_systemctl_active(services):
    """Check many systemd units in ONE subprocess call instead of one-per-unit.

    `/api/status` is polled every few seconds by every open tab, and used to
    spawn a separate `systemctl is-active` process per service-backed tool
    (8+ per poll). `systemctl is-active` accepts multiple unit names and
    prints one status line per unit, in the order given, so a single call
    covers all of them. Falls back to per-unit checks if the batch call
    itself fails for some reason (e.g. systemctl missing entirely).
    """
    if not services:
        return {}
    try:
        r = subprocess.run(["systemctl", "is-active", *services],
                            capture_output=True, text=True, timeout=5)
        lines = r.stdout.splitlines()
        return {svc: (i < len(lines) and lines[i].strip() == "active")
                for i, svc in enumerate(services)}
    except Exception:
        return {svc: _systemctl_active(svc) for svc in services}


def tool_status(tool_id: str, active_map=None) -> str:
    """Returns 'active' | 'installed' | 'missing'.

    `active_map` is an optional {service_name: bool} map from
    `batch_systemctl_active`, used to avoid spawning one `systemctl` process
    per tool when checking many tools at once (see `_api_status`). Falls
    back to a live per-service check when not given, so this still works
    standalone (e.g. from the CLI).
    """
    meta = TOOLS[tool_id]
    chk = meta["check"]
    if chk["type"] == "bin":
        return "installed" if shutil.which(chk["bin"]) else "missing"
    if chk["type"] == "any_bin":
        return "installed" if any(shutil.which(b) for b in chk["bins"]) else "missing"
    if chk["type"] == "path":
        return "installed" if os.path.isdir(chk["path"]) else "missing"
    if chk["type"] == "service":
        active = active_map[chk["service"]] if active_map is not None else _systemctl_active(chk["service"])
        return "active" if active else "missing"
    if chk["type"] == "service_or_bin":
        active = active_map[chk["service"]] if active_map is not None else _systemctl_active(chk["service"])
        if active:
            return "active"
        if shutil.which(chk["bin"]):
            return "installed"
        return "missing"
    return "missing"


def is_supported(tool_id: str, pkg_manager: str) -> bool:
    # Everything is "attemptable"; opsec_core.sh itself reports when a
    # package has no mapping for the detected manager.
    return True


def firewall_summary():
    """Real UFW state: active?, default policies, how many DENY rules."""
    if not shutil.which("ufw"):
        return None
    try:
        r = subprocess.run(["ufw", "status", "verbose"], capture_output=True, text=True, timeout=3)
        out = r.stdout
    except Exception:
        return None
    if "Status: active" not in out:
        return {"active": False, "policy_in": None, "policy_out": None, "blocked_rules": 0}
    m = re.search(r"Default:\s*([\w-]+)\s*\(incoming\),\s*([\w-]+)\s*\(outgoing\)", out)
    policy_in, policy_out = (m.group(1), m.group(2)) if m else (None, None)
    blocked = len(re.findall(r"\bDENY\b", out))
    return {"active": True, "policy_in": policy_in, "policy_out": policy_out, "blocked_rules": blocked}


def fail2ban_banned_count():
    """Real count of currently-banned IPs across all active jails, or None if unavailable."""
    if not shutil.which("fail2ban-client"):
        return None
    try:
        r = subprocess.run(["fail2ban-client", "status"], capture_output=True, text=True, timeout=3)
        m = re.search(r"Jail list:\s*(.*)", r.stdout)
        if not m:
            return 0
        total = 0
        for name in [j.strip() for j in m.group(1).split(",") if j.strip()]:
            r2 = subprocess.run(["fail2ban-client", "status", name], capture_output=True, text=True, timeout=3)
            m2 = re.search(r"Currently banned:\s*(\d+)", r2.stdout)
            if m2:
                total += int(m2.group(1))
        return total
    except Exception:
        return None


def suricata_alert_count(tail_bytes=300_000):
    """Approximate alert count from the tail of Suricata's fast.log, or None if not present."""
    path = LOG_SOURCES.get("suricata")
    if not path or not os.path.isfile(path):
        return None
    try:
        size = os.path.getsize(path)
        with open(path, "r", errors="replace") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
            data = f.read()
        return data.count("[**]")
    except Exception:
        return None


def read_cpu_times():
    """Returns (idle_ticks, total_ticks) from the aggregate 'cpu' line of /proc/stat."""
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()[1:]
        nums = [int(p) for p in parts]
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        return idle, sum(nums)
    except Exception:
        return 0, 0


def read_mem_percent():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.strip().split()[0])
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", total)
        return round((total - avail) / total * 100, 1) if total else None
    except Exception:
        return None


def read_disk_percent(path="/"):
    try:
        du = shutil.disk_usage(path)
        return round(du.used / du.total * 100, 1) if du.total else None
    except Exception:
        return None


def read_uptime():
    try:
        with open("/proc/uptime") as f:
            secs = float(f.readline().split()[0])
        d, rem = divmod(int(secs), 86400)
        h, rem = divmod(rem, 3600)
        m, _ = divmod(rem, 60)
        parts = [f"{d}d"] if d else []
        parts += [f"{h}h"] if h or d else []
        parts.append(f"{m}m")
        return " ".join(parts)
    except Exception:
        return "—"


def read_net_bytes():
    """Total rx/tx bytes across all non-loopback interfaces, from /proc/net/dev."""
    rx = tx = 0
    try:
        with open("/proc/net/dev") as f:
            lines = f.readlines()[2:]
        for line in lines:
            if ":" not in line:
                continue
            iface, rest = line.split(":", 1)
            if iface.strip() == "lo":
                continue
            fields = rest.split()
            rx += int(fields[0])
            tx += int(fields[8])
    except Exception:
        pass
    return rx, tx
