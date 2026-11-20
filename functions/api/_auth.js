export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export function isAuthorized(request, env) {
  if (!env.ADMIN_API_TOKEN) return false;
  const authHeader = request.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const customToken = (request.headers.get("x-admin-token") || "").trim();
  const provided = bearerToken || customToken;
  return provided.length > 0 && provided === env.ADMIN_API_TOKEN;
}