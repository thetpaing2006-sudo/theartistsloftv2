import { jsonResponse } from "../_auth.js";
import { getSession, deleteSession, clearSessionCookie, isSameOrigin, randomHex } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  const member = await getSession(env.DB, request);
  if (!member) {
    const response = jsonResponse({ ok: true, member: null });
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", clearSessionCookie(request));
    return new Response(response.body, { status: response.status, headers });
  }
  return jsonResponse({ ok: true, member: {
    email: member.email, name: member.name, loginCount: Number(member.login_count || 0),
    newsletterOptIn: Boolean(member.newsletter_opt_in)
  } });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  if (!isSameOrigin(request)) return jsonResponse({ ok: false, error: "Invalid request origin" }, 403);
  const member = await getSession(env.DB, request);
  if (!member) return jsonResponse({ ok: false, error: "Not signed in" }, 401);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }
  const allowedActions = new Set(["Signed Out", "Viewed VIP Work", "Requested Reserve"]);
  const action = String(body.action || "");
  if (!allowedActions.has(action)) return jsonResponse({ ok: false, error: "Unsupported activity" }, 400);
  const details = String(body.details || "").replace(/[\r\n]/g, " ").slice(0, 200);
  const device = String(body.device || "Browser").slice(0, 120);
  const timestamp = new Date().toISOString();
  await env.DB.prepare("INSERT INTO salon_member_logs (id, member_email, member_name, action, details, device, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(randomHex(16), member.email, member.name, action, details, device, timestamp).run();
  await env.DB.prepare("UPDATE salon_members SET last_active_at = ?1 WHERE email = ?2").bind(timestamp, member.email).run();
  return jsonResponse({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  if (!isSameOrigin(request)) return jsonResponse({ ok: false, error: "Invalid request origin" }, 403);
  await deleteSession(env.DB, request);
  const response = jsonResponse({ ok: true });
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", clearSessionCookie(request));
  return new Response(response.body, { status: response.status, headers });
}
