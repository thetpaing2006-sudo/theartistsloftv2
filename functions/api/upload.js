// functions/api/upload.js
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Verify Admin Token (matches index.html getAdminAuthHeaders)
    const headerToken =
      request.headers.get("x-admin-token") ||
      (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();

    if (!env.ADMIN_API_TOKEN || headerToken !== env.ADMIN_API_TOKEN) {
      return Response.json({ ok: false, error: "Unauthorized: Invalid ADMIN_API_TOKEN" }, { status: 401 });
    }

    // 2. Parse uploaded form data
    const formData = await request.formData();
    const file = formData.get("file");
    const folder = String(formData.get("folder") || "artworks").replace(/[^a-zA-Z0-9_-]/g, "") || "artworks";

    if (!file || typeof file.arrayBuffer !== "function") {
      return Response.json({ ok: false, error: "No valid image file provided." }, { status: 400 });
    }

    // 3. Check R2 Bucket binding
    const bucket = env.R2_BUCKET || env.MEDIA_BUCKET || env.BUCKET;
    if (!bucket) {
      return Response.json({ ok: false, error: "R2 bucket binding not configured in Pages Settings." }, { status: 500 });
    }

    // 4. Upload to R2
    const ext = file.name && file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "jpg";
    const safeExt = ext.replace(/[^a-z0-9]/g, "") || "jpg";
    const key = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;

    const buffer = await file.arrayBuffer();
    await bucket.put(key, buffer, {
      httpMetadata: {
        contentType: file.type || "image/jpeg",
      },
    });

    // 5. Return custom domain URL
    const baseUrl = String(env.R2_PUBLIC_URL || "https://media.theartistsloftmm.art").replace(/\/+$/, "");
    const url = `${baseUrl}/${key}`;

    return Response.json({ ok: true, url, key });
  } catch (err) {
    return Response.json({ ok: false, error: err.message || "Upload failed" }, { status: 500 });
  }
}
