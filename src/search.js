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

  const results = [];

  if (query.trim()) {
    const generalResults = await searchSerpApi(query);
    results.push(...generalResults);
  }

  // If a website/social link was submitted, run a second targeted search
  // scoped to that specific domain so we actually check the claimed profile,
  // rather than relying on a generic name search to happen to surface it.
  if (website) {
    try {
      const hostname = new URL(website.startsWith("http") ? website : `https://${website}`).hostname
        .replace(/^www\./, "");
      const siteQuery = [name, `site:${hostname}`].filter(Boolean).join(" ");
      const siteResults = await searchSerpApi(siteQuery);
      results.push(...siteResults);
    } catch (err) {
      console.warn("Could not parse submitted website for targeted search:", website, err.message);
    }
  }

  // Dedupe by link, cap total so the AI step isn't overwhelmed
  const seen = new Set();
  const deduped = results.filter((r) => {
    if (!r.link || seen.has(r.link)) return false;
    seen.add(r.link);
    return true;
  });

  return deduped.slice(0, 12);
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
    console.error("SerpAPI error:",
