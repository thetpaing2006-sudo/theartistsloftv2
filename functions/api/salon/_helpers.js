import { jsonResponse } from "../_auth.js";

export { jsonResponse };

export const SESSION_COOKIE = "tal_salon_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const RESET_TTL_SECONDS = 60 * 30;
const encoder = new TextEncoder();

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) && email.length <= 160;
}

export function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export function randomHex(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function passwordHash(passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  const saltHex = Array.from(salt, b => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2-sha256$100000$${saltHex}$${hashHex}`;
}

export async function verifyPassword(stored, passcode, email) {
  if (!stored) return false;
  if (stored.startsWith("pbkdf2-sha256$")) {
    const [, iterationsText, saltHex, expected] = stored.split("$");
    const iterations = Number(iterationsText);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000 || !saltHex || !expected) return false;
    const salt = Uint8Array.from(saltHex.match(/.{2}/g) || [], x => parseInt(x, 16));
    const key = await crypto.subtle.importKey("raw", encoder.encode(passcode), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    const actual = Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
    return constantTimeEqual(actual, expected);
  }
  // Compatibility for accounts imported from the old browser-only Salon. Upgrade to PBKDF2 on success.
  const legacy = `tal-salon-v1:${email}:${passcode}`;
  const oldDigest = await sha256(legacy);
  if (constantTimeEqual(oldDigest, stored)) return true;
  if (stored.startsWith("fnv-")) {
    let h = 2166136261;
    for (let i = 0; i < legacy.length; i++) { h ^= legacy.charCodeAt(i); h = Math.imul(h, 16777619); }
    return constantTimeEqual(`fnv-${(h >>> 0).toString(16)}`, stored);
  }
  return false;
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function sessionCookie(request, token, maxAge = SESSION_TTL_SECONDS) {
  const secure = new URL(request.url).protocol === "https:";
  const sameSite = secure ? "None" : "Lax";
  return `${SESSION_COOKIE}=${token}; Path=/api/salon; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(request) {
  return sessionCookie(request, "", 0);
}

export function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

export async function createSession(db, email) {
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO salon_sessions (token_hash, member_email, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256(token), email, now + SESSION_TTL_SECONDS, now).run();
  return token;
}

export async function getSession(db, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(`SELECT m.email, m.name, m.login_count, m.newsletter_opt_in, m.suspended, m.revoked
    FROM salon_sessions s JOIN salon_members m ON m.email = s.member_email
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 LIMIT 1`).bind(await sha256(token), now).first();
  if (!row || row.suspended || row.revoked) return null;
  return row;
}

export async function deleteSession(db, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await db.prepare("DELETE FROM salon_sessions WHERE token_hash = ?1").bind(await sha256(token)).run();
}

export async function recordRateLimit(db, request, action, maxCount, windowSeconds, identity = "") {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "unknown";
  const limiterHash = await sha256(`${action}:${identity}:${ip}`);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("DELETE FROM salon_rate_limits WHERE created_at < ?1").bind(now - windowSeconds).run();
  const count = await db.prepare("SELECT COUNT(*) AS n FROM salon_rate_limits WHERE limiter_hash = ?1 AND action = ?2 AND created_at > ?3")
    .bind(limiterHash, action, now - windowSeconds).first();
  if (Number(count?.n || 0) >= maxCount) return false;
  await db.prepare("INSERT INTO salon_rate_limits (id, limiter_hash, action, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(randomHex(16), limiterHash, action, now).run();
  return true;
}

export async function sendResendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM || "The Artist's Loft <concierge@theartistsloftmyanmar.com>", to: [to], subject, html, text })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || `Resend email failed (${response.status})`);
  return result;
}

export async function syncNewsletterOptIn(env, { email, name }) {
  if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) throw new Error("Newsletter delivery is not configured");
  const split = String(name || "Collector").trim().split(/\s+/);
  const payload = {
    email,
    first_name: split.shift() || "Collector",
    last_name: split.join(" ") || undefined,
    unsubscribed: false,
    segments: [{ id: env.RESEND_SEGMENT_ID }]
  };
  const response = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (response.ok) return result;
  // Existing contact may already be in the segment. Never clear a Resend unsubscribe/suppression.
  if (response.status === 409 || /already exists|already been taken|duplicate/i.test(String(result.message || result.name || ""))) return { existing: true };
  throw new Error(result.message || `Newsletter contact sync failed (${response.status})`);
}

export function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
