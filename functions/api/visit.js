import { jsonResponse } from "./_auth.js";

export async function onRequestGet({ env }) {
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO visitor_stats (id, total_visits) VALUES ('main', 0)"
    ).run();
    const row = await env.DB.prepare(
      "SELECT total_visits, updated_at FROM visitor_stats WHERE id = 'main'"
    ).first();
    return jsonResponse({
      ok: true,
      total_visits: Number(row?.total_visits || 0),
      updated_at: row?.updated_at || null
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || "Failed to read visitor count" }, 500);
  }
}

export async function onRequestPost({ env }) {
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO visitor_stats (id, total_visits) VALUES ('main', 0)"
    ).run();
    const row = await env.DB.prepare(`
      UPDATE visitor_stats
      SET total_visits = total_visits + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = 'main'
      RETURNING total_visits, updated_at
    `).first();
    return jsonResponse({
      ok: true,
      total_visits: Number(row?.total_visits || 0),
      updated_at: row?.updated_at || null
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || "Failed to increment visitor count" }, 500);
  }
}