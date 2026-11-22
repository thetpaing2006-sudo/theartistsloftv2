import { jsonResponse } from "../_auth.js";
import { getSession, isSameOrigin, isValidEmail, randomHex, sha256, sendResendEmail, recordRateLimit } from "./_helpers.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) return jsonResponse({ ok: false, error: "Newsletter confirmation is temporarily unavailable." }, 503);
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!/^[a-f0-9]{64}$/i.test(token)) return jsonResponse({ ok: false, error: "This confirmation link is invalid or expired." }, 400);
  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256(token);
  const record = await env.DB.prepare(`SELECT t.member_email, m.name, m.suspended, m.revoked
    FROM salon_newsletter_tokens t JOIN salon_members m ON m.email = t.member_email
    WHERE t.token_hash = ?1 AND t.used_at IS NULL AND t.expires_at > ?2 LIMIT 1`).bind(tokenHash, now).first();
  if (!record || record.suspended || record.revoked || !isValidEmail(record.member_email)) {
    return jsonResponse({ ok: false, error: "This confirmation link is invalid or expired." }, 400);
  }
  const nameParts = String(record.name || "Collector").trim().split(/\s+/);
  const payload = {
    email: record.member_email,
    first_name: nameParts.shift() || "Collector",
    last_name: nameParts.join(" ") || undefined,
    unsubscribed: false,
    segments: [{ id: env.RESEND_SEGMENT_ID }]
  };
  let response = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  let result = await response.json().catch(() => ({}));
  if (!response.ok && (response.status === 409 || /already exists|already been taken|duplicate/i.test(String(result.message || result.name || "")))) {
    const byEmail = encodeURIComponent(record.member_email);
    const lookup = await fetch(`https://api.resend.com/contacts/${byEmail}`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` }
    });
    const contact = await lookup.json().catch(() => ({}));
    if (!lookup.ok) {
      return jsonResponse({ ok: false, error: `Resend lookup (${lookup.status}): ${contact.message || contact.name || "Could not verify subscription."}` }, 502);
    }
    if (contact.unsubscribed) {
      response = await fetch(`https://api.resend.com/contacts/${byEmail}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ unsubscribed: false })
      });
      result = await response.json().catch(() => ({}));
    } else {
      response = new Response(JSON.stringify(contact), { status: 200, headers: { "Content-Type": "application/json" } });
      result = contact;
    }
  }
  if (!response.ok) {
    console.error("Resend newsletter confirmation failed", response.status, result.message || result.name || "unknown error");
    return jsonResponse({ ok: false, error: `Resend (${response.status}): ${result.message || result.name || "The email service could not confirm this subscription."}` }, 502);
  }
  const update = await env.DB.prepare("UPDATE salon_newsletter_tokens SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1")
    .bind(now, tokenHash).run();
  if (!update.meta?.changes) return jsonResponse({ ok: false, error: "This confirmation link has already been used." }, 409);
  await env.DB.prepare("UPDATE salon_members SET newsletter_opt_in = 1, newsletter_updated_at = ?1 WHERE email = ?2")
    .bind(new Date().toISOString(), record.member_email).run();
  await env.DB.prepare("INSERT INTO salon_member_logs (id, member_email, member_name, action, details, device, timestamp) VALUES (?1, ?2, ?3, 'Newsletter Opt-In Confirmed', 'Confirmed by email link', 'Email', ?4)")
    .bind(randomHex(16), record.member_email, record.name || "Collector", new Date().toISOString()).run();
  return jsonResponse({ ok: true, message: "Your newsletter subscription is confirmed." });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return jsonResponse({ ok: false, error: "Database unavailable" }, 503);
  if (!isSameOrigin(request)) return jsonResponse({ ok: false, error: "Invalid request origin" }, 403);
  if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) return jsonResponse({ ok: false, error: "Newsletter confirmation is not configured." }, 503);
  const member = await getSession(env.DB, request);
  if (!member) return jsonResponse({ ok: false, error: "Sign in to manage newsletter preferences." }, 401);
  if (!(await recordRateLimit(env.DB, request, "newsletter_confirm_request", 3, 86400, member.email))) {
    return jsonResponse({ ok: false, error: "Please wait before requesting another confirmation email." }, 429);
  }
  const rawToken = randomHex(32);
  const tokenHash = await sha256(rawToken);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("UPDATE salon_newsletter_tokens SET used_at = ?1 WHERE member_email = ?2 AND used_at IS NULL").bind(now, member.email).run();
  await env.DB.prepare("INSERT INTO salon_newsletter_tokens (token_hash, member_email, expires_at, used_at, created_at) VALUES (?1, ?2, ?3, NULL, ?4)")
    .bind(tokenHash, member.email, now + 86400, now).run();
  const base = String(env.PUBLIC_SITE_URL || new URL(request.url).origin).replace(/\/+$/, "");
  const confirmUrl = `${base}/?newsletter-confirm=${encodeURIComponent(rawToken)}`;
  try {
    await sendResendEmail(env, {
      to: member.email,
      subject: "Confirm your Collector Newsletter subscription",
      html: `<p>Hello ${String(member.name || "Collector").replace(/[&<>"']/g, "")},</p><p>Please confirm that you want to receive occasional Collector Newsletter emails from The Artist's Loft.</p><p><a href="${confirmUrl}" style="display:inline-block;padding:12px 24px;background:#d4af37;color:#111;text-decoration:none;border-radius:6px;font-weight:bold;">Confirm Newsletter Subscription</a></p><p>Or copy and paste this link into your browser:<br><a href="${confirmUrl}">${confirmUrl}</a></p><p>This link expires in 24 hours. If you did not request this, ignore this email.</p>`,
      text: `Hello ${String(member.name || "Collector")},\n\nPlease confirm your Collector Newsletter subscription by opening the link below:\n\n${confirmUrl}\n\nThis link expires in 24 hours. If you did not request this, ignore this email.`
    });
  } catch (error) {
    console.error("Salon newsletter confirmation delivery failed", error.message);
    await env.DB.prepare("UPDATE salon_newsletter_tokens SET used_at = ?1 WHERE token_hash = ?2").bind(now, tokenHash).run();
    return jsonResponse({ ok: false, error: "The confirmation email could not be sent. Please try again later." }, 502);
  }
  return jsonResponse({ ok: true, message: "Please check your email and click the confirmation link to activate newsletter updates." });
}
