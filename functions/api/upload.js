import { isAuthorized, jsonResponse } from "./_auth.js";

export async function onRequestPost({ request, env }) {
  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || typeof file.arrayBuffer !== "function") {
      return jsonResponse({ ok: false, error: "No image file provided" }, 400);
    }

    const ext = (file.name && file.name.includes("."))
      ? file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "")
      : "jpg";
    const folder = (formData.get("folder") || "artworks").toString().replace(/[^a-zA-Z0-9_-]/g, "");
    const key = `${folder}/${Date.now()}-${crypto.randomUUID()}.${ext || "jpg"}`;
    const buffer = await file.arrayBuffer();

    await env.MEDIA_BUCKET.put(key, buffer, {
      httpMetadata: {
        contentType: file.type || "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable"
      }
    });

    const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
    const url = baseUrl ? `${baseUrl}/${key}` : `/api/media/${key}`;

    return jsonResponse({ ok: true, key, url });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message || "Upload failed" }, 500);
  }
}