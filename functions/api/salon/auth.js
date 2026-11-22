import { jsonResponse } from "../_auth.js";
import {
  createSession, isSameOrigin, normalizeEmail, isValidEmail, passwordHash,
  verifyPassword, randomHex, sha256, recordRateLimit, sendResendEmail,
  RESET_TTL_SECONDS, sessionCookie
} from "./_helpers.js";

const genericResetMessage = "If an account exists for that email, a secure reset link will arrive shortly.";

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 100);
}

function validCollectorName(name) {
  return name.length >= 2 && !/^(test|fake|asdf|aaa|bbb|123|user|guest)+$/i.test(name);
}

function responseWithCookie(request, data, token) {
  const response = jsonResponse(data);
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", sessionCookie(request, token));
  return new Response(response.body, { status: response.status, headers });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  if (!isSameOrigin(request)) return jsonResponse({ ok: false, error: "Invalid request origin" }, 403);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }
  const action = String(body.action || "");
  const email = normalizeEmail(body.email);
  if (body.website) return jsonResponse({ ok: false, error: "Request rejected" }, 400);

  if (action === "request_reset") {
    if (!isValidEmail(email)) return jsonResponse({ ok: true, message: genericResetMessage });
    const allowed = await recordRateLimit(env.DB, request, "reset", 4, 3600, email);
    const ipAllowed = await recordRateLimit(env.DB, request, "reset_ip", 20, 3600, "all");
    if (!allowed || !ipAllowed) return jsonResponse({ ok: true, message: genericResetMessage });
    const member = await env.DB.prepare("SELECT email, name, suspended, revoked FROM salon_members WHERE email = ?1 LIMIT 1").bind(email).first();
    if (member && !member.suspended && !member.revoked) {
      const rawToken = randomHex(32);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("UPDATE salon_reset_tokens SET used_at = ?1 WHERE member_email = ?2 AND used_at IS NULL")
        .bind(now, email).run();
      await env.DB.prepare("INSERT INTO salon_reset_tokens (token_hash, member_email, expires_at, used_at, created_at) VALUES (?1, ?2, ?3, NULL, ?4)")
        .bind(await sha256(rawToken), email, now + RESET_TTL_SECONDS, now).run();
      const base = String(env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/, "");
      const resetUrl = `${base}/?salon-reset=${encodeURIComponent(rawToken)}`;
      try {
        await sendResendEmail(env, {
          to: email,
          subject: "Reset your Private Salon passcode",
          html: `<p>Hello ${escapeHtml(member.name || "Collector")},</p><p>Use this one-time link to choose a new Private Salon passcode. It expires in 30 minutes.</p><p><a href="${resetUrl}">Reset my passcode</a></p><p>If you did not request this, you can ignore this email. Your existing passcode remains unchanged.</p>`,
          text: `Hello ${member.name || "Collector"},\n\nUse this one-time link to choose a new Private Salon passcode. It expires in 30 minutes:\n${resetUrl}\n\nIf you did not request this, ignore this email. Your existing passcode remains unchanged.`
        });
      } catch (error) {
        // Keep the outward response generic; do not reveal whether this email is registered.
        console.error("Salon reset email delivery failed", error.message);
        await env.DB.prepare("UPDATE salon_reset_tokens SET used_at = ?1 WHERE token_hash = ?2").bind(now, await sha256(rawToken)).run();
      }
    }
    return jsonResponse({ ok: true, message: genericResetMessage });
  }

  if (action === "confirm_reset") {
    const token = String(body.token || "");
    const passcode = String(body.passcode || "");
    if (!/^[a-f0-9]{64}$/i.test(token) || passcode.length < 6 || passcode.length > 64) {
      return jsonResponse({ ok: false, error: "The reset link is invalid or expired. Request a new link and try again." }, 400);
    }
    if (!(await recordRateLimit(env.DB, request, "reset_confirm", 10, 3600, await sha256(token)))) {
      return jsonResponse({ ok: false, error: "Too many attempts. Request a new reset link later." }, 429);
    }
    const now = Math.floor(Date.now() / 1000);
    const tokenHash = await sha256(token);
    const record = await env.DB.prepare("SELECT member_email FROM salon_reset_tokens WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2 LIMIT 1")
      .bind(tokenHash, now).first();
    if (!record) return jsonResponse({ ok: false, error: "The reset link is invalid or expired. Request a new link and try again." }, 400);
    const hashed = await passwordHash(passcode);
    const update = await env.DB.prepare(`UPDATE salon_reset_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1`)
      .bind(now, tokenHash).run();
    if (!update.meta?.changes) return jsonResponse({ ok: false, error: "The reset link is invalid or expired. Request a new link and try again." }, 400);
    await env.DB.prepare("UPDATE salon_members SET password_hash = ?1, hash_scheme = 'pbkdf2-sha256', legacy_pass_hash = NULL WHERE email = ?2")
      .bind(hashed, record.member_email).run();
    await env.DB.prepare("DELETE FROM salon_sessions WHERE member_email = ?1").bind(record.member_email).run();
    return jsonResponse({ ok: true, message: "Your passcode has been updated. You can now sign in." });
  }

  if (action !== "register" && action !== "login") return jsonResponse({ ok: false, error: "Unsupported action" }, 400);
  if (!isValidEmail(email)) return jsonResponse({ ok: false, error: "Please enter a valid email address." }, 400);
  const passcode = String(body.passcode || "");
  if (passcode.length < 6 || passcode.length > 64) return jsonResponse({ ok: false, error: "Passcode must be between 6 and 64 characters." }, 400);
  if (!(await recordRateLimit(env.DB, request, action, action === "login" ? 8 : 4, 900, email))) {
    return jsonResponse({ ok: false, error: "Too many attempts. Please wait before trying again." }, 429);
  }

  if (action === "register") {
    const name = cleanName(body.name);
    if (!validCollectorName(name)) return jsonResponse({ ok: false, error: "Please enter your real full name to register." }, 400);
    const existing = await env.DB.prepare("SELECT email FROM salon_members WHERE email = ?1 LIMIT 1").bind(email).first();
    if (existing) return jsonResponse({ ok: false, error: "This email is already registered. Switch to Member Login." }, 409);
    const optInRequested = body.newsletterOptIn === true;
    const hashed = await passwordHash(passcode);
    const nowIso = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO salon_members (email, name, password_hash, hash_scheme, login_count, registered_at, last_active_at, device, newsletter_opt_in)
      VALUES (?1, ?2, ?3, 'pbkdf2-sha256', 1, ?4, ?4, ?5, 0)`)
      .bind(email, name, hashed, nowIso, String(body.device || "Browser").slice(0, 120)).run();
    let newsletterConfirmationSent = false;
    if (optInRequested && env.RESEND_API_KEY && env.RESEND_SEGMENT_ID) {
      const newsletterToken = randomHex(32);
      const tokenHash = await sha256(newsletterToken);
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("INSERT INTO salon_newsletter_tokens (token_hash, member_email, expires_at, used_at, created_at) VALUES (?1, ?2, ?3, NULL, ?4)")
        .bind(tokenHash, email, now + 86400, now).run();
      const base = String(env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/, "");
      const confirmUrl = `${base}/?newsletter-confirm=${encodeURIComponent(newsletterToken)}`;
      try {
        await sendResendEmail(env, {
          to: email,
          subject: "Confirm your Collector Newsletter subscription",
          html: `<p>Hello ${escapeHtml(name)},</p><p>Please confirm that you want to receive occasional Collector Newsletter emails from The Artist's Loft.</p><p><a href="${confirmUrl}">Confirm newsletter subscription</a></p><p>This link expires in 24 hours. If you did not request this, ignore this email.</p>`,
          text: `Hello ${name},\n\nPlease confirm that you want to receive occasional Collector Newsletter emails from The Artist's Loft. This link expires in 24 hours:\n${confirmUrl}\n\nIf you did not request this, ignore this email.`
        });
        newsletterConfirmationSent = true;
      } catch (error) {
        console.error("Salon newsletter confirmation delivery failed", error.message);
        await env.DB.prepare("UPDATE salon_newsletter_tokens SET used_at = ?1 WHERE token_hash = ?2").bind(now, tokenHash).run();
      }
    }
    await env.DB.prepare("INSERT INTO salon_member_logs (id, member_email, member_name, action, details, device, timestamp) VALUES (?1, ?2, ?3, 'Registered', 'New Collector account', ?4, ?5)")
      .bind(randomHex(16), email, name, String(body.device || "Browser").slice(0, 120), nowIso).run();
    const sessionToken = await createSession(env.DB, email);
    return responseWithCookie(request, {
      ok: true,
      member: { email, name, loginCount: 1, registeredAt: nowIso, lastActiveAt: nowIso, newsletterOptIn: false },
      newsletterConfirmationSent,
      newsletterSetupMissing: optInRequested && (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID)
    }, sessionToken);
  }

  const member = await env.DB.prepare(`SELECT email, name, password_hash, hash_scheme, legacy_pass_hash, suspended, revoked,
    login_count, registered_at, last_active_at, newsletter_opt_in, device FROM salon_members WHERE email = ?1 LIMIT 1`).bind(email).first();
  if (!member || member.suspended || member.revoked) return jsonResponse({ ok: false, error: "No active collector membership found for this email and passcode." }, 401);
  const storedHash = member.password_hash || member.legacy_pass_hash;
  if (!(await verifyPassword(storedHash, passcode, email))) return jsonResponse({ ok: false, error: "Incorrect Collector Passcode. Use Forgot Passcode to request a reset link." }, 401);

  if (member.hash_scheme !== "pbkdf2-sha256" || !member.password_hash) {
    await env.DB.prepare("UPDATE salon_members SET password_hash = ?1, hash_scheme = 'pbkdf2-sha256', legacy_pass_hash = NULL WHERE email = ?2")
      .bind(await passwordHash(passcode), email).run();
  }
  const nowIso = new Date().toISOString();
  await env.DB.prepare("UPDATE salon_members SET login_count = login_count + 1, last_active_at = ?1 WHERE email = ?2").bind(nowIso, email).run();
  await env.DB.prepare("INSERT INTO salon_member_logs (id, member_email, member_name, action, details, device, timestamp) VALUES (?1, ?2, ?3, 'Signed In', 'Collector sign-in', ?4, ?5)")
    .bind(randomHex(16), email, member.name, String(body.device || "Browser").slice(0, 120), nowIso).run();
  const sessionToken = await createSession(env.DB, email);
  return responseWithCookie(request, {
    ok: true,
    member: { email, name: member.name, loginCount: Number(member.login_count || 0) + 1, registeredAt: member.registered_at, lastActiveAt: nowIso, newsletterOptIn: Boolean(member.newsletter_opt_in) }
  }, sessionToken);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
