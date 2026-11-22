export async function onRequestGet({ env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=30, s-maxage=60"
  };

  try {
    const [artistsRes, artworksRes, settingsRes] = await Promise.all([
      env.DB.prepare("SELECT * FROM artists ORDER BY sort_order ASC, name ASC").all(),
      env.DB.prepare("SELECT * FROM artworks ORDER BY sort_order ASC, created_at DESC").all(),
      env.DB.prepare("SELECT key, value FROM site_settings").all()
    ]);

    const settings = {};
    for (const row of (settingsRes.results || [])) {
      try {
        const value = JSON.parse(row.value);
        // This setting historically included passcode hashes, member records, and private artwork pricing.
        settings[row.key] = row.key === "vip_salon_data"
          ? { vipArtworks: [], updatedAt: value?.updatedAt || null }
          : value;
      } catch {
        settings[row.key] = row.key === "vip_salon_data" ? { vipArtworks: [] } : row.value;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      artists: artistsRes.results || [],
      artworks: artworksRes.results || [],
      settings
    }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err.message || "Failed to load gallery data"
    }), { status: 500, headers });
  }
}
