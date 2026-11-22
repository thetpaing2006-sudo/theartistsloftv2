import { isAuthorized, jsonResponse } from "./_auth.js";

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }
  const key = body.key;
  if (!key) return jsonResponse({ ok: false, error: "Missing setting key" }, 400);
  let value = body.value ?? {};
  if (key === "vip_salon_data") {
    const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return {}; } })() : value;
    value = { vipArtworks: Array.isArray(parsed?.vipArtworks) ? parsed.vipArtworks : [], updatedAt: parsed?.updatedAt || Date.now() };
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  await env.DB.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (?1, ?2, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(key, serialized).run();
  return jsonResponse({ ok: true, key });
}
