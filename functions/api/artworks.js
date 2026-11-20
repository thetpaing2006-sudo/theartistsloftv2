import { isAuthorized, jsonResponse } from "./_auth.js";

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  const body = await request.json();
  const id = body.id || `art-${Date.now()}`;
  await env.DB.prepare(`
    INSERT INTO artworks (
      id, title, artist_id, artist_name, category, medium,
      dimensions, year, price, status, image_url, description, sort_order, updated_at
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      artist_id = excluded.artist_id,
      artist_name = excluded.artist_name,
      category = excluded.category,
      medium = excluded.medium,
      dimensions = excluded.dimensions,
      year = excluded.year,
      price = excluded.price,
      status = excluded.status,
      image_url = excluded.image_url,
      description = excluded.description,
      sort_order = excluded.sort_order,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    id,
    body.title || "Untitled",
    body.artist_id || "",
    body.artist_name || "",
    body.category || "",
    body.medium || "",
    body.dimensions || "",
    body.year || "",
    body.price || "",
    body.status || "Available",
    body.image_url || "",
    body.description || "",
    Number(body.sort_order || 0)
  ).run();
  return jsonResponse({ ok: true, id });
}

export async function onRequestDelete({ request, env }) {
  if (!isAuthorized(request, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return jsonResponse({ ok: false, error: "Missing id" }, 400);
  await env.DB.prepare("DELETE FROM artworks WHERE id = ?1").bind(id).run();
  return jsonResponse({ ok: true, id });
}