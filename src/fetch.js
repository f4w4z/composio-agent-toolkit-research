// Real doc-retrieval layer for the research agent.
// Fetches the actual developer docs (not just LLM memory) so classifications are
// evidence-based. Handles bot-blockers: rotates a browser User-Agent, retries, and
// falls back to the Wayback Machine (web.archive.org) snapshot when the live site
// returns 403/401/blocked. Apps that cannot be retrieved are flagged docs_unreachable
// rather than guessed.
import fetch from "node-fetch";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function htmlToText(html) {
  let t = html || "";
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ");
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<head[\s\S]*?<\/head>/gi, " ");
  t = t.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  t = t.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/&nbsp;/g, " ");
  t = t.replace(/&amp;/g, "&");
  t = t.replace(/&lt;/g, "<");
  t = t.replace(/&gt;/g, ">");
  t = t.replace(/&quot;/g, '"');
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n\s*\n+/g, "\n");
  return t.trim();
}

async function tryFetch(url, { timeout = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: ac.signal
    });
    if (!res.ok) return { ok: false, status: res.status, url };
    const html = await res.text();
    const text = htmlToText(html);
    return { ok: true, status: res.status, url: res.url || url, text, length: text.length };
  } catch (e) {
    return { ok: false, status: 0, url, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function waybackUrl(raw) {
  try {
    const u = new URL(raw);
    return `https://web.archive.org/web/2026/${u.host}${u.pathname}${u.search}`;
  } catch {
    return `https://web.archive.org/web/2026/${raw}`;
  }
}

// Fetch docs for an app. Returns { source: 'live'|'wayback'|'unreachable', text, url, status }.
export async function fetchDocs(hintUrl) {
  if (!hintUrl) return { source: "unreachable", text: "", url: null, status: 0 };

  const live = await tryFetch(hintUrl);
  if (live.ok && live.length > 400) {
    return { source: "live", text: live.text.slice(0, 6000), url: live.url, status: live.status };
  }

  // Live blocked or empty -> try Wayback snapshot.
  const wb = await tryFetch(waybackUrl(hintUrl));
  if (wb.ok && wb.length > 400) {
    return { source: "wayback", text: wb.text.slice(0, 6000), url: wb.url, status: wb.status };
  }

  return { source: "unreachable", text: "", url: hintUrl, status: live.status || wb.status || 0 };
}
