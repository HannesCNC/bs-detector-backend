import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the assessment engine for a "limited public-source scan" tool.
Users submit a name, optional company, town, and optional pasted text/claims about
a contractor or business contact. You are given a small set of public search
results about that name/company.

Your job: decide "green" or "yellow" and write ONE short, neutral sentence.

Rules:
- GREEN means: nothing in the limited sources checked raised a reason for concern.
  It is never a guarantee of trustworthiness.
- YELLOW means: something in the sources or the submitted material warrants
  clarification or deeper verification before the user proceeds (e.g. a
  mismatch between claimed and found business details, multiple unrelated
  people/companies sharing the name making the search inconclusive, public
  complaint patterns, contradictions in the pasted text, or an inability to
  verify a claimed detail at all).
- NEVER state or imply a person committed a crime, is a "scammer", or is
  untrustworthy. Describe only that "clarification may be needed" and why,
  in general terms.
- NEVER quote search result text verbatim. Paraphrase only, and only at a
  high level (e.g. "public listings do not show a registered business under
  this name" rather than repeating specific quoted claims).
- If search results are sparse or the query is too generic to be meaningful,
  return "yellow" with a message noting the scan was inconclusive due to
  limited identifying information - do not guess.
- Output ONLY valid JSON, no markdown fences, no preamble:
  {"status": "green" | "yellow", "message": "one sentence, max 220 chars"}`;

export async function assess({ name, company, town, phone, website, pastedText, reason, searchResults }) {
  const userContent = `
SUBMITTED INFORMATION:
Name: ${name || "(not provided)"}
Company: ${company || "(not provided)"}
Town: ${town || "(not provided)"}
Phone: ${phone || "(not provided)"}
Website/social: ${website || "(not provided)"}
Reason for check: ${reason || "(not provided)"}
Pasted text/claims from user: ${pastedText || "(none)"}

PUBLIC SEARCH RESULTS (title / snippet / link):
${searchResults.length === 0
    ? "(no results returned - treat as inconclusive)"
    : searchResults.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join("\n")}

Return the JSON assessment now.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = (textBlock?.text || "").trim().replace(/^```json|```$/g, "").trim();

  try {
    const parsed = JSON.parse(raw);
    if (parsed.status !== "green" && parsed.status !== "yellow") {
      throw new Error("invalid status");
    }
    return parsed;
  } catch (err) {
    console.error("Failed to parse Claude response:", raw, err);
    // Fail safe: inconclusive rather than a false green
    return {
      status: "yellow",
      message: "The scan could not be completed reliably - please try again or add more identifying detail.",
    };
  }
}
