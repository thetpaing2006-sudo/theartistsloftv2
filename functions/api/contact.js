/**
 * Cloudflare Pages Function: /api/contact
 * Keeps WEB3FORMS_ACCESS_KEY completely hidden on the server side (never exposed in browser Inspect).
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  // Enforce same-origin / allowed origin check
  const origin = request.headers.get("Origin") || "";
  const host = request.headers.get("Host") || "";
  if (origin && host && !origin.includes(host)) {
    return new Response(JSON.stringify({ success: false, message: "Unauthorized origin." }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await request.json();

    // Honeypot spam trap check
    if (body.botcheck) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const name = String(body.name || "").trim().slice(0, 120);
    const email = String(body.email || "").trim().slice(0, 160);
    const message = String(body.message || "").trim().slice(0, 3000);

    if (!name || !email || !message) {
      return new Response(JSON.stringify({ success: false, message: "All fields are required." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const accessKey = env.WEB3FORMS_ACCESS_KEY;
    if (!accessKey) {
      return new Response(JSON.stringify({ success: false, message: "Server mail key not configured." }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const web3Res = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        access_key: accessKey,
        subject: `New Inquiry — The Artist's Loft (${name})`,
        from_name: "The Artist's Loft Gallery",
        name,
        email,
        message
      })
    });

    const data = await web3Res.json();
    return new Response(JSON.stringify({
      success: Boolean(data.success),
      message: data.success ? "Message sent." : (data.message || "Delivery failed.")
    }), {
      status: data.success ? 200 : 400,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, message: "Invalid request." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
}
