import { isAuthorized, jsonResponse } from "../_auth.js";
import { getSession } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  if (!isAuthorized(request, env) && !(await getSession(env.DB, request))) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'vip_salon_data' LIMIT 1").first();
  let data = {};
  try { data = JSON.parse(row?.value || "{}"); } catch {}
  return new Response(JSON.stringify({ ok: true, vipArtworks: Array.isArray(data.vipArtworks) ? data.vipArtworks : [] }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" }
  });
}
