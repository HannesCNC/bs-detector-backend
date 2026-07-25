/**
 * Public-source search wrapper. Neither Claude nor Google Sheets can search
 * the live web on their own - this module calls an actual search provider
 * and returns a short list of results for the AI step to reason over.
 *
 * Swap providers by changing SEARCH_PROVIDER in .env. Only SerpAPI is wired
 * up below; add others (Bing Web Search, etc.) following the same shape.
 */

export async function runPublicSearch({ name, company, town, website }) {
  const provider = process.env.SEARCH_PROVIDER || "serpapi";
  const queryParts = [name, company, town].filter(Boolean);
  const query = queryParts.join(" ");

  if (provider !== "serpapi") {
    throw new Error(`Unsupported SEARCH_PROVIDER: ${provider}`);
  }

  const generalResults = query.trim() ? await searchSerpApi(query) : [];

  // If a website/social link was submitted, fetch that EXACT page directly
  // rather than searching for the name within the domain - a name-scoped
  // search only surfaces loosely-related name matches, not the actual
  // claimed profile. A direct fetch tells us what is honestly, publicly
  // visible at that specific link (or that it's login-walled/unreachable).
  const submittedLink = website ? await fetchSubmittedLink(website) : null;

  // Dedupe general results by link, cap so the AI step isn't overwhelmed
  const seen = new Set();
  const deduped = generalResults.filter((r) => {
    if (!r.link || seen.has(r.link)) return false;
    seen.add(r.link);
    return true;
  });

  return { generalResults: deduped.slice(0, 10), submittedLink };
}

async function fetchSubmittedLink(website) {
  let url;
  try {
    url = new URL(website.startsWith("http") ? website : `https://${website}`);
  } catch {
    return { url: website, reachable: false, note: "Submitted link is not a valid URL." };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BSDetectorBot/1.0)" },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`[LINK DEBUG] ${url.toString()} returned status ${res.status}`);
      return { url: url.toString(), reachable: false, note: `Link returned HTTP ${res.status}.` };
    }

    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
    const ogDescription = (html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i) || [])[1]?.trim()
      || (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1]?.trim()
      || null;

    console.log(`[LINK DEBUG] ${url.toString()} title="${title}" desc="${ogDescription}"`);

    const looksLoginWalled = /log ?in|sign ?up|sign ?in/i.test(title || "") && !ogDescription;

    return {
      url: url.toString(),
      reachable: true,
      title,
      description: ogDescription,
      note: looksLoginWalled
        ? "The page appears to require login to view - no public profile content could be read."
        : null,
    };
  } catch (err) {
    console.log(`[LINK DEBUG] ${url.toString()} fetch failed: ${err.message}`);
    return { url: url.toString(), reachable: false, note: "Link could not be reached (timeout or network error)." };
  }
}

async function searchSerpApi(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    console.warn("SERPAPI_KEY not set - skipping live search, returning empty results.");
    return [];
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", key);
  url.searchParams.set("num", "10");

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.error("SerpAPI error:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  const organic = data.organic_results || [];

  // TEMP DEBUG LOGGING - remove once search quality is confirmed
  console.log(`[SEARCH DEBUG] query="${query}" | raw result count=${organic.length}`);
  organic.slice(0, 8).forEach((r, i) => {
    console.log(`[SEARCH DEBUG] result ${i + 1}: title="${r.title}" link="${r.link}"`);
  });
  if (data.search_metadata) {
    console.log(`[SEARCH DEBUG] search_metadata.status=${data.search_metadata.status}`);
  }
  if (data.error) {
    console.log(`[SEARCH DEBUG] SerpAPI error field: ${data.error}`);
  }

  return organic.slice(0, 8).map((r) => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link,
  }));
}
