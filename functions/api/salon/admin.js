import { isAuthorized, jsonResponse } from "../_auth.js";
import { isSameOrigin, randomHex, escapeHtml } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  const [membersRes, logsRes, stats, migration] = await Promise.all([
    env.DB.prepare(`SELECT email, name, suspended, revoked, login_count AS loginCount,
      registered_at AS registeredAt, last_active_at AS lastActiveAt, device,
      newsletter_opt_in AS newsletterOptIn, newsletter_updated_at AS newsletterUpdatedAt
      FROM salon_members WHERE revoked = 0 ORDER BY registered_at DESC LIMIT 500`).all(),
    env.DB.prepare(`SELECT member_email AS memberEmail, member_name AS memberName, action, details, device, timestamp
      FROM salon_member_logs ORDER BY timestamp DESC LIMIT 200`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN newsletter_opt_in = 1 AND suspended = 0 AND revoked = 0 THEN 1 ELSE 0 END) AS opted_in
      FROM salon_members WHERE revoked = 0`).first(),
    env.DB.prepare("SELECT name FROM salon_migrations WHERE name = 'legacy_vip_salon_members_v1' LIMIT 1").first()
  ]);
  return jsonResponse({ ok: true, members: membersRes.results || [], memberLogs: logsRes.results || [], stats: {
    total: Number(stats?.total || 0), optedIn: Number(stats?.opted_in || 0)
  }, migrationDone: Boolean(migration) });
}

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  if (!isSameOrigin(request)) return jsonResponse({ ok: false, error: "Invalid request origin" }, 403);
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }
  const action = String(body.action || "");

  if (action === "migrate_legacy") return migrateLegacy(env.DB);
  if (action === "toggle_suspend" || action === "revoke") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse({ ok: false, error: "Invalid member email" }, 400);
    const member = await env.DB.prepare("SELECT name, suspended FROM salon_members WHERE email = ?1 AND revoked = 0 LIMIT 1").bind(email).first();
    if (!member) return jsonResponse({ ok: false, error: "Member not found" }, 404);
    const now = new Date().toISOString();
    if (action === "toggle_suspend") {
      const suspended = member.suspended ? 0 : 1;
      await env.DB.prepare("UPDATE salon_members SET suspended = ?1 WHERE email = ?2").bind(suspended, email).run();
      if (suspended) await env.DB.prepare("DELETE FROM salon_sessions WHERE member_email = ?1").bind(email).run();
      await addLog(env.DB, email, member.name, suspended ? "Suspended" : "Activated", "Private Salon access moderated", now);
      return jsonResponse({ ok: true, suspended: Boolean(suspended) });
    }
    await env.DB.prepare("UPDATE salon_members SET revoked = 1 WHERE email = ?1").bind(email).run();
    await env.DB.prepare("DELETE FROM salon_sessions WHERE member_email = ?1").bind(email).run();
    await addLog(env.DB, email, member.name, "Revoked Member", "Account access revoked by curator", now);
    return jsonResponse({ ok: true });
  }

  if (action === "send_newsletter") {
    if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) return jsonResponse({ ok: false, error: "Set RESEND_API_KEY and RESEND_SEGMENT_ID in Pages secrets before sending." }, 503);
    const subject = String(body.subject || "").trim();
    const text = String(body.text || "").trim();
    if (subject.length < 3 || subject.length > 160 || text.length < 10 || text.length > 20000) {
      return jsonResponse({ ok: false, error: "Provide a subject (3–160 characters) and message (10–20,000 characters)." }, 400);
    }
    const stats = await env.DB.prepare(`SELECT COUNT(*) AS n FROM salon_members
      WHERE newsletter_opt_in = 1 AND suspended = 0 AND revoked = 0`).first();
    const optedInCount = Number(stats?.n || 0);
    if (!optedInCount) return jsonResponse({ ok: false, error: "There are no active members with recorded newsletter opt-in." }, 409);
    const paragraphs = escapeHtml(text).split(/\n{2,}/).map(part => `<p>${part.replace(/\n/g, "<br>")}</p>`).join("");
    const html = `<div style="font-family:Georgia,serif;line-height:1.65;color:#26231f">${paragraphs}<hr><p style="font-size:12px;color:#6b6258">You are receiving this because you opted in to The Artist's Loft Collector Newsletter. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a>.</p></div>`;
    const response = await fetch("https://api.resend.com/broadcasts", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ segment_id: env.RESEND_SEGMENT_ID, from: env.RESEND_FROM || "The Artist's Loft <concierge@theartistsloftmyanmar.com>", subject, html, text, send: true })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Resend broadcast failed", response.status, result.message || result.name || "unknown error");
      return jsonResponse({ ok: false, error: result.message || `Resend rejected the broadcast (${response.status}).` }, 502);
    }
    await env.DB.prepare("INSERT INTO salon_campaign_logs (id, broadcast_id, subject, recipient_count, sent_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(randomHex(16), String(result.id || ""), subject, optedInCount, new Date().toISOString()).run();
    return jsonResponse({ ok: true, broadcastId: result.id || null, recipientCount: optedInCount });
  }

  return jsonResponse({ ok: false, error: "Unsupported action" }, 400);
}

async function addLog(db, email, name, action, details, timestamp) {
  await db.prepare("INSERT INTO salon_member_logs (id, member_email, member_name, action, details, device, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, 'Admin Console', ?6)")
    .bind(randomHex(16), email, name, action, details, timestamp).run();
}

async function migrateLegacy(db) {
  const already = await db.prepare("SELECT name FROM salon_migrations WHERE name = 'legacy_vip_salon_members_v1' LIMIT 1").first();
  if (already) return jsonResponse({ ok: true, alreadyMigrated: true, imported: 0, skipped: 0 });
  const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'vip_salon_data' LIMIT 1").first();
  let legacy = {};
  try { legacy = JSON.parse(row?.value || "{}"); } catch { return jsonResponse({ ok: false, error: "Legacy salon data could not be parsed; no changes made." }, 400); }
  const members = Array.isArray(legacy.members) ? legacy.members : [];
  const revoked = Array.isArray(legacy.revokedEmails) ? legacy.revokedEmails : [];
  const logs = Array.isArray(legacy.memberLogs) ? legacy.memberLogs : [];
  const nowIso = new Date().toISOString();
  let imported = 0;
  let skipped = 0;
  for (const item of members) {
    const email = String(item?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
    const legacyPassHash = String(item.passHash || "") || null;
    const passScheme = legacyPassHash?.startsWith("fnv-") ? "legacy-fnv" : "legacy-sha256";
    await db.prepare(`INSERT OR IGNORE INTO salon_members
      (email, name, password_hash, hash_scheme, legacy_pass_hash, suspended, revoked, login_count, registered_at, last_active_at, device, newsletter_opt_in)
      VALUES (?1, ?2, NULL, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, 0)`)
      .bind(email, String(item.name || "Collector").slice(0, 100), passScheme, legacyPassHash,
        item.suspended ? 1 : 0, Number(item.loginCount || 0), String(item.registeredAt || nowIso),
        String(item.lastActiveAt || item.registeredAt || nowIso), String(item.device || "Browser").slice(0, 120)).run();
    imported++;
  }
  for (const value of revoked) {
    const email = String(value || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    await db.prepare(`INSERT OR IGNORE INTO salon_members (email, name, password_hash, hash_scheme, suspended, revoked, login_count, registered_at, newsletter_opt_in)
      VALUES (?1, 'Revoked', NULL, 'none', 1, 1, 0, ?2, 0)`).bind(email, nowIso).run();
  }
  for (const log of logs.slice(0, 500)) {
    const email = String(log.memberEmail || "").trim().toLowerCase();
    const exists = email ? await db.prepare("SELECT email, name FROM salon_members WHERE email = ?1 LIMIT 1").bind(email).first() : null;
    if (!exists) continue;
    await db.prepare("INSERT OR IGNORE INTO salon_member_logs (id, member_email, member_name, action, details, device, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(String(log.id || randomHex(16)).slice(0, 100), email, exists.name, String(log.action || "Legacy activity").slice(0, 100), String(log.details || "").slice(0, 300), String(log.device || "Browser").slice(0, 120), String(log.timestamp || nowIso)).run();
  }
  const safeValue = JSON.stringify({ vipArtworks: Array.isArray(legacy.vipArtworks) ? legacy.vipArtworks : [], updatedAt: Date.now() });
  if (row) {
    await db.prepare("UPDATE site_settings SET value = ?1, updated_at = CURRENT_TIMESTAMP WHERE key = 'vip_salon_data'").bind(safeValue).run();
  } else {
    await db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES ('vip_salon_data', ?1, CURRENT_TIMESTAMP)").bind(safeValue).run();
  }
  await db.prepare("INSERT INTO salon_migrations (name, completed_at) VALUES ('legacy_vip_salon_members_v1', CURRENT_TIMESTAMP)").run();
  return jsonResponse({ ok: true, imported, skipped, newsletterOptInsImported: 0, message: "Legacy members were imported privately. Existing members were not opted into the newsletter without explicit consent." });
}
