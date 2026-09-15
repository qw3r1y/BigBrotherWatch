# OPSEC Dashboard 🛡️

A local, browser-based control panel for hardening and monitoring a Linux
box: install privacy/security tools, run one-click hardening playbooks,
watch live traffic and logs, run scans, and hit a kill switch if something
looks wrong — all from `http://127.0.0.1:8765`, never exposed beyond your
own machine.

This is a rewrite of the original OPSEC bash-menu tool. The old per-distro
CLI scripts (`Ubuntu Opsec/`, `Other Opsec/`) still work and are kept under
[`legacy/`](OpseC-main/legacy/) for reference, but the dashboard is now the
recommended way to run this.

![Overview](OpseC-main/docs/screenshots/overview.png)

## What it does

- **30 tools across 6 categories** — VPN/anonymity (Tor, WireGuard, OpenVPN,
  strongSwan, Mullvad, ProtonVPN), firewall & monitoring (UFW, OpenSnitch,
  Suricata, Fail2Ban, OSSEC HIDS), malware/rootkit defense (rkhunter,
  chkrootkit, ClamAV), privacy hygiene (DNSCrypt, MAC randomization,
  ExifTool, BleachBit, VeraCrypt, Cryptomator, secure-delete), hardening
  (Firejail, unattended upgrades, Lynis, auditd, USBGuard), and secure apps
  (Tor Browser, KeePassXC, Signal, OnionShare) — installed with live
  streamed output, distro-detected (`apt`/`dnf`/`pacman`/`zypper`).

- **17 Scenarios** — one-click playbooks ("Anonymity Shield", "Server
  Lockdown", "Detection Stack", "Public Wi-Fi Defense", "Incident Response
  Kit", ...) that install everything they need (skipping what you already
  have) and apply the right hardening actions in one run. Multi-select and
  queue several at once.

- **One-click Configure actions** — close remote-access ports via UFW,
  apply a Fail2Ban baseline jail, enable DNSCrypt, point Suricata at a NIC,
  configure Tor's SOCKS proxy, generate a WireGuard keypair, repair a
  half-configured package manager — each shows whether it's already active,
  not just installed.

- **A real Monitor tab** — live CPU/RAM/disk gauges, a network-throughput
  graph read from `/proc/net/dev`, an "Active Protection" panel that shows
  what's actually running right now (not just installed), and a merged
  live tail of Suricata/OSSEC/Fail2Ban/UFW logs.

- **Alerts** — everything that needs attention, most urgent first, with a
  severity breakdown and one click to jump to the tab that fixes it.

- **A Panic button** — instantly denies all inbound/outbound traffic except
  loopback (hold-to-engage, so it can't fire by accident), with a
  persistent banner reminding you it's on until you disengage it.

- **A desktop widget** — pop out a small, chrome-less window from the
  topbar and drag it anywhere on your screen: live protection score, active
  tools, firewall/ban status, and network throughput, without a full
  browser tab open. See [below](#desktop-widget).

- **Dark and light themes**, a global "run with/without sudo" toggle, and
  full Stop/Cancel support on every long-running install, scenario, or scan.

- **Autostart** — one click installs a systemd unit so the dashboard (and
  everything that depends on it, like the widget) survives a reboot.

## Getting started

Requirements: a Linux host (Debian/Ubuntu, Fedora, or Arch-based), `bash`,
and `python3` (auto-installed by the launcher if missing).

```bash
git clone https://github.com/qw3r1y/OpseC
cd OpseC/OpseC-main
chmod +x opsec.sh
./opsec.sh
