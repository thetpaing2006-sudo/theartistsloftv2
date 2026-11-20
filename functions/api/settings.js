import { isAuthorized, jsonResponse } from "./_auth.js";

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  const body = await request.json();
  const key = body.key;
  if (!key) return jsonResponse({ ok: false, error: "Missing setting key" }, 400);
  const serialized = typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? {});
  await env.DB.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (?1, ?2, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).bind(key, serialized).run();
  return jsonResponse({ ok: true, key });
}