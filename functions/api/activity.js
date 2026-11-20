import { isAuthorized, jsonResponse } from "./_auth.js";

function detectDevice(ua = "") {
  return /mobile|android|iphone|ipad|ipod/i.test(ua) ? "Mobile" : "Desktop";
}

function isBot(ua = "") {
  return /bot|crawler|spider|slurp|headless|lighthouse|pingdom/i.test(ua);
}

function getYearMonthUTC(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function buildReadableMonthlyEmail(logs, cutoffLabel) {
  const totalEvents = logs.length;
  const artCounts = {};
  const countryCounts = {};
  const deviceCounts = { Mobile: 0, Desktop: 0 };

  for (const row of logs) {
    if (row.event_type === "view_artwork" && row.item_name) {
      artCounts[row.item_name] = (artCounts[row.item_name] || 0) + 1;
    }
    const c = row.country || "XX";
    countryCounts[c] = (countryCounts[c] || 0) + 1;
    const d = row.device === "Mobile" ? "Mobile" : "Desktop";
    deviceCounts[d] = (deviceCounts[d] || 0) + 1;
  }

  const topArts = Object.entries(artCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count], i) => `${i + 1}. ${name} (${count} views)`)
    .join("\n") || "No artwork views recorded";

  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ") || "N/A";

  const csvHeader = "Timestamp (UTC),Event,Item,Country,Device";
  const csvRows = logs.map((r) =>
    [r.timestamp, r.event_type, r.item_name || "-", r.country || "XX", r.device || "Desktop"]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );

  return [
    `THE ARTIST'S LOFT — MONTHLY VISITOR ACTIVITY REPORT`,
    `Archive Period: Records older than ${cutoffLabel}`,
    `Total Archived Events: ${totalEvents}`,
    `Devices: Mobile (${deviceCounts.Mobile}) | Desktop (${deviceCounts.Desktop})`,
    `Countries: ${topCountries}`,
    ``,
    `--- TOP VIEWED ARTWORKS ---`,
    topArts,
    ``,
    `--- READABLE CSV LOG (Copy & save as visitor-report.csv for Excel) ---`,
    csvHeader,
    ...csvRows
  ].join("\n");
}

async function archiveAndPurgeOldLogs(env, forceNow = false) {
  if (!env.WEB3FORMS_ACCESS_KEY) {
    return { sent: false, reason: "Missing WEB3FORMS_ACCESS_KEY" };
  }

  const currentYM = getYearMonthUTC();

  if (!forceNow) {
    const setting = await env.DB.prepare(
      "SELECT value FROM site_settings WHERE key = 'last_monthly_report_ym'"
    ).first();
    if (setting && setting.value === currentYM) {
      return { sent: false, reason: "Already reported this month" };
    }
  }

  const query = forceNow
    ? "SELECT id, timestamp, event_type, item_name, country, device FROM visitor_logs ORDER BY timestamp ASC LIMIT 1000"
    : "SELECT id, timestamp, event_type, item_name, country, device FROM visitor_logs WHERE timestamp < datetime('now', '-30 days') ORDER BY timestamp ASC LIMIT 1000";

  const oldLogsRes = await env.DB.prepare(query).all();
  const logs = oldLogsRes.results || [];

  await env.DB.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES ('last_monthly_report_ym', ?1, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).bind(currentYM).run();

  if (logs.length === 0) {
    return { sent: false, count: 0, reason: "No expired logs to archive" };
  }

  const cutoffLabel = new Date().toISOString().slice(0, 10);
  const reportText = buildReadableMonthlyEmail(logs, cutoffLabel);

  const emailRes = await fetch("https://api.web3forms.com/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      access_key: env.WEB3FORMS_ACCESS_KEY,
      subject: `The Artist's Loft — Monthly Visitor Report (${cutoffLabel})`,
      from_name: "The Artist's Loft Analytics",
      message: reportText
    })
  });

  const emailData = await emailRes.json().catch(() => ({}));
  if (!emailRes.ok || !emailData.success) {
    await env.DB.prepare("DELETE FROM site_settings WHERE key = 'last_monthly_report_ym'").run();
    throw new Error(emailData.message || "Email delivery failed; logs preserved in D1");
  }

  const lastTimestamp = logs[logs.length - 1].timestamp;
  await env.DB.prepare(
    "DELETE FROM visitor_logs WHERE timestamp <= ?1"
  ).bind(lastTimestamp).run();

  return { sent: true, count: logs.length };
}

export async function onRequestPost({ request, env }) {
  try {
    const ua = request.headers.get("User-Agent") || "";
    if (isBot(ua)) {
      return jsonResponse({ ok: true, skipped: "bot" });
    }

    const body = await request.json().catch(() => ({}));

    if (body.action === "archive_now") {
      if (!isAuthorized(request, env)) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      }
      const result = await archiveAndPurgeOldLogs(env, true);
      return jsonResponse({ ok: true, ...result });
    }

    const eventType = String(body.event_type || "visit").slice(0, 40);
    const itemName = String(body.item_name || "").slice(0, 140);
    const country = String(request.cf?.country || "XX").slice(0, 8);
    const device = detectDevice(ua);
    const id = `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await env.DB.prepare(`
      INSERT INTO visitor_logs (id, timestamp, event_type, item_name, country, device)
      VALUES (?1, datetime('now'), ?2, ?3, ?4, ?5)
    `).bind(id, eventType, itemName, country, device).run();

    await archiveAndPurgeOldLogs(env, false).catch(() => {});

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || "Activity log error" }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    await archiveAndPurgeOldLogs(env, false).catch(() => {});

    const [recentRes, topArtRes, countryRes] = await Promise.all([
      env.DB.prepare(`
        SELECT id, timestamp, event_type, item_name, country, device
        FROM visitor_logs
        ORDER BY timestamp DESC
        LIMIT 100
      `).all(),
      env.DB.prepare(`
        SELECT item_name, COUNT(*) as views
        FROM visitor_logs
        WHERE event_type = 'view_artwork' AND item_name != ''
        GROUP BY item_name
        ORDER BY views DESC
        LIMIT 5
      `).all(),
      env.DB.prepare(`
        SELECT country, COUNT(*) as count
        FROM visitor_logs
        GROUP BY country
        ORDER BY count DESC
        LIMIT 5
      `).all()
    ]);

    return jsonResponse({
      ok: true,
      logs: recentRes.results || [],
      topArtworks: topArtRes.results || [],
      topCountries: countryRes.results || []
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || "Failed to load visitor logs" }, 500);
  }
}