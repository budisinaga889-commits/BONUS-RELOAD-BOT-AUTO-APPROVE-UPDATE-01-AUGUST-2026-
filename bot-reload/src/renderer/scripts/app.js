/* --------------------------------------------------------------------
 * Bonus Reload Bot — renderer app logic.
 * Presentation only. Every business decision lives in BotEngine.
 *
 * NOTE — Why this file is wrapped in an IIFE with an idempotent guard
 * --------------------------------------------------------------------
 * A previous bug report showed:
 *     Uncaught SyntaxError: Identifier 'bot' has already been declared
 *     (app.js:1:1)
 * even though the file declares `bot` only once and `index.html`
 * references it via a single <script> tag.
 *
 * That symptom means one of the following happened:
 *   (a) the script tag was evaluated twice inside the same document
 *       (Electron reload, DevTools "reload the loaded resources", a
 *       stray <script> injected by a devtools extension, etc), or
 *   (b) an older cached copy of the file was concatenated with the
 *       new one by the loader.
 *
 * Wrapping every declaration inside an IIFE moves them out of the
 * top-level lexical scope, so a second evaluation is either a
 * harmless no-op (guarded by `window.__botAppLoaded`) or, in the
 * pathological case, still cannot clash because there are no top-
 * level `const`/`let` identifiers at all.
 * ------------------------------------------------------------------ */
"use strict";
/* global window, document */

(function () {
  if (window.__botAppLoaded) {
    // eslint-disable-next-line no-console
    console.warn(
      "[renderer] app.js was evaluated more than once — subsequent " +
        "load ignored. If you see this, please report it."
    );
    return;
  }
  window.__botAppLoaded = true;

  // eslint-disable-next-line no-console
  console.info(
    "[renderer] app.js loaded — location:",
    window.location.href
  );

  const bot = window.bot;
  if (!bot) {
    // eslint-disable-next-line no-console
    console.error(
      "[renderer] window.bot is undefined. The preload script did " +
        "not run. Check main process logs for the resolved preload " +
        "and renderer paths."
    );
    document.body.innerHTML =
      '<div style="padding:20px;color:#f87171;font-family:monospace">' +
      "Renderer error: <b>window.bot is undefined</b>." +
      " The preload script did not attach. Check main-process logs." +
      "</div>";
    return;
  }

  const $ = (id) => document.getElementById(id);

  // ---- Tabs -----------------------------------------------------------

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  }
  function activateTab(name) {
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("active", t.dataset.tab === name);
    }
    for (const view of document.querySelectorAll(".view")) {
      view.hidden = view.dataset.view !== name;
    }
    if (name === "history") refreshHistory();
    if (name === "skipped") refreshSkipped();
  }

  // ---- Status pills ---------------------------------------------------

  function renderStatus(s) {
    const b = $("pill-browser");
    const l = $("pill-login");
    const r = $("pill-running");
    b.textContent = s.browserOpen ? "Browser: open" : "Browser: closed";
    b.className   = "pill " + (s.browserOpen ? "ok" : "danger");
    l.textContent = s.loggedIn ? "Login: yes" : "Login: no";
    l.className   = "pill " + (s.loggedIn ? "ok" : "warn");
    r.textContent = s.running ? "Bot: running" : "Bot: idle";
    r.className   = "pill " + (s.running ? "ok" : "");
    $("btn-start").disabled = s.running;
    $("btn-stop").disabled  = !s.running;
    const banner = $("integrity-banner");
    if (s.integrityIssue) {
      $("integrity-message").textContent = s.integrityIssue;
      banner.hidden = false;
    } else banner.hidden = true;
  }

  function renderStats(s) {
    $("stat-approved").textContent = s.verified ?? 0;
    $("stat-rejected").textContent = s.rejected ?? 0;
    $("stat-skipped").textContent  = s.skipped ?? 0;
    $("stat-failed").textContent   = s.failed ?? 0;
    $("stat-skippedQ").textContent = s.skippedQueueSize ?? 0;
    const badge = $("skipped-badge");
    const q     = s.skippedQueueSize ?? 0;
    if (q > 0) { badge.hidden = false; badge.textContent = q; }
    else       { badge.hidden = true; }
  }

  // ---- Bug #5 — Runtime metrics -------------------------------------

  function fmtMs(v)  { return Number.isFinite(v) ? v + " ms" : "— ms"; }
  function fmtSec(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "0s";
    const s = Math.floor(ms / 1000);
    if (s < 60)   return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60)   return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }
  function fmtMb(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "— MB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  function fmtTs(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
  }
  function renderMetrics(m) {
    if (!m) return;
    $("metric-pending").textContent      = m.pendingCount ?? 0;
    $("metric-retry").textContent        = m.retryCount ?? 0;
    $("metric-cycles").textContent       = m.cyclesCompleted ?? 0;
    $("metric-poll-last").textContent    = fmtMs(m.lastPollDurationMs);
    $("metric-poll-avg").textContent     = fmtMs(m.avgPollDurationMs);
    $("metric-verify-avg").textContent   = fmtMs(m.avgVerificationMs);
    $("metric-last-refresh").textContent = fmtTs(m.lastRefreshAt);
    $("metric-uptime").textContent       = fmtSec(m.browserUptimeMs);
    $("metric-queue").textContent        = m.queueSize ?? 0;
    $("metric-memory").textContent       = fmtMb(m.memoryRssBytes);
  }

  // ---- Live log -------------------------------------------------------

  const LOG_LIMIT = 500;
  function appendLog(entry) {
    const box = $("live-log");
    const line = document.createElement("div");
    line.className = "log-line log-" + entry.status;
    const dur = entry.processDurationMs != null ? ` (${entry.processDurationMs}ms)` : "";
    const notes = entry.notes ? ` — ${entry.notes}` : "";
    const amt = entry.amount ? ` Rp${entry.amount.toLocaleString("id-ID")}` : "";
    line.textContent = `[${entry.ts}] ${entry.status.padEnd(9)} ${entry.username || "-"}${amt} ${entry.detail || ""}${notes}${dur}`;
    box.appendChild(line);
    while (box.childElementCount > LOG_LIMIT) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  $("btn-clear-log").addEventListener("click", () => { $("live-log").innerHTML = ""; });

  // ---- Queue preview (last cycle report) ------------------------------

  function renderCycle(r) {
    const box = $("queue-preview");
    if (!r) { box.innerHTML = `<div class="empty">Queue is empty.</div>`; return; }
    box.innerHTML = `
      <div class="row" style="gap:16px;margin:0 0 6px 0">
        <span class="hint">Cycle #${r.cycleId}</span>
        <span class="hint">Visible: <b>${r.visible}</b></span>
        <span class="hint">Submitted approve: <b>${r.submittedApprove}</b></span>
        <span class="hint">Submitted reject: <b>${r.submittedReject}</b></span>
        <span class="hint">Verified approve: <b style="color:var(--ok)">${r.verifiedApprove}</b></span>
        <span class="hint">Verified reject: <b style="color:var(--warn)">${r.verifiedReject}</b></span>
        <span class="hint">Retry next: <b style="color:var(--violet)">${r.retriedNext}</b></span>
        <span class="hint">Duration: <b>${r.durationMs}ms</b></span>
      </div>`;
  }

  // ---- Skipped Transactions -------------------------------------------

  async function refreshSkipped() {
    const rows = await bot.getSkipped();
    renderSkipped(rows);
  }
  function renderSkipped(rows) {
    const tbody = $("skipped-tbody");
    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No transactions currently skipped.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr data-testid="skipped-row-${r.key}">
        <td>${new Date(r.addedAt).toLocaleTimeString()}</td>
        <td>${escapeHtml(r.username)}</td>
        <td class="amount">Rp${r.amount.toLocaleString("id-ID")}</td>
        <td>${escapeHtml(r.notes)}</td>
        <td>${escapeHtml(r.reason)}</td>
        <td>
          <button class="btn btn-mini btn-danger"
                  data-testid="skipped-reject-${r.key}"
                  data-key="${escapeAttr(r.key)}"
                  ${r.rejecting ? "disabled" : ""}>
            ${r.rejecting ? "Rejecting…" : "Reject"}
          </button>
        </td>
      </tr>`).join("");
    for (const btn of tbody.querySelectorAll("button[data-key]")) {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.key;
        btn.disabled = true;
        await bot.rejectSkipped(key);
      });
    }
  }

  // ---- History (Bug #6 — search / filter / sort / pagination) --------

  const historyState = {
    rows: [],
    filter: { search: "", status: "" },
    sort: { key: "pid", dir: "desc" },
    page: 1,
    pageSize: 50
  };

  async function refreshHistory() {
    // Ask the DB for a generous window; filtering / sorting / paging is
    // handled client-side so operators can search without a round-trip.
    historyState.rows = await bot.getHistory(5000, 0);
    historyState.page = 1;
    renderHistory();
  }

  function historyView() {
    const q = historyState.filter.search.trim().toLowerCase();
    const status = historyState.filter.status;
    let rows = historyState.rows;
    if (status) rows = rows.filter((r) => r.status === status);
    if (q) {
      rows = rows.filter((r) => {
        const hay = (
          (r.player || "") + " " +
          (r.bonusReload || "") + " " +
          (r.reason || "") + " " +
          (r.status || "") + " " +
          (r.verificationResult || "")
        ).toLowerCase();
        return hay.includes(q);
      });
    }
    const { key, dir } = historyState.sort;
    if (key) {
      rows = rows.slice().sort((a, b) => {
        const va = a[key], vb = b[key];
        const cmp =
          typeof va === "number" && typeof vb === "number"
            ? va - vb
            : String(va ?? "").localeCompare(String(vb ?? ""));
        return dir === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  }

  function renderHistory() {
    const tbody = $("history-tbody");
    const rows = historyView();
    const total = rows.length;
    const pageSize = historyState.pageSize;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (historyState.page > pages) historyState.page = pages;
    const start = (historyState.page - 1) * pageSize;
    const view = rows.slice(start, start + pageSize);

    if (view.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No history matching filters.</td></tr>`;
    } else {
      tbody.innerHTML = view.map((r) => `
        <tr data-testid="history-row-${r.pid}">
          <td>${r.pid}</td>
          <td>${new Date(r.time).toLocaleString()}</td>
          <td>${escapeHtml(r.player)}</td>
          <td class="amount">Rp${r.amount.toLocaleString("id-ID")}</td>
          <td>${escapeHtml(r.bonusReload)}</td>
          <td class="status-${r.status}">${r.status}</td>
          <td>${escapeHtml(r.reason || "")}</td>
          <td class="amount">${r.processDurationMs != null ? r.processDurationMs + " ms" : "—"}</td>
          <td>${r.verificationResult}</td>
        </tr>`).join("");
    }

    $("hist-page-info").textContent = `${historyState.page} / ${pages}`;
    $("hist-count-hint").textContent = `${total} row${total === 1 ? "" : "s"}${historyState.rows.length !== total ? ` (filtered from ${historyState.rows.length})` : ""}`;
    $("hist-prev").disabled = historyState.page <= 1;
    $("hist-next").disabled = historyState.page >= pages;

    // Sort indicators
    document.querySelectorAll("th[data-sort]").forEach((th) => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === historyState.sort.key) {
        th.classList.add(historyState.sort.dir === "asc" ? "sort-asc" : "sort-desc");
      }
    });
  }

  $("btn-refresh-history").addEventListener("click", refreshHistory);
  $("btn-export-history").addEventListener("click", async () => {
    const res = await bot.exportHistory();
    const box = $("db-result");
    const msg = res.ok
      ? `Exported: ${res.path}`
      : `Export cancelled or failed: ${res.message}`;
    box.textContent = msg;
  });
  $("hist-search").addEventListener("input", (e) => {
    historyState.filter.search = e.target.value || "";
    historyState.page = 1;
    renderHistory();
  });
  $("hist-status").addEventListener("change", (e) => {
    historyState.filter.status = e.target.value || "";
    historyState.page = 1;
    renderHistory();
  });
  $("hist-page-size").addEventListener("change", (e) => {
    historyState.pageSize = parseInt(e.target.value, 10) || 50;
    historyState.page = 1;
    renderHistory();
  });
  $("hist-prev").addEventListener("click", () => {
    if (historyState.page > 1) { historyState.page--; renderHistory(); }
  });
  $("hist-next").addEventListener("click", () => {
    historyState.page++;
    renderHistory();
  });
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (historyState.sort.key === key) {
        historyState.sort.dir = historyState.sort.dir === "asc" ? "desc" : "asc";
      } else {
        historyState.sort.key = key;
        historyState.sort.dir = "asc";
      }
      renderHistory();
    });
  });

  // ---- DB Viewer ------------------------------------------------------

  $("btn-integrity").addEventListener("click", async () => {
    const r = await bot.integrityCheck();
    $("db-result").textContent = `Integrity: ${r.ok ? "OK" : "FAILED"} — ${r.message}`;
  });
  $("btn-cleanup").addEventListener("click", async () => {
    const r = await bot.cleanup();
    $("db-result").textContent = `Cleanup complete — removed ${r.removed} old rows.`;
  });
  $("btn-prune-logs").addEventListener("click", async () => {
    const r = await bot.pruneLogs();
    $("db-result").textContent = `Log prune complete — removed ${r.removed} old log files.`;
  });

  // ---- Settings -------------------------------------------------------

  async function loadSettings() {
    const c = await bot.getConfig();
    $("cfg-startURL").value    = c.startURL || "";
    $("cfg-refresh").value     = c.refreshInterval || 3000;
    $("cfg-dailyAction").value = c.dailyLimitAction || "skip";
    $("cfg-cooldown").value    = c.bonus5000CooldownMinutes ?? 10;
    $("cfg-retention").value   = c.cleanupRetentionDays ?? 90;
    $("cfg-logRetention").value = c.logRetentionDays ?? 30;
    $("cfg-exportPath").value  = c.historyExportPath || "";
    $("cfg-debug").value       = c.debugLogLevel || "info";
    renderPollInterval(c.refreshInterval);
  }
  function renderPollInterval(v) {
    const el = $("poll-interval");
    if (!el) return;
    el.textContent = String(Number.isFinite(v) ? v : "—");
  }
  $("btn-save-config").addEventListener("click", async () => {
    let refresh = parseInt($("cfg-refresh").value, 10);
    if (!Number.isFinite(refresh)) refresh = 3000;
    // Client-side clamp — mirrors backend enforcement (1000–10000 ms).
    refresh = Math.min(10_000, Math.max(1_000, refresh));
    $("cfg-refresh").value = refresh;
    const cfg = {
      startURL:                 $("cfg-startURL").value.trim(),
      refreshInterval:          refresh,
      minDelay:                 800,
      maxDelay:                 2000,
      dailyLimitAction:         $("cfg-dailyAction").value,
      bonus5000CooldownMinutes: parseInt($("cfg-cooldown").value, 10) || 0,
      cleanupRetentionDays:     parseInt($("cfg-retention").value, 10) || 90,
      logRetentionDays:         Math.max(0, parseInt($("cfg-logRetention").value, 10) || 0),
      historyExportPath:        $("cfg-exportPath").value.trim(),
      debugLogLevel:            $("cfg-debug").value
    };
    const saved = await bot.setConfig(cfg);
    // Server returns the normalised config — reflect any clamping the
    // renderer might have missed.
    $("cfg-refresh").value = saved.refreshInterval;
    $("cfg-logRetention").value = saved.logRetentionDays ?? 30;
    renderPollInterval(saved.refreshInterval);
    const n = $("cfg-saved");
    n.textContent = "Configuration saved.";
    setTimeout(() => (n.textContent = ""), 2000);
  });

  // ---- Control buttons ------------------------------------------------

  $("btn-open-panel").addEventListener("click", () => bot.openPanel());
  $("btn-start").addEventListener("click", () => bot.start());
  $("btn-stop").addEventListener("click", () => bot.stop());
  $("btn-run-once").addEventListener("click", () => bot.runCycleOnce());

  // ---- IPC wiring -----------------------------------------------------

  bot.onLog(appendLog);
  bot.onStats(renderStats);
  bot.onStatus(renderStatus);
  bot.onSkipped(renderSkipped);
  bot.onCycle(renderCycle);
  bot.onMetrics(renderMetrics);

  // ---- Bootstrap ------------------------------------------------------

  (async () => {
    const [status, stats, skipped, metrics] = await Promise.all([
      bot.getStatus(), bot.getStats(), bot.getSkipped(), bot.getMetrics()
    ]);
    renderStatus(status);
    renderStats(stats);
    renderSkipped(skipped);
    if (metrics) renderMetrics(metrics);
    loadSettings();
  })();

  // ---- Utils ----------------------------------------------------------

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replaceAll("'", "&#39;");
  }
})();
