/**
 * Public-source search wrapper. Neither Claude nor Google Sheets can search
 * the live web on their own - this module calls an actual search provider
 * and returns a short list of results for the AI step to reason over.
 *
 * Swap providers by changing SEARCH_PROVIDER in .env. Only SerpAPI is wired
 * up below; add others (Bing Web Search, etc.) following the same shape.
 */

export async function runPublicSearch({ name, company, town }) {
  const provider = process.env.SEARCH_PROVIDER || "serpapi";
  const queryParts = [name, company, town].filter(Boolean);
  const query = queryParts.join(" ");

  if (!query.trim()) return [];

  if (provider === "serpapi") {
    return searchSerpApi(query);
  }

  throw new Error(`Unsupported SEARCH_PROVIDER: ${provider}`);
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

  return organic.slice(0, 8).map((r) => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link,
  }));
}
