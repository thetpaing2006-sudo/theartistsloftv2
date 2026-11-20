import { isAuthorized, jsonResponse } from "./_auth.js";

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  const body = await request.json();
  const id = body.id || `artist-${Date.now()}`;
  await env.DB.prepare(`
    INSERT INTO artists (id, name, bio, portrait_url, sort_order, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      bio = excluded.bio,
      portrait_url = excluded.portrait_url,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP
  `).bind(id, body.name || "", body.bio || "", body.portrait_url || "", Number(body.sort_order || 0)).run();
  return jsonResponse({ ok: true, id });
}

export async function onRequestDelete({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return jsonResponse({ ok: false, error: "Missing id" }, 400);
  await env.DB.prepare("DELETE FROM artists WHERE id = ?1").bind(id).run();
  return jsonResponse({ ok: true, id });
}