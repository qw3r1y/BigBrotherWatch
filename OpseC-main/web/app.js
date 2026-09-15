(() => {
  let STATE = null;
  let selected = new Set();
  let logStreams = [];
  let muted = new Set();
  let installing = false;
  let lastRun = {};   // { actionOrScanId: Date }, session-only "last run" memory

  // Scenario queue: multi-select + run-in-order, with per-card live status.
  let scenarioSelected = new Set();
  let scenarioQueue = [];        // ids waiting to run; queue[0] === scenarioRunning while running
  let scenarioRunning = null;    // id of the scenario currently executing, or null
  let scenarioStep = null;       // { i, total, label } for the currently running scenario's step
  let scanRunning = null;        // id of the scan currently executing, or null
  let cancelRequested = false;   // set by Stop; checked between steps so a killed
                                  // process doesn't just get replaced by the next one in line

  // Whether install/configure/scan/scenario runs ask core/opsec_core.sh to
  // prefix privileged commands with `sudo` (see the "Sudo" chip in the
  // topbar). The server already requires root to start at all, so this is
  // an escape hatch for minimal environments without sudo configured, not
  // the main privilege gate — default on, matching prior behavior exactly.
  let useSudo = true;
  try { useSudo = localStorage.getItem("opsec_use_sudo") !== "0"; } catch (e) {}
  function sudoParam() { return `sudo=${useSudo ? 1 : 0}`; }

  async function cancelRun() {
    cancelRequested = true;
    const res = await apiPost("/api/console/cancel", {});
    if (!res.ok) {
      // most likely just means the process finished a beat before the click landed
      console.warn("cancel:", res.error);
    }
  }

  function timeAgo(d) {
    const s = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return `${h}h ago`;
  }

  // Real icon glyphs (Tabler Icons, MIT licensed, paths embedded so the
  // dashboard works fully offline with no CDN dependency) instead of
  // hand-drawn shapes — a hand-rolled "mask" or "shield" reads as amateur
  // no matter how carefully it's drawn.
  function icon(paths, extra) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join("")}${extra || ""}</svg>`;
  }
  const ICON_SLIDERS = icon([
    "M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M4 6l8 0", "M16 6l4 0",
    "M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M4 12l2 0", "M10 12l10 0",
    "M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M4 18l11 0", "M19 18l1 0",
  ]); // adjustments-horizontal
  const ICON_CLOCK = icon(["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 7v5l3 3"]);
  const ICON_SUN = icon([
    "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0",
    "M3 12h1", "M12 3v1", "M20 12h1", "M12 20v1",
    "M5.6 5.6l.7 .7", "M18.4 5.6l-.7 .7", "M17.7 17.7l.7 .7", "M6.3 17.7l-.7 .7",
  ]);
  const ICON_MOON = icon(["M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"]);
  const ICON_SCAN = icon([
    "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M15.51 15.56a5 5 0 1 0 -3.51 1.44",
    "M18.832 17.86a9 9 0 1 0 -6.832 3.14",
    "M12 12v9",
  ]); // radar-2
  const SCENARIO_ICONS = {
    mask: icon([
      "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
      "M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12",
    ]),
    lock: icon([
      "M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6",
      "M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0",
      "M8 11v-4a4 4 0 1 1 8 0v4",
    ]),
    radar: ICON_SCAN,
    broom: icon([
      "M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6",
    ]), // sparkles
    shield: icon([
      "M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06",
      "M15 19l2 2l4 -4",
    ]), // shield-check
  };

  // ---------------- API helpers ----------------
  // The session cookie is HttpOnly and set automatically on first load —
  // every same-origin fetch/EventSource below carries it without any code.
  async function apiGet(path) {
    const r = await fetch(path);
    return r.json();
  }
  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  function streamTo(url, consoleId, onDone) {
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      if (ev.data.startsWith("__DONE__")) {
        es.close();
        if (onDone) onDone(ev.data.replace("__DONE__", ""));
        return;
      }
      appendConsole(consoleId, ev.data);
    };
    es.onerror = () => { es.close(); if (onDone) onDone("error"); };
    return es;
  }

  function appendConsole(id, text) {
    const el = document.getElementById(id);
    const cls = text.startsWith("[-]") ? "line-err" : text.startsWith("[+]") ? "line-ok" : text.startsWith("[!]") ? "line-warn" : "";
    const span = document.createElement("div");
    if (cls) span.className = cls;
    span.textContent = text;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  }

  // ---------------- Console input (answer a stuck interactive prompt) ----------------
  // Install/config actions run fully non-interactively (see core/opsec_core.sh),
  // so this should rarely be needed — but if some future package still asks
  // a question, this is how you answer it without the console being a
  // dead end: type a reply, it's written straight to the running process's
  // stdin, same as typing into a real terminal.
  function wireConsoleInputs() {
    document.querySelectorAll(".console-input-row").forEach((form) => {
      const consoleId = form.dataset.console;
      const input = form.querySelector(".console-input");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        // An EMPTY submission is a valid, common answer here: it's a bare
        // Enter keypress, exactly what "-- Press ENTER to continue --"
        // prompts want. Don't swallow it — only skip if nothing could
        // possibly be listening (nothing has ever run in this console yet).
        const text = input.value;
        const line = document.createElement("div");
        line.className = "line-sent";
        line.textContent = text ? "> " + text : "> (Enter)";
        document.getElementById(consoleId).appendChild(line);
        document.getElementById(consoleId).scrollTop = document.getElementById(consoleId).scrollHeight;
        input.value = "";
        const res = await apiPost("/api/console/input", { text });
        if (!res.ok) appendConsole(consoleId, `[!] ${res.error || "Nothing is currently running to receive that."}`);
      });
    });
  }

  // ---------------- Tabs ----------------
  document.getElementById("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    document.getElementById("view-" + btn.dataset.tab).classList.remove("hidden");
  });

  ["clearConsole1", "clearConsole2", "clearConsole3", "clearConsole4", "clearConsole5"].forEach((id, i) => {
    const targets = ["console-install", "console-configure", "console-monitor", "console-scans", "console-scenarios"];
    document.getElementById(id).addEventListener("click", () => {
      document.getElementById(targets[i]).innerHTML = "";
    });
  });

  // ---------------- Formatting ----------------
  function formatRate(bytesPerSec) {
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }

  function statusLabel(s) {
    return s === "active" ? "Active" : s === "installed" ? "Installed" : "Missing";
  }

  function meterClass(pct) {
    if (pct >= 90) return "danger";
    if (pct >= 70) return "warn";
    return "";
  }

  // ---------------- Category rows ----------------
  function renderCategoryList(containerId, opts) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    for (const [catId, catLabel] of STATE.categories) {
      const ids = Object.keys(STATE.tool_meta).filter((t) => STATE.tool_meta[t].category === catId);
      if (!ids.length) continue;
      const block = document.createElement("div");
      block.className = "category-block";
      const title = document.createElement("div");
      title.className = "category-title";
      title.textContent = catLabel;
      block.appendChild(title);
      const list = document.createElement("div");
      list.className = "row-list panel";
      for (const id of ids) list.appendChild(opts.renderRow(id));
      block.appendChild(list);
      container.appendChild(block);
    }
  }

  function installRow(id) {
    const meta = STATE.tool_meta[id];
    const status = STATE.tools[id];
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.row = id;
    const checked = selected.has(id) ? "checked" : "";
    const disableCheck = status !== "missing" ? "disabled" : "";
    row.innerHTML = `
      <input type="checkbox" ${checked} ${disableCheck} data-id="${id}" class="pick" />
      <span class="dot ${status}"></span>
      <div class="row-main">
        <span class="row-name">${meta.label}</span>
        <span class="row-desc">${meta.description}</span>
      </div>
      <span class="status-pill ${status}">${statusLabel(status)}</span>
      <div class="row-actions">
        ${status === "missing"
          ? `<button class="btn small install-one" data-id="${id}">Install</button>`
          : `<button class="btn small ghost uninstall-one" data-id="${id}">Uninstall</button>`}
      </div>
    `;
    return row;
  }

  // ---------------- SOC Overview visuals ----------------
  const CAT_SHORT = { network: "Network", monitoring: "Firewall", malware: "Malware",
                      privacy: "Privacy", apps: "Apps", hardening: "Hardening" };
  const C_ACTIVE = "#2fd980", C_INST = "#2f5eff", C_MISS = "#3a3d42", C_THREAT = "#ff3b4e";
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function catCoverage(catId) {
    const ids = Object.keys(STATE.tool_meta).filter((t) => STATE.tool_meta[t].category === catId);
    const on = ids.filter((t) => STATE.tools[t] !== "missing").length;
    return { ids, on, total: ids.length, pct: ids.length ? Math.round(on / ids.length * 100) : 0 };
  }

  function threatCount() {
    const b = STATE.threats.banned_ips || 0, s = STATE.threats.suricata_alerts || 0;
    // `active` = things that actually need attention right now (live IDS alerts).
    // Banned IPs are Fail2Ban already having done its job — an event, not a danger.
    return { banned: b, alerts: s, total: b + s, active: s };
  }

  function renderRadar() {
    const svg = document.getElementById("radar");
    if (!svg) return;
    const hx = 310, hy = 222, ring = 150;
    const cats = STATE.categories;
    let parts = [];

    // guide rings — var(--border) is already calibrated per-theme to the
    // right weight for a faint structural line, dark or light.
    [70, 135, 200].forEach((r) => {
      parts.push(`<circle cx="${hx}" cy="${hy}" r="${r}" fill="none" style="stroke:var(--border)"/>`);
    });
    // crosshair spokes
    parts.push(`<line x1="${hx-205}" y1="${hy}" x2="${hx+205}" y2="${hy}" style="stroke:var(--border)"/>`);
    parts.push(`<line x1="${hx}" y1="${hy-205}" x2="${hx}" y2="${hy+205}" style="stroke:var(--border)"/>`);

    // rotating sweep
    const sweep = `<defs><radialGradient id="swg" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="rgba(61,220,132,.22)"/><stop offset="100%" stop-color="rgba(61,220,132,0)"/></radialGradient></defs>
      <g><path d="M ${hx} ${hy} L ${hx+200} ${hy} A 200 200 0 0 1 ${hx+141} ${hy+141} Z" fill="url(#swg)">
        ${reduceMotion ? "" : `<animateTransform attributeName="transform" type="rotate" from="0 ${hx} ${hy}" to="360 ${hx} ${hy}" dur="7s" repeatCount="indefinite"/>`}
      </path></g>`;
    parts.push(sweep);

    // category clusters + satellites
    const n = cats.length;
    cats.forEach(([catId], i) => {
      const ang = (-90 + i * 360 / n) * Math.PI / 180;
      const cx = hx + ring * Math.cos(ang), cy = hy + ring * Math.sin(ang);
      const cov = catCoverage(catId);
      const anyActive = cov.ids.some((t) => STATE.tools[t] === "active");
      const clusterCol = anyActive ? C_ACTIVE : cov.on ? C_INST : C_MISS;
      const lineOpacity = cov.on ? .5 : .18;
      // host -> cluster line
      parts.push(`<line x1="${hx}" y1="${hy}" x2="${cx.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${clusterCol}" stroke-opacity="${lineOpacity}" stroke-width="1.2" stroke-dasharray="3 4"/>`);
      // satellites
      const sr = ring + 44;
      cov.ids.forEach((t, k) => {
        const sang = ang + (k - (cov.ids.length - 1) / 2) * 0.19;
        const sx = hx + sr * Math.cos(sang), sy = hy + sr * Math.sin(sang);
        const st = STATE.tools[t];
        const col = st === "active" ? C_ACTIVE : st === "installed" ? C_INST : C_MISS;
        if (st === "missing") {
          parts.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3" fill="none" stroke="${col}" stroke-width="1.3"/>`);
        } else {
          parts.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3.4" fill="${col}"/>`);
        }
      });
      // cluster node — fill matches the card behind it so the node reads
      // as a cutout, dark card or light
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8" style="fill:var(--panel)" stroke="${clusterCol}" stroke-width="2"/>`);
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="${clusterCol}"/>`);
      // label — when the cluster sits in the top half, both lines have to
      // clear the node (r=8) on the way UP, so the count goes above the
      // label instead of stacking back down toward it (that stacking is what
      // used to land the count right on top of the node, unreadable).
      const lx = cx, above = Math.sin(ang) < 0;
      const labelY = above ? cy - 28 : cy + 24;
      const countY = above ? cy - 16 : cy + 36;
      parts.push(`<text x="${lx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" style="fill:var(--text)">${CAT_SHORT[catId] || catId}</text>`);
      parts.push(`<text x="${lx.toFixed(1)}" y="${countY.toFixed(1)}" text-anchor="middle" font-size="9" style="fill:var(--text-faint)" font-family="ui-monospace,monospace">${cov.on}/${cov.total}</text>`);
    });

    // active threats (live IDS alerts, not fail2ban's already-handled bans): red blips at outer edge
    const th = threatCount();
    const blips = Math.min(3, th.active > 0 ? Math.max(1, Math.ceil(th.active / 3)) : 0);
    const blipAngles = [-120, -60, -150];
    for (let j = 0; j < blips; j++) {
      const a = blipAngles[j] * Math.PI / 180;
      const bx = hx + 205 * Math.cos(a), by = hy + 205 * Math.sin(a);
      parts.push(`<line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${(hx + 60 * Math.cos(a)).toFixed(1)}" y2="${(hy + 60 * Math.sin(a)).toFixed(1)}" stroke="${C_THREAT}" stroke-opacity=".45" stroke-width="1.2" stroke-dasharray="4 4"/>`);
      parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="5" fill="${C_THREAT}">${reduceMotion ? "" : `<animate attributeName="opacity" values="1;.3;1" dur="1.3s" repeatCount="indefinite"/>`}</circle>`);
    }

    // protected host (center)
    const hostCol = th.active > 0 ? C_THREAT : C_ACTIVE;
    parts.push(`<circle cx="${hx}" cy="${hy}" r="30" fill="none" stroke="${hostCol}" stroke-opacity=".25" stroke-width="1.5"/>`);
    parts.push(`<circle cx="${hx}" cy="${hy}" r="20" style="fill:var(--wash-2)" stroke="${hostCol}" stroke-width="2"/>`);
    parts.push(`<path d="M${hx} ${hy-9} l8 3 v5 c0 5-3.5 8-8 9.5 -4.5-1.5-8-4.5-8-9.5 v-5 z" fill="none" stroke="${hostCol}" stroke-width="1.6" stroke-linejoin="round"/>`);
    parts.push(`<path d="M${hx-4} ${hy+1} l3 3 5-5" fill="none" stroke="${hostCol}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`);

    svg.innerHTML = parts.join("");

    // status pill
    const st = document.getElementById("radarStatus");
    if (th.active > 0) { st.textContent = `${th.active} active alert${th.active === 1 ? "" : "s"}`; st.className = "radar-status danger"; }
    else if (STATE.system.panic_active) { st.textContent = "Panic lockdown"; st.className = "radar-status danger"; }
    else if (STATE.firewall && STATE.firewall.active) { st.textContent = "Perimeter secure"; st.className = "radar-status"; }
    else { st.textContent = "Firewall down"; st.className = "radar-status warn"; }
  }

  function polar(cx, cy, r, deg) {
    const a = deg * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function arcPath(cx, cy, r, a0, a1) {
    const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
    const large = (a1 - a0) > 180 ? 1 : 0;
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }

  function renderGauge() {
    const svg = document.getElementById("gauge");
    if (!svg) return;
    const cx = 150, cy = 165, r = 116, score = STATE.score;
    const band = score >= 70 ? "var(--good)" : score >= 40 ? "var(--warn)" : "var(--danger)";
    const bandLabel = score >= 70 ? "SECURE" : score >= 40 ? "ELEVATED" : "AT RISK";
    const valEnd = 180 + 180 * (score / 100);
    let p = [];
    p.push(`<path d="${arcPath(cx, cy, r, 180, 360)}" fill="none" style="stroke:var(--wash-2)" stroke-width="14" stroke-linecap="round"/>`);
    p.push(`<path d="${arcPath(cx, cy, r, 180, valEnd)}" fill="none" style="stroke:${band}" stroke-width="14" stroke-linecap="round"/>`);
    // ticks
    for (let t = 0; t <= 10; t++) {
      const [x0, y0] = polar(cx, cy, r - 12, 180 + t * 18);
      const [x1, y1] = polar(cx, cy, r - 4, 180 + t * 18);
      p.push(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" style="stroke:var(--wash-4)" stroke-width="1.5"/>`);
    }
    p.push(`<text x="${cx}" y="140" text-anchor="middle" font-size="46" font-weight="800" style="fill:${band}" font-family="var(--font)">${score}</text>`);
    p.push(`<text x="${cx}" y="160" text-anchor="middle" font-size="11" style="fill:var(--text-faint)" letter-spacing="1.5">PROTECTION</text>`);
    p.push(`<text x="${cx}" y="188" text-anchor="middle" font-size="12" font-weight="800" style="fill:${band}" letter-spacing="1">${bandLabel}</text>`);
    p.push(`<text x="30" y="182" font-size="9" style="fill:var(--text-faint)">0</text>`);
    p.push(`<text x="270" y="182" font-size="9" style="fill:var(--text-faint)" text-anchor="end">100</text>`);
    svg.innerHTML = p.join("");
  }

  function renderDefenseStrip() {
    const strip = document.getElementById("defenseStrip");
    if (!strip) return;
    strip.innerHTML = STATE.categories.map(([catId]) => {
      const c = catCoverage(catId);
      const cls = c.pct >= 60 ? "" : c.pct >= 30 ? "warn" : "danger";
      return `<div class="dl">
        <div class="dl-bar"><div class="dl-fill ${cls}" style="transform:scaleY(${(Math.max(6, c.pct) / 100).toFixed(3)})"></div></div>
        <div class="dl-name">${CAT_SHORT[catId] || catId}</div>
        <div class="dl-pct">${c.pct}%</div>
      </div>`;
    }).join("");
  }

  const OICON = {
    shield: SCENARIO_ICONS.shield,
    radar: ICON_SCAN,
    bell: icon([
      "M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6",
      "M9 17v1a3 3 0 0 0 6 0v-1",
    ]),
  };

  function renderOpsCards() {
    const tools = STATE.tools;
    const vals = Object.values(tools);
    const active = vals.filter((s) => s === "active").length;
    const installed = vals.filter((s) => s === "installed").length;
    const missing = vals.filter((s) => s === "missing").length;
    const bars = STATE.categories.map(([c]) => catCoverage(c).pct);

    document.getElementById("cardDefenses").innerHTML = `
      <div class="ops-card-head"><span class="ops-badge">${OICON.shield}</span>
        <div><div class="ops-card-title">Active Defenses</div><div class="ops-card-tag">Coverage by category</div></div>
        <span class="ops-count">${active + installed}</span></div>
      <div class="ops-bars">${bars.map((b) => `<i style="height:${Math.max(6, b)}%"></i>`).join("")}</div>
      <div class="ops-rows">
        <div class="ops-row"><span class="rl"><span class="mini-dot" style="background:${C_ACTIVE}"></span>Active</span><span class="rv" style="color:${C_ACTIVE}">${active}</span></div>
        <div class="ops-row"><span class="rl"><span class="mini-dot" style="background:${C_INST}"></span>Installed</span><span class="rv">${installed}</span></div>
        <div class="ops-row"><span class="rl"><span class="mini-dot" style="border:1.5px solid ${C_MISS};background:transparent"></span>Missing</span><span class="rv" style="color:var(--text-faint)">${missing}</span></div>
      </div>
      <button class="ops-link" data-goto="install">Manage tools →</button>`;

    const scanEntries = Object.entries(STATE.scans || {});
    document.getElementById("cardScans").innerHTML = `
      <div class="ops-card-head"><span class="ops-badge neutral">${OICON.radar}</span>
        <div><div class="ops-card-title">Scans & Forensics</div><div class="ops-card-tag">On-demand analysis</div></div>
        <span class="ops-count">${scanEntries.length}</span></div>
      <div class="ops-rows">
        ${scanEntries.slice(0, 4).map(([sid, s]) => {
          const ready = STATE.tools[s.tool] !== "missing";
          return `<div class="ops-row"><span class="rl"><span class="mini-dot" style="background:${ready ? C_INST : "transparent"};border:${ready ? "none" : `1.5px solid ${C_MISS}`}"></span><b>${s.label}</b></span><span class="rt">${ready ? "ready" : "needs install"}</span></div>`;
        }).join("")}
      </div>
      <button class="ops-link" data-goto="scans">Open scans →</button>`;

    const th = threatCount();
    const fw = STATE.firewall;
    const events = [];
    if (th.banned) events.push([C_THREAT, `${th.banned} IP(s) banned`, "fail2ban"]);
    if (th.alerts) events.push([ "#f0b03d", `${th.alerts} IDS alert(s)`, "suricata"]);
    events.push([fw && fw.active ? C_ACTIVE : "#f0b03d", fw && fw.active ? `Firewall active · ${fw.blocked_rules} rules` : "Firewall not active", "ufw"]);
    events.push([C_ACTIVE, `Protection at ${STATE.score}%`, "system"]);
    document.getElementById("cardEvents").innerHTML = `
      <div class="ops-card-head"><span class="ops-badge amber">${OICON.bell}</span>
        <div><div class="ops-card-title">Recent Events</div><div class="ops-card-tag">Live activity</div></div>
        <span class="ops-count" style="color:${th.active ? C_THREAT : th.total ? "#f0b03d" : C_ACTIVE}">${th.total}</span></div>
      <div class="ops-rows">
        ${events.slice(0, 4).map(([col, txt, tag]) => `<div class="ops-row"><span class="rl"><span class="mini-dot" style="background:${col}"></span><b>${txt}</b></span><span class="rt">${tag}</span></div>`).join("")}
      </div>
      <button class="ops-link" data-goto="monitor">Live monitor →</button>`;

    document.querySelectorAll("#view-overview .ops-link").forEach((b) => {
      b.addEventListener("click", () => switchTab(b.dataset.goto));
    });
  }

  function switchTab(name) {
    const t = document.querySelector(`.tab[data-tab="${name}"]`);
    if (t) t.click();
  }

  let _ovSig = null;
  function overviewSignature() {
    return STATE.score + "|" + JSON.stringify(STATE.tools) + "|" + JSON.stringify(STATE.threats) +
      "|" + (STATE.firewall ? STATE.firewall.active + ":" + STATE.firewall.blocked_rules : "none") +
      "|" + STATE.system.panic_active;
  }
  function renderOverview(force) {
    const sig = overviewSignature();
    if (!force && sig === _ovSig) return;   // avoid rebuilding (and restarting the radar sweep) when nothing changed
    _ovSig = sig;
    renderRadar();
    renderGauge();
    renderDefenseStrip();
    renderOpsCards();
  }

  function updateSelectedCount() {
    document.getElementById("selectedCount").textContent = selected.size ? `${selected.size} selected` : "";
  }

  function renderInstall() {
    renderCategoryList("installGrid", { renderRow: installRow });
    updateSelectedCount();
    document.querySelectorAll("#installGrid .pick").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(cb.dataset.id); else selected.delete(cb.dataset.id);
        updateSelectedCount();
      });
    });
    document.querySelectorAll("#installGrid .install-one").forEach((btn) => {
      btn.addEventListener("click", () => installTools([btn.dataset.id]));
    });
    document.querySelectorAll("#installGrid .uninstall-one").forEach((btn) => {
      btn.addEventListener("click", () => uninstallTool(btn.dataset.id));
    });
  }

  function rowBusy(id, verb, idx, total) {
    const row = document.querySelector(`#installGrid [data-row="${id}"]`);
    if (row) {
      row.classList.add("installing");
      const btn = row.querySelector(".row-actions button");
      if (btn) { btn.disabled = true; btn.innerHTML = `<i class="spinner"></i>${verb}…`; }
    }
    const prog = document.getElementById("installProgress");
    if (prog) {
      const counter = total > 1 ? ` · ${idx}/${total}` : "";
      prog.hidden = false;
      prog.innerHTML = `<i class="spinner"></i><span>${verb} <b>${STATE.tool_meta[id].label}</b>${counter}…</span>`;
    }
  }

  function clearProgress() {
    const prog = document.getElementById("installProgress");
    if (prog) { prog.hidden = true; prog.innerHTML = ""; }
  }

  function revealConsole() {
    const c = document.querySelector("#view-install .console-wrap");
    if (c) c.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function installTools(ids) {
    if (installing) return;
    installing = true;
    revealConsole();
    document.getElementById("installStopBtn").hidden = false;
    cancelRequested = false;
    for (let i = 0; i < ids.length; i++) {
      if (cancelRequested) { appendConsole("console-install", "[!] Stopped — remaining selected tools were not started."); break; }
      const id = ids[i];
      rowBusy(id, "Installing", i + 1, ids.length);
      appendConsole("console-install", `=== Installing ${STATE.tool_meta[id].label} (${i + 1}/${ids.length}) ===`);
      await new Promise((resolve) => {
        streamTo(`/api/stream/install?tool=${id}&${sudoParam()}`, "console-install", () => resolve());
      });
    }
    clearProgress();
    document.getElementById("installStopBtn").hidden = true;
    installing = false;
    await refreshStatus();
    renderInstall();
  }

  async function uninstallTool(id) {
    if (installing) return;
    installing = true;
    cancelRequested = false;
    revealConsole();
    document.getElementById("installStopBtn").hidden = false;
    rowBusy(id, "Removing", 1, 1);
    appendConsole("console-install", `=== Removing ${STATE.tool_meta[id].label} ===`);
    await new Promise((resolve) => {
      streamTo(`/api/stream/uninstall?tool=${id}&${sudoParam()}`, "console-install", () => resolve());
    });
    clearProgress();
    document.getElementById("installStopBtn").hidden = true;
    installing = false;
    await refreshStatus();
    renderInstall();
  }

  document.getElementById("installStopBtn").addEventListener("click", () => {
    appendConsole("console-install", "[!] Stop requested — interrupting the current package operation. It may be left partially installed; re-run install or `dpkg --configure -a` on the box if apt complains afterward.");
    cancelRun();
  });

  document.getElementById("selectAllBtn").addEventListener("click", () => {
    Object.keys(STATE.tool_meta).forEach((id) => { if (STATE.tools[id] === "missing") selected.add(id); });
    renderInstall();
  });
  document.getElementById("clearSelectedBtn").addEventListener("click", () => { selected.clear(); renderInstall(); });
  document.getElementById("installSelectedBtn").addEventListener("click", () => {
    if (!selected.size) return;
    const ids = Array.from(selected);
    selected.clear();
    installTools(ids);
  });

  // ---------------- Configure ----------------
  function depBadge(toolId) {
    if (!toolId) return "";
    const meta = STATE.tool_meta[toolId];
    const status = STATE.tools[toolId];
    if (!meta) return "";
    if (status === "missing") {
      return `<span class="dep-pill missing">requires ${meta.label}, <button class="dep-goto" data-goto-install="${toolId}">install it</button></span>`;
    }
    return `<span class="dep-pill ok">✓ ${meta.label} ${status === "active" ? "active" : "installed"}</span>`;
  }

  // Shared by Configure's grouped grid and Monitor's standalone Maintenance
  // card — same action, same look, wherever it's run from.
  function buildActionCard(id, action, interfaces) {
    const ready = !action.requires || STATE.tools[action.requires] !== "missing";
    const card = document.createElement("div");
    card.className = "action-card panel" + (ready ? "" : " locked");
    let paramsHtml = "";
    for (const p of action.params) {
      if (p.type === "text") {
        paramsHtml += `<input type="text" data-param="${p.name}" value="${p.default}" placeholder="${p.placeholder || ""}">`;
      } else if (p.type === "select_iface") {
        paramsHtml += `<select data-param="${p.name}">` + interfaces.map((i) => `<option value="${i}">${i}</option>`).join("") + `</select>`;
      }
    }
    const ran = lastRun[id];
    const reqStatus = action.requires ? STATE.tools[action.requires] : null;
    card.innerHTML = `
      <div class="action-head">
        <span class="action-badge">${ICON_SLIDERS}</span>
        <div class="action-title">
          ${action.label}
          ${reqStatus ? `<span class="status-pill ${reqStatus}">${statusLabel(reqStatus)}</span>` : ""}
          ${action.recommended ? '<span class="rec-badge">Recommended</span>' : ""}
        </div>
      </div>
      <div class="action-desc">${action.description}</div>
      ${action.why ? `<div class="action-why"><b>${action.recommended ? "Why this first:" : "When to use this:"}</b> ${action.why}</div>` : ""}
      ${depBadge(action.requires)}
      ${paramsHtml ? `<div class="action-params">${paramsHtml}</div>` : ""}
      <button class="btn primary run-action" data-id="${id}" ${ready ? "" : "disabled"}>Run action</button>
      ${ran ? `<div class="last-run">Last run ${timeAgo(ran)}</div>` : ""}
    `;
    return card;
  }

  async function renderActions() {
    const grid = document.getElementById("actionsGrid");
    grid.innerHTML = "";
    let interfaces = [];
    try { interfaces = (await apiGet("/api/interfaces")).interfaces || []; } catch (e) {}

    // Group actions by their `group` field, preserving registry order within each group.
    const groups = new Map();
    for (const [id, action] of Object.entries(STATE.actions)) {
      const g = action.group || "Other";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push([id, action]);
    }

    for (const [groupName, entries] of groups) {
      const block = document.createElement("div");
      block.className = "category-block";
      block.innerHTML = `<div class="category-title">${groupName}</div>`;
      const wrap = document.createElement("div");
      wrap.className = "actions-grid";
      for (const [id, action] of entries) {
        wrap.appendChild(buildActionCard(id, action, interfaces));
      }
      block.appendChild(wrap);
      grid.appendChild(block);
    }

    grid.querySelectorAll(".run-action").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest(".action-card");
        const params = {};
        card.querySelectorAll("[data-param]").forEach((inp) => { params[inp.dataset.param] = inp.value; });
        runAction(btn.dataset.id, params, "console-configure", () => renderActions());
      });
    });
    grid.querySelectorAll("[data-goto-install]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab("install"));
    });
  }

  // `installing` is the shared "the server's one execution slot is busy"
  // flag every runner (install/uninstall/scan/scenario) already checks —
  // this used to be the one path that didn't, so the 6s status poll could
  // rebuild the button mid-run (nothing else guarded against it either) and
  // a second click, or a click from Install/Scans while this was running,
  // would start a second process the UI could no longer see or cancel.
  function runAction(id, params, consoleId, onDone) {
    if (installing) return;
    installing = true;
    consoleId = consoleId || "console-configure";
    const qs = new URLSearchParams({ name: id, ...params }).toString();
    appendConsole(consoleId, `=== Running ${STATE.actions[id].label} ===`);
    lastRun[id] = new Date();
    streamTo(`/api/stream/action?${qs}&${sudoParam()}`, consoleId, () => {
      installing = false;
      if (onDone) onDone();
    });
  }

  // ---------------- Scans ----------------
  function renderScans() {
    const grid = document.getElementById("scansGrid");
    grid.innerHTML = "";
    const entries = Object.entries(STATE.scans);
    let firstReadyMarked = false;
    for (const [id, scan] of entries) {
      const ready = STATE.tools[scan.tool] !== "missing";
      const recommend = ready && !firstReadyMarked;
      if (ready) firstReadyMarked = true;
      const running = scanRunning === id;
      const ran = lastRun[id];
      const card = document.createElement("div");
      card.className = "action-card scan-card panel" + (ready ? "" : " locked") + (running ? " running" : "");
      card.innerHTML = `
        <div class="action-head">
          <span class="action-badge scan">${ICON_SCAN}</span>
          <div class="action-title">${scan.label}${running ? '<span class="run-badge">Running</span>' : recommend ? '<span class="rec-badge">Recommended</span>' : ""}</div>
        </div>
        <div class="action-desc">${scan.description}</div>
        ${depBadge(scan.tool)}
        <button class="btn primary run-scan" data-id="${id}" ${ready && !scanRunning ? "" : "disabled"}>${running ? '<i class="spinner"></i>Running…' : "Run scan"}</button>
        ${ran && !running ? `<div class="last-run">Last run ${timeAgo(ran)}</div>` : ""}
      `;
      grid.appendChild(card);
    }
    grid.querySelectorAll(".run-scan").forEach((btn) => {
      btn.addEventListener("click", () => runScan(btn.dataset.id));
    });
    grid.querySelectorAll("[data-goto-install]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab("install"));
    });
  }

  async function runScan(id) {
    if (installing) return;
    installing = true;
    cancelRequested = false;
    scanRunning = id;
    renderScans();
    document.getElementById("scansConsoleTitle").textContent = `Running: ${STATE.scans[id].label}`;
    document.getElementById("scansStopBtn").hidden = false;
    document.querySelector("#view-scans .console-wrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
    appendConsole("console-scans", `=== Starting ${STATE.scans[id].label} scan ===`);
    lastRun[id] = new Date();
    await new Promise((res) => streamTo(`/api/stream/scan?name=${id}&${sudoParam()}`, "console-scans", () => res()));
    scanRunning = null;
    installing = false;
    document.getElementById("scansConsoleTitle").textContent = "Scan output";
    document.getElementById("scansStopBtn").hidden = true;
    renderScans();
  }

  document.getElementById("scansStopBtn").addEventListener("click", () => {
    appendConsole("console-scans", "[!] Stop requested.");
    cancelRun();
  });

  // ---------------- Scenarios (one-click playbooks, multi-select + queue) ----------------
  function scenarioDefaultSteps(sc) {
    const nActions = (sc.actions || []).length;
    return `${sc.tools.length} tools · ${nActions} config step${nActions === 1 ? "" : "s"}${sc.then ? ` · then ${sc.then}` : ""}`;
  }

  function renderScenarios() {
    const grid = document.getElementById("scenariosGrid");
    if (!grid || !STATE.scenarios) return;
    grid.innerHTML = "";
    for (const [id, sc] of Object.entries(STATE.scenarios)) {
      const chips = sc.tools.map((t) => {
        const st = STATE.tools[t];
        const have = st !== "missing";
        const label = STATE.tool_meta[t] ? STATE.tool_meta[t].label : t;
        return `<span class="sc-chip ${have ? "have" : ""}">${have ? "✓ " : ""}${label}</span>`;
      }).join("");
      const nHave = sc.tools.filter((t) => STATE.tools[t] !== "missing").length;
      const nActive = sc.tools.filter((t) => STATE.tools[t] === "active").length;
      const fullyPresent = nHave === sc.tools.length;
      const running = scenarioRunning === id;
      const queuePos = scenarioQueue.indexOf(id);
      const queued = !running && queuePos !== -1;
      const coverageClass = fullyPresent ? "full" : nHave > 0 ? "partial" : "";
      const card = document.createElement("div");
      card.className = "scenario-card panel" + (running ? " running" : queued ? " queued" : fullyPresent ? " deployed" : "");
      card.dataset.scenarioId = id;
      card.dataset.defaultSteps = scenarioDefaultSteps(sc);
      // Header badge priority: running > queued (shown in the steps line
      // instead) > already fully deployed > difficulty level. Once you've
      // run a playbook, knowing it's live matters more than its difficulty.
      const headerBadge = running
        ? '<span class="run-badge">Running</span>'
        : fullyPresent
          ? `<span class="status-pill active">${nActive === sc.tools.length ? "Active" : "Deployed"}</span>`
          : sc.level ? `<span class="sc-level lvl-${sc.level.toLowerCase()}">${sc.level}</span>` : "";
      card.innerHTML = `
        <div class="sc-head">
          <label class="sc-pick-wrap"><input type="checkbox" class="sc-pick" data-id="${id}" ${scenarioSelected.has(id) ? "checked" : ""} ${installing ? "disabled" : ""}></label>
          <span class="sc-badge">${SCENARIO_ICONS[sc.icon] || SCENARIO_ICONS.shield}</span>
          <div class="sc-headtext">
            <div class="sc-title">${sc.label}</div>
            <div class="sc-steps" data-role="steps">${running ? `Step ${scenarioStep ? scenarioStep.i : "?"}/${scenarioStep ? scenarioStep.total : "?"}: ${scenarioStep ? scenarioStep.label : ""}` : queued ? `Queued (position ${queuePos + 1})` : card.dataset.defaultSteps}</div>
          </div>
          ${headerBadge}
        </div>
        <div class="sc-tagline">${sc.tagline}</div>
        ${sc.detail ? `<div class="sc-detail">${sc.detail}</div>` : ""}
        <div class="sc-chips">${chips}</div>
        <div class="sc-foot">
          ${sc.time ? `<span class="sc-time">${ICON_CLOCK}${sc.time}</span>` : "<span></span>"}
          ${nHave ? `<span class="sc-have-count ${coverageClass}">${nHave}/${sc.tools.length} already installed</span>` : ""}
        </div>
        <button class="btn primary run-scenario" data-id="${id}" ${installing ? "disabled" : ""}>${running ? '<i class="spinner"></i>Running…' : queued ? "Queued…" : fullyPresent ? "Run again" : "Run playbook"}</button>
      `;
      grid.appendChild(card);
    }
    grid.querySelectorAll(".run-scenario").forEach((btn) => {
      btn.addEventListener("click", () => runScenarios([btn.dataset.id]));
    });
    grid.querySelectorAll(".sc-pick").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) scenarioSelected.add(cb.dataset.id); else scenarioSelected.delete(cb.dataset.id);
        updateScenarioToolbar();
      });
    });
    updateScenarioToolbar();
  }

  // Cheap per-tick update while a queue is running: touches only the
  // running/queued cards' status text + button, no full grid rebuild (so
  // checkboxes elsewhere don't flicker or lose focus mid-run).
  function paintScenarioRunState() {
    document.querySelectorAll(".scenario-card").forEach((card) => {
      const id = card.dataset.scenarioId;
      const sc = STATE.scenarios[id];
      const running = scenarioRunning === id;
      const queuePos = scenarioQueue.indexOf(id);
      const queued = !running && queuePos !== -1;
      const nHave = sc.tools.filter((t) => STATE.tools[t] !== "missing").length;
      const nActive = sc.tools.filter((t) => STATE.tools[t] === "active").length;
      const fullyPresent = nHave === sc.tools.length;
      card.classList.toggle("running", running);
      card.classList.toggle("queued", queued);
      card.classList.toggle("deployed", !running && !queued && fullyPresent);
      const stepsEl = card.querySelector('[data-role="steps"]');
      const btn = card.querySelector(".run-scenario");
      const badgeSlot = card.querySelector(".sc-head > .run-badge, .sc-head > .status-pill, .sc-head > .sc-level");
      if (running) {
        stepsEl.textContent = scenarioStep ? `Step ${scenarioStep.i}/${scenarioStep.total}: ${scenarioStep.label}` : "Starting…";
        btn.innerHTML = '<i class="spinner"></i>Running…';
        btn.disabled = true;
        if (badgeSlot) badgeSlot.outerHTML = '<span class="run-badge">Running</span>';
      } else if (queued) {
        stepsEl.textContent = `Queued (position ${queuePos + 1})`;
        btn.textContent = "Queued…";
        btn.disabled = true;
      } else {
        stepsEl.textContent = card.dataset.defaultSteps;
        btn.textContent = fullyPresent ? "Run again" : "Run playbook";
        btn.disabled = installing;
        if (badgeSlot && badgeSlot.classList.contains("run-badge")) {
          badgeSlot.outerHTML = fullyPresent
            ? `<span class="status-pill active">${nActive === sc.tools.length ? "Active" : "Deployed"}</span>`
            : sc.level ? `<span class="sc-level lvl-${sc.level.toLowerCase()}">${sc.level}</span>` : "";
        }
      }
    });
    updateScenarioToolbar();
  }

  function updateScenarioToolbar() {
    const statusEl = document.getElementById("scRunStatus");
    const stopBtn = document.getElementById("scStopBtn");
    if (scenarioRunning) {
      const sc = STATE.scenarios[scenarioRunning];
      const stepTxt = scenarioStep ? ` · step ${scenarioStep.i}/${scenarioStep.total}` : "";
      const queueTxt = scenarioQueue.length > 1 ? ` · ${scenarioQueue.length - 1} queued after this` : "";
      statusEl.hidden = false;
      statusEl.innerHTML = `<i class="spinner"></i><span>Running <b>${sc.label}</b>${stepTxt}${queueTxt}</span>`;
      stopBtn.hidden = false;
    } else {
      statusEl.hidden = true;
      stopBtn.hidden = true;
    }
    document.getElementById("scSelectedCount").textContent = scenarioSelected.size ? `${scenarioSelected.size} selected` : "";
  }

  async function runScenarios(ids) {
    if (installing || !ids.length) return;
    installing = true;
    cancelRequested = false;
    scenarioQueue = [...ids];
    scenarioSelected.clear();

    const wrap = document.getElementById("scenarioConsoleWrap");
    wrap.hidden = false;
    const con = "console-scenarios";
    wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
    paintScenarioRunState();

    let lastThen = null;
    while (scenarioQueue.length && !cancelRequested) {
      const id = scenarioQueue[0];
      const sc = STATE.scenarios[id];
      scenarioRunning = id;
      scenarioStep = null;
      document.getElementById("scenarioTitle").textContent = `Running: ${sc.label}`;
      paintScenarioRunState();

      const steps = [];
      sc.tools.forEach((t) => steps.push({ type: "install", tool: t }));
      (sc.actions || []).forEach((a) => steps.push({ type: "action", action: a }));

      appendConsole(con, `#### Playbook: ${sc.label} (${steps.length} step(s)) ####`);
      for (let i = 0; i < steps.length && !cancelRequested; i++) {
        const step = steps[i], stepNum = i + 1;
        if (step.type === "install") {
          const meta = STATE.tool_meta[step.tool];
          scenarioStep = { i: stepNum, total: steps.length, label: `Installing ${meta.label}` };
          paintScenarioRunState();
          if (STATE.tools[step.tool] !== "missing") {
            appendConsole(con, `[+] [${stepNum}/${steps.length}] ${meta.label} already present, skipping.`);
            continue;
          }
          appendConsole(con, `=== [${stepNum}/${steps.length}] Installing ${meta.label} ===`);
          await new Promise((res) => streamTo(`/api/stream/install?tool=${step.tool}&${sudoParam()}`, con, () => res()));
        } else {
          const a = step.action;
          const alabel = STATE.actions[a.name] ? STATE.actions[a.name].label : a.name;
          scenarioStep = { i: stepNum, total: steps.length, label: alabel };
          paintScenarioRunState();
          const qs = new URLSearchParams({ name: a.name, ...(a.params || {}) }).toString();
          appendConsole(con, `=== [${stepNum}/${steps.length}] ${alabel} ===`);
          await new Promise((res) => streamTo(`/api/stream/action?${qs}&${sudoParam()}`, con, () => res()));
        }
      }

      if (cancelRequested) {
        appendConsole(con, `[!] Stopped during "${sc.label}". The rest of the queue was cancelled.`);
        scenarioQueue = [];
      } else {
        appendConsole(con, `[+] Playbook "${sc.label}" complete.`);
        if (sc.then) lastThen = sc.then;
        scenarioQueue.shift();
      }
      scenarioRunning = null;
      scenarioStep = null;
      await refreshStatus();
      renderScenarios();
    }

    installing = false;
    renderScenarios();
    if (lastThen === "monitor" || lastThen === "scans") {
      const t = document.querySelector(`.tab[data-tab="${lastThen}"]`);
      if (t) t.click();
    }
  }

  document.getElementById("scSelectAllBtn").addEventListener("click", () => {
    Object.keys(STATE.scenarios).forEach((id) => scenarioSelected.add(id));
    renderScenarios();
  });
  document.getElementById("scClearSelectedBtn").addEventListener("click", () => { scenarioSelected.clear(); renderScenarios(); });
  document.getElementById("scRunSelectedBtn").addEventListener("click", () => {
    if (!scenarioSelected.size) return;
    runScenarios([...scenarioSelected]);
  });
  document.getElementById("scStopBtn").addEventListener("click", () => {
    appendConsole("console-scenarios", "[!] Stop requested. The rest of the queue will not run.");
    cancelRun();
  });

  // ---------------- Monitor: logs (auto-tail every source, merged feed) ----------------
  function stopLogs() {
    logStreams.forEach((es) => { try { es.close(); } catch (e) {} });
    logStreams = [];
  }

  function appendLog(src, text) {
    const el = document.getElementById("console-monitor");
    const cls = text.startsWith("[-]") ? "line-err" : text.startsWith("[+]") ? "line-ok" : text.startsWith("[!]") ? "line-warn" : "";
    const line = document.createElement("div");
    line.className = "log-line";
    line.dataset.src = src;
    line.hidden = muted.has(src);
    const tag = document.createElement("span");
    tag.className = "log-tag src-" + src;
    tag.textContent = src;
    const body = document.createElement("span");
    if (cls) body.className = cls;
    body.textContent = text;
    line.appendChild(tag);
    line.appendChild(body);
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    el.appendChild(line);
    while (el.childElementCount > 600) el.removeChild(el.firstChild);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function openLog(src) {
    const es = new EventSource(`/api/stream/logs?source=${src}`);
    es.onmessage = (ev) => {
      if (ev.data.startsWith("__DONE__")) { es.close(); return; }
      appendLog(src, ev.data);
    };
    // A dropped connection (server restart, brief network hiccup) used to
    // just give up silently — the tag stays in the legend looking live, but
    // that source never updates again until a full page reload. Reconnect
    // instead, same backoff as the monitor stream.
    es.onerror = () => {
      es.close();
      const i = logStreams.indexOf(es);
      if (i !== -1) logStreams.splice(i, 1);
      setTimeout(() => openLog(src), 3000);
    };
    logStreams.push(es);
  }

  function applyLogFilter() {
    document.querySelectorAll("#console-monitor .log-line").forEach((l) => {
      l.hidden = muted.has(l.dataset.src);
    });
  }

  function startLogs() {
    stopLogs();
    muted = new Set();
    const legend = document.getElementById("logLegend");
    legend.innerHTML = "";
    document.getElementById("console-monitor").innerHTML = "";
    STATE.log_sources.forEach((src) => {
      const chip = document.createElement("button");
      chip.className = "log-chip src-" + src;
      chip.innerHTML = `<i></i>${src}`;
      chip.addEventListener("click", () => {
        if (muted.has(src)) { muted.delete(src); chip.classList.remove("off"); }
        else { muted.add(src); chip.classList.add("off"); }
        applyLogFilter();
      });
      legend.appendChild(chip);
      openLog(src);
    });
  }

  // ---------------- Panic (hold-to-engage, no blocking modal) ----------------
  const panicBtn = document.getElementById("panicBtn");
  const panicHint = document.getElementById("panicHint");
  const panicLabel = panicBtn.querySelector("span");
  const HOLD_MS = 1100;
  let holdRAF = null;

  function panicIsOn() { return panicBtn.classList.contains("on"); }

  function setPanicUI(active) {
    panicBtn.classList.toggle("on", active);
    panicLabel.textContent = active ? "Disengage" : "Panic";
    if (panicHint) panicHint.textContent = active ? "network locked" : "hold to engage";
    document.getElementById("panicBanner").hidden = !active;
  }

  async function togglePanic(enable) {
    cancelHold();
    const res = await apiPost("/api/panic", { enable });
    setPanicUI(res.panic_active);
  }

  function cancelHold() {
    if (holdRAF) cancelAnimationFrame(holdRAF);
    holdRAF = null;
    panicBtn.classList.remove("arming");
    panicBtn.style.setProperty("--hold", "0");
  }

  function beginHold(e) {
    if (panicIsOn()) return;           // engaged already; a click will disengage
    e.preventDefault();
    panicBtn.classList.add("arming");
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / HOLD_MS);
      panicBtn.style.setProperty("--hold", p.toFixed(3));
      if (p >= 1) { cancelHold(); togglePanic(true); return; }
      holdRAF = requestAnimationFrame(tick);
    };
    holdRAF = requestAnimationFrame(tick);
  }

  panicBtn.addEventListener("pointerdown", beginHold);
  panicBtn.addEventListener("pointerup", () => { if (!panicIsOn()) cancelHold(); });
  panicBtn.addEventListener("pointerleave", () => { if (!panicIsOn()) cancelHold(); });
  panicBtn.addEventListener("pointercancel", cancelHold);
  panicBtn.addEventListener("click", () => { if (panicIsOn()) togglePanic(false); });
  document.getElementById("panicBannerOff").addEventListener("click", () => togglePanic(false));

  // ---------------- Live monitor stream (network + resources) ----------------
  const NET_POINTS = 60;
  let rxHistory = new Array(NET_POINTS).fill(0);
  let txHistory = new Array(NET_POINTS).fill(0);

  function pointsFor(history, max, w, h) {
    const step = w / (history.length - 1);
    return history.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 8) - 3).toFixed(1)}`).join(" ");
  }

  function renderNetChart() {
    const w = 600, h = 130;
    const max = Math.max(1024, ...rxHistory, ...txHistory);
    const rxLine = pointsFor(rxHistory, max, w, h);
    const txLine = pointsFor(txHistory, max, w, h);
    document.getElementById("rxLine").setAttribute("points", rxLine);
    document.getElementById("txLine").setAttribute("points", txLine);
    document.getElementById("rxArea").setAttribute("points", `0,${h} ${rxLine} ${w},${h}`);
  }

  function setMeter(prefix, pct) {
    const p = pct == null ? 0 : pct;
    document.getElementById(`res${prefix}`).textContent = pct == null ? "N/A" : `${pct}%`;
    const bar = document.getElementById(`res${prefix}Bar`);
    bar.style.transform = `scaleX(${Math.max(0, Math.min(100, p)) / 100})`;
    bar.className = "meter-fill " + meterClass(p);
  }

  function startMonitorStream() {
    const es = new EventSource("/api/stream/monitor");
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        rxHistory.push(d.rx); rxHistory.shift();
        txHistory.push(d.tx); txHistory.shift();
        document.getElementById("rateRx").textContent = formatRate(d.rx);
        document.getElementById("rateTx").textContent = formatRate(d.tx);
        renderNetChart();
        setMeter("Cpu", d.cpu);
        setMeter("Mem", d.mem);
        setMeter("Disk", d.disk);
        document.getElementById("resUptime").textContent = d.uptime;
      } catch (e) {}
    };
    es.onerror = () => { es.close(); setTimeout(startMonitorStream, 3000); };
  }

  // ---------------- Alerts ----------------
  const ALERT_ICONS = {
    critical: icon([
      "M12.802 2.165l5.575 2.389c.48 .206 .863 .589 1.07 1.07l2.388 5.574c.22 .512 .22 1.092 0 1.604l-2.389 5.575c-.206 .48 -.589 .863 -1.07 1.07l-5.574 2.388c-.512 .22 -1.092 .22 -1.604 0l-5.575 -2.389a2.036 2.036 0 0 1 -1.07 -1.07l-2.388 -5.574a2.036 2.036 0 0 1 0 -1.604l2.389 -5.575c.206 -.48 .589 -.863 1.07 -1.07l5.574 -2.388a2.036 2.036 0 0 1 1.604 0",
      "M12 8v4", "M12 16h.01",
    ]), // alert-octagon
    warn: icon([
      "M12 9v4",
      "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0",
      "M12 16h.01",
    ]), // alert-triangle
    info: icon(["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 9h.01", "M11 12h1v4h1"]), // info-circle
  };
  let seenAlertIds = new Set();      // alerts already surfaced in the top drop-bar this session
  let dismissedDropId = null;

  function computeAlerts() {
    const alerts = [];
    const s = STATE;
    if (s.system.panic_active) {
      alerts.push({ id: "panic", sev: "critical", title: "Panic mode is engaged",
        detail: "All inbound and outbound traffic is blocked except loopback. Disengage from the top bar once the situation is handled.", tab: "overview" });
    }
    const fw = s.firewall;
    if (!fw) {
      alerts.push({ id: "fw-missing", sev: "critical", title: "No firewall installed",
        detail: "UFW isn't installed, so nothing is filtering inbound or outbound traffic on this machine.", tab: "install" });
    } else if (!fw.active) {
      alerts.push({ id: "fw-inactive", sev: "critical", title: "Firewall is installed but not enabled",
        detail: "UFW is present but inactive, so this machine currently has no firewall protection.", tab: "configure" });
    }
    if ((s.threats.suricata_alerts || 0) > 0) {
      alerts.push({ id: "ids-alerts", sev: "critical", title: `Suricata flagged ${s.threats.suricata_alerts} alert(s)`,
        detail: "Network intrusion detection has active alerts. Review the live log in Monitor.", tab: "monitor" });
    }
    if (s.score < 40) {
      alerts.push({ id: "score-low", sev: "critical", title: `Protection score is low (${s.score}%)`,
        detail: "Most core defenses are missing. Run a Scenario playbook to raise coverage quickly.", tab: "scenarios" });
    } else if (s.score < 70) {
      alerts.push({ id: "score-mid", sev: "warn", title: `Protection score is moderate (${s.score}%)`,
        detail: "Several categories have gaps. Check the Defense Grid on Overview for what's missing.", tab: "overview" });
    }
    if ((s.threats.banned_ips || 0) > 0) {
      alerts.push({ id: "banned-ips", sev: "info", title: `${s.threats.banned_ips} IP(s) currently banned`,
        detail: "Fail2Ban has actively banned these addresses after repeated failed logins. No action needed.", tab: "monitor" });
    }
    if (s.tools.clamav === "missing" && s.tools.rkhunter === "missing") {
      alerts.push({ id: "no-malware-scan", sev: "warn", title: "No malware or rootkit scanner installed",
        detail: "Neither ClamAV nor rkhunter is present, so nothing is checking this system for malware.", tab: "scenarios" });
    }
    if (s.tools.auto_updates === "missing") {
      alerts.push({ id: "no-autoupdate", sev: "info", title: "Automatic security updates are off",
        detail: "Security patches won't install themselves. Enable Auto Security Updates from Install.", tab: "install" });
    }
    const sevOrder = { critical: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);
    return alerts;
  }

  const TAB_LABEL = { overview: "Overview", alerts: "Alerts", scenarios: "Scenarios", install: "Install", configure: "Configure", monitor: "Monitor", scans: "Scans" };

  function renderAlerts() {
    const alerts = computeAlerts();
    const crit = alerts.filter((a) => a.sev === "critical").length;
    const warn = alerts.filter((a) => a.sev === "warn").length;
    const info = alerts.filter((a) => a.sev === "info").length;

    document.getElementById("alertsSummary").innerHTML = `
      <div class="as-tile crit"><div class="n">${crit}</div><div class="l">Critical</div></div>
      <div class="as-tile warn"><div class="n">${warn}</div><div class="l">Warning</div></div>
      <div class="as-tile ok"><div class="n">${info}</div><div class="l">Informational</div></div>
    `;

    // severity distribution: a flat segmented bar showing the shape of
    // what's outstanding at a glance, before reading the list below
    const sevBarWrap = document.getElementById("sevBarWrap");
    const sevBar = document.getElementById("alertsBar");
    if (alerts.length) {
      sevBarWrap.hidden = false;
      sevBar.innerHTML = [
        crit ? `<div class="sev-seg crit" style="flex:${crit}" title="${crit} critical"></div>` : "",
        warn ? `<div class="sev-seg warn" style="flex:${warn}" title="${warn} warning"></div>` : "",
        info ? `<div class="sev-seg info" style="flex:${info}" title="${info} informational"></div>` : "",
      ].join("");
    } else {
      sevBarWrap.hidden = true;
    }

    // by-area breakdown: where the outstanding alerts actually live, so you
    // can jump straight to the tab that needs attention
    const byTab = {};
    alerts.forEach((a) => { byTab[a.tab] = (byTab[a.tab] || 0) + 1; });
    const areasEl = document.getElementById("alertsAreas");
    const areaEntries = Object.entries(byTab);
    areasEl.innerHTML = areaEntries.length
      ? areaEntries.map(([tab, n]) => `<button class="area-chip" data-goto="${tab}">${TAB_LABEL[tab] || tab}<b>${n}</b></button>`).join("")
      : "";
    areasEl.querySelectorAll(".area-chip").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.goto)));

    const list = document.getElementById("alertsList");
    if (!alerts.length) {
      list.innerHTML = `<div class="alerts-empty"><div class="big">✓ All clear</div>No active alerts. Every tracked defense looks healthy.</div>`;
    } else {
      list.innerHTML = alerts.map((a) => `
        <div class="alert-item ${a.sev}">
          <span class="alert-ico">${ALERT_ICONS[a.sev]}</span>
          <div class="alert-body">
            <div class="alert-title">${a.title}<span class="alert-sev">${a.sev}</span></div>
            <div class="alert-detail">${a.detail}</div>
          </div>
          <button class="btn small alert-fix" data-goto="${a.tab}">Review</button>
        </div>
      `).join("");
      list.querySelectorAll(".alert-fix").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.goto)));
    }

    // tab badge
    const badge = document.getElementById("alertsBadge");
    const urgent = crit + warn;
    badge.hidden = urgent === 0;
    badge.textContent = String(urgent);

    // top drop banner: surface the single most urgent NEW critical/warn alert once
    const dropworthy = alerts.filter((a) => a.sev === "critical" || a.sev === "warn");
    const fresh = dropworthy.find((a) => !seenAlertIds.has(a.id));
    if (fresh && dismissedDropId !== fresh.id) {
      showAlertDrop(fresh);
    } else if (!dropworthy.length) {
      hideAlertDrop();
    }
    dropworthy.forEach((a) => seenAlertIds.add(a.id));
  }

  function showAlertDrop(alert) {
    const drop = document.getElementById("alertDrop");
    drop.className = "alert-drop" + (alert.sev === "warn" ? " sev-warn" : "");
    document.getElementById("alertDropTitle").textContent = alert.title;
    document.getElementById("alertDropDetail").textContent = alert.detail;
    document.getElementById("alertDropView").onclick = () => { switchTab("alerts"); hideAlertDrop(); };
    drop.dataset.id = alert.id;
    drop.hidden = false;
  }
  function hideAlertDrop() {
    const drop = document.getElementById("alertDrop");
    dismissedDropId = drop.dataset.id || dismissedDropId;
    drop.hidden = true;
  }
  document.getElementById("alertDropClose").addEventListener("click", hideAlertDrop);

  // ---------------- Autostart (run on every boot via systemd) ----------------
  async function refreshAutostart() {
    try {
      const res = await apiGet("/api/autostart");
      setAutostartUI(!!res.enabled);
    } catch (e) {}
  }
  function setAutostartUI(on) {
    const chip = document.getElementById("autostartChip");
    chip.classList.toggle("on", on);
    document.getElementById("autostartLabel").textContent = on ? "Runs on boot" : "Autostart";
    chip.title = on
      ? "OpSec starts automatically on every boot, click to disable"
      : "Run OpSec automatically on every boot, even after a restart";
  }
  document.getElementById("autostartChip").addEventListener("click", async () => {
    const chip = document.getElementById("autostartChip");
    const enabling = !chip.classList.contains("on");
    chip.disabled = true;
    try {
      const res = await apiPost("/api/autostart", { enable: enabling });
      setAutostartUI(!!res.enabled);
    } finally {
      chip.disabled = false;
    }
  });

  // ---------------- Sudo toggle ----------------
  // Purely a client-side preference: it just changes what query param gets
  // sent on the next run, read by opsec_server.py and forwarded to
  // core/opsec_core.sh as OPSEC_USE_SUDO. Nothing currently running is
  // affected — this decides how the NEXT install/action/scan starts.
  function setSudoUI() {
    const chip = document.getElementById("sudoChip");
    chip.classList.toggle("on", useSudo);
    document.getElementById("sudoLabel").textContent = useSudo ? "Sudo: On" : "Sudo: Off";
    chip.title = useSudo
      ? "Installs/actions/scans run with sudo. Click to run without sudo instead."
      : "Installs/actions/scans run WITHOUT sudo. Click to switch back to sudo.";
  }
  document.getElementById("sudoChip").addEventListener("click", () => {
    useSudo = !useSudo;
    try { localStorage.setItem("opsec_use_sudo", useSudo ? "1" : "0"); } catch (e) {}
    setSudoUI();
  });
  setSudoUI();

  // ---------------- Theme (dark / light) ----------------
  // The <head> inline script already applied a saved "light" choice before
  // first paint (see index.html) to avoid a flash; this just keeps the chip
  // in sync and handles the click. Default is dark — no attribute at all —
  // matching how the whole visual system (including the always-dark radar
  // and console "screens") was designed from the start.
  function setThemeUI(isLight) {
    const chip = document.getElementById("themeChip");
    chip.classList.toggle("on", isLight);
    document.getElementById("themeIcon").innerHTML = isLight ? ICON_SUN : ICON_MOON;
    chip.title = isLight ? "Light mode — click to switch to dark" : "Dark mode — click to switch to light";
  }
  function applyTheme(isLight) {
    if (isLight) document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("opsec_theme", isLight ? "light" : "dark"); } catch (e) {}
    setThemeUI(isLight);
  }
  document.getElementById("themeChip").addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") !== "light");
  });
  setThemeUI(document.documentElement.getAttribute("data-theme") === "light");

  // ---------------- Desktop widget pop-out ----------------
  // A real browser window (via window.open with no toolbar/menubar), not an
  // embedded overlay — it needs no OS package, no compositor, nothing that
  // can be broken by the desktop environment. Drag it anywhere, including
  // onto the desktop itself; most window managers also offer "always on
  // top" on its title bar for a true widget feel.
  document.getElementById("widgetPopoutBtn").addEventListener("click", () => {
    const w = 360, h = 640;
    const left = Math.max(0, (window.screen.availWidth || 1280) - w - 24);
    const features = `width=${w},height=${h},left=${left},top=24,menubar=no,toolbar=no,location=no,status=no,scrollbars=yes,resizable=yes`;
    window.open("/widget", "opsec_widget_popup", features);
  });

  // ---------------- Monitor: Active Protection ----------------
  // Same STATE the rest of the dashboard already polls — this just answers
  // "what's actually active right now" in one place instead of making the
  // user piece it together from Install/Configure/Scenarios separately.
  function renderActiveStatus() {
    const toolsEl = document.getElementById("activeToolsChips");
    if (!toolsEl) return; // Monitor markup not in the DOM yet

    const activeTools = Object.entries(STATE.tools)
      .filter(([, st]) => st === "active")
      .map(([id]) => STATE.tool_meta[id].label);
    toolsEl.innerHTML = activeTools.length
      ? activeTools.map((l) => `<span class="prot-chip">${l}</span>`).join("")
      : `<div class="prot-empty">Nothing active yet. Run a Scenario or a Configure action to get started.</div>`;

    const activeScenarios = Object.values(STATE.scenarios)
      .filter((sc) => sc.tools.length && sc.tools.every((t) => STATE.tools[t] === "active"))
      .map((sc) => sc.label);
    document.getElementById("activeScenariosChips").innerHTML = activeScenarios.length
      ? activeScenarios.map((l) => `<span class="prot-chip">${l}</span>`).join("")
      : `<div class="prot-empty">No playbook is fully deployed yet.</div>`;

    const rules = [];
    const fw = STATE.firewall;
    if (fw) {
      rules.push({
        ok: fw.active,
        label: fw.active ? `UFW firewall — default ${fw.policy_in || "?"} in / ${fw.policy_out || "?"} out` : "UFW is installed but not active",
        detail: fw.active ? `${fw.blocked_rules} deny rule(s)` : "",
      });
    }
    if (STATE.tools.fail2ban && STATE.tools.fail2ban !== "missing") {
      const on = STATE.tools.fail2ban === "active";
      const banned = STATE.threats.banned_ips || 0;
      rules.push({ ok: on, label: on ? "Fail2Ban jail running" : "Fail2Ban installed but not running", detail: on ? `${banned} IP(s) banned` : "" });
    }
    if (STATE.tools.suricata && STATE.tools.suricata !== "missing") {
      const on = STATE.tools.suricata === "active";
      const alerts = STATE.threats.suricata_alerts || 0;
      rules.push({ ok: on, label: on ? "Suricata IDS watching traffic" : "Suricata installed but not running", detail: on ? `${alerts} alert(s)` : "" });
    }
    if (STATE.tools.usbguard && STATE.tools.usbguard !== "missing") {
      const on = STATE.tools.usbguard === "active";
      rules.push({ ok: on, label: on ? "USBGuard policy enforced" : "USBGuard installed but not running", detail: "" });
    }
    if (STATE.tools.opensnitch && STATE.tools.opensnitch !== "missing") {
      const on = STATE.tools.opensnitch === "active";
      rules.push({ ok: on, label: on ? "OpenSnitch outbound firewall active" : "OpenSnitch installed but not running", detail: "" });
    }
    const rulesEl = document.getElementById("activeRulesList");
    rulesEl.innerHTML = rules.length
      ? rules.map((r) => `<div class="prot-rule"><span class="prot-rule-dot ${r.ok ? "good" : "warn"}"></span><span class="prot-rule-label">${r.label}</span>${r.detail ? `<span class="prot-rule-detail">${r.detail}</span>` : ""}</div>`).join("")
      : `<div class="prot-empty">Install UFW, Fail2Ban, Suricata, USBGuard, or OpenSnitch to see rule status here.</div>`;
  }

  // ---------------- Status polling ----------------
  async function refreshStatus() {
    STATE = await apiGet("/api/status");
    document.getElementById("sysinfo").textContent =
      `${STATE.system.hostname} · ${STATE.system.distro} · ${STATE.system.pkg_manager}`;
    setPanicUI(STATE.system.panic_active);
    renderOverview();
    renderAlerts();
    renderActiveStatus();
  }

  async function boot() {
    await refreshStatus();
    renderScenarios();
    renderInstall();
    renderActions();
    renderScans();
    refreshAutostart();
    wireConsoleInputs();
    startLogs();
    startMonitorStream();
    setInterval(async () => {
      if (installing) return;
      await refreshStatus();
      if (!document.getElementById("view-install").classList.contains("hidden")) renderInstall();
      if (!document.getElementById("view-scenarios").classList.contains("hidden")) renderScenarios();
      if (!document.getElementById("view-configure").classList.contains("hidden")) renderActions();
      if (!document.getElementById("view-scans").classList.contains("hidden")) renderScans();
    }, 6000);
  }

  boot();
})();
