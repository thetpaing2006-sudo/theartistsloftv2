import { isAuthorized, jsonResponse } from "./_auth.js";

export async function onRequestGet({ request, env }) {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  try {
    const res = await env.DB.prepare(
      "SELECT id, timestamp, action, target_type, target_name, details FROM activity_logs ORDER BY timestamp DESC LIMIT 200"
    ).all();
    return jsonResponse({ ok: true, logs: res.results || [] });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || "Failed to load activity logs" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  try {
    const body = await request.json();
    const id = body.id || `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timestamp = body.timestamp || new Date().toISOString();
    const action = String(body.action || "Updated");
    const targetType = String(body.target_type || body.targetType || "System");
    const targetName = String(body.target_name || body.targetName || "");
    const details = String(body.details || "");

    await env.DB.prepare(`
      INSERT INTO activity_logs (id, timestamp, action, target_type, target_name, details)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).bind(id, timestamp, action, targetType, targetName, details).run();

    return jsonResponse({ ok: true, id });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || "Failed to save activity log" }, 500);
  }
}