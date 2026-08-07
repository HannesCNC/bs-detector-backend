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
- Company-status discrepancies are ALWAYS at least "yellow", never "green":
  if the search results indicate the company is deregistered, in final
  deregistration, dissolved, struck off, or otherwise not currently an active
  registered entity - and this is inconsistent with the business appearing to
  currently be trading or being presented as such - this on its own is
  sufficient for "yellow", even if nothing else in the sources looks
  concerning. Say plainly that a company-status discrepancy was found and
  that the current legal entity, registration number, and bank account name
  should be confirmed before paying or appointing them.
- NEVER state or imply a person committed a crime, is a "scammer", or is
  untrustworthy. Describe only that "clarification may be needed" and why,
  in general terms. This applies even to deregistration - describe it as a
  status discrepancy to verify, never as evidence of fraud.
- If an uploaded image is provided (a photo or screenshot of a quote,
  invoice, or business card), treat it as evidence exactly like pasted text:
  read what's visible in it (company name, quoted amount, contact details,
  letterhead, VAT/registration number, banking details) and factor it into
  your assessment the same way you would pasted text - cross-check it
  against the search results, note any mismatch between what the image
  claims and what public sources show. Still never quote it verbatim in your
  output; describe only, in your own words, at a high level.
- NEVER quote search result text verbatim. Paraphrase only, and only at a
  high level (e.g. "public listings do not show a registered business under
  this name" rather than repeating specific quoted claims).
- If a SUBMITTED LINK CHECK section shows the link could not be verified,
  is login-walled, or is unreachable, treat that as a reason to lean "yellow"
  (an unverifiable claimed profile is exactly the kind of thing that warrants
  clarification) - do not treat an unreachable link as proof of anything bad,
  only as unverified.
- If search results are sparse or the query is too generic to be meaningful,
  return "yellow" with a message noting the scan was inconclusive due to
  limited identifying information - do not guess.
- ALSO produce a "detailedSummary": a longer plain-language paragraph (roughly
  3-6 sentences) listing what the public sources actually show - e.g. company
  registration status, directory listings found, business names/associations,
  towns/addresses mentioned - purely descriptive, still fully paraphrased
  (never quoted), still never alleging wrongdoing. This longer summary is
  shown only to paying subscribers, but you must always produce it so the
  system can choose whether to reveal it. If there is genuinely nothing to
  summarize, detailedSummary can simply restate that no relevant public
  information was found.
- Output ONLY valid JSON, no markdown fences, no preamble:
  {"status": "green" | "yellow", "message": "one sentence, max 220 chars", "detailedSummary": "3-6 sentences, max 900 chars"}`;

// Deterministic safety net, separate from (and in addition to) the model's
// own judgement. A live test found a case where a search result plainly
// showed a company as deregistered but the model still returned "green" -
// a single LLM judgement call is probabilistic and can miss or under-weight
// a specific signal even with prompt instructions telling it not to. This
// function checks the RAW search result text directly (not the model's own
// summary of it, which could have already dropped the signal) and forces a
// floor of "yellow" whenever deregistration-type language is present,
// regardless of what the model concluded on its own.
const DEREGISTRATION_PATTERNS = [
  /\bderegistered\b/i,
  /\bderegistration\b/i,
  /\bfinal deregistration\b/i,
  /\bnot in business\b/i,
  /\bno longer (in business|active|trading|registered)\b/i,
  /\bdissolved\b/i,
  /\bstruck off\b/i,
  /\bin liquidation\b/i,
];

export function detectDeregistrationSignal(searchResults) {
  if (!Array.isArray(searchResults) || searchResults.length === 0) return false;
  return searchResults.some((r) => {
    const text = `${r.title || ""} ${r.snippet || ""}`;
    return DEREGISTRATION_PATTERNS.some((pattern) => pattern.test(text));
  });
}

const DEREGISTRATION_OVERRIDE_MESSAGE =
  "Company-status discrepancy found. Public information indicates that a company associated with this business may be deregistered or no longer active. Confirm the current legal entity, registration number and bank-account name before paying or appointing them.";

// Claude's vision input accepts these image formats. Anything else is
// rejected with a clear error rather than silently failing at the API call.
const ALLOWED_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
// Base64 is ~33% larger than the raw bytes. Capping at ~5.5MB of base64 text
// keeps the underlying image under ~4MB, comfortably under Claude's per-image
// limit, while still covering a typical phone photo of a printed quote.
const MAX_IMAGE_BASE64_LENGTH = 5_500_000;

export function validateImageInput({ imageBase64, imageMediaType }) {
  if (!imageBase64) return { valid: true, present: false };

  if (typeof imageBase64 !== "string" || typeof imageMediaType !== "string") {
    return { valid: false, error: "Invalid image data." };
  }
  if (!ALLOWED_IMAGE_MEDIA_TYPES.includes(imageMediaType)) {
    return { valid: false, error: "Unsupported image type - please use a JPEG, PNG, GIF, or WEBP photo." };
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
    return { valid: false, error: "Image is too large - please use a smaller photo or screenshot (max ~4MB)." };
  }
  return { valid: true, present: true };
}

export async function assess({ name, company, town, subjectPhone, website, pastedText, reason, searchResults, submittedLink, imageBase64, imageMediaType }) {
  const linkSection = !website
    ? "(no website/social link submitted)"
    : !submittedLink
      ? "(link submitted but could not be checked)"
      : !submittedLink.reachable
        ? `The user submitted this link: ${submittedLink.url}. It could not be verified: ${submittedLink.note}`
        : submittedLink.note
          ? `The user submitted this link: ${submittedLink.url}. ${submittedLink.note}`
          : `The user submitted this link: ${submittedLink.url}. Its public page title is: "${submittedLink.title || "(none)"}"${submittedLink.description ? ` and its public description is: "${submittedLink.description}"` : ""}.`;

  const userContent = `
SUBMITTED INFORMATION:
Name: ${name || "(not provided)"}
Company: ${company || "(not provided)"}
Town: ${town || "(not provided)"}
Business/contractor phone number (as supplied by the user, if any): ${subjectPhone || "(not provided)"}
Website/social: ${website || "(not provided)"}
Reason for check: ${reason || "(not provided)"}
Pasted text/claims from user: ${pastedText || "(none)"}

SUBMITTED LINK CHECK (direct fetch of the exact link the user provided, if any):
${linkSection}

PUBLIC SEARCH RESULTS (title / snippet / link):
${searchResults.length === 0
    ? "(no results returned - treat as inconclusive)"
    : searchResults.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join("\n")}

${imageBase64 ? "An image was also uploaded (a photo or screenshot of a quote/invoice/business card) - it is attached below. Read it and factor it in as described in your instructions." : "(no image uploaded)"}

Return the JSON assessment now.`;

  const messageContent = imageBase64
    ? [
        { type: "text", text: userContent },
        { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
      ]
    : userContent;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: messageContent }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = (textBlock?.text || "").trim().replace(/^```json|```$/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (parsed.status !== "green" && parsed.status !== "yellow") {
      throw new Error("invalid status");
    }
    if (!parsed.detailedSummary) {
      parsed.detailedSummary = "No additional detail is available for this scan.";
    }
  } catch (err) {
    console.error("Failed to parse Claude response:", raw, err);
    // Fail safe: inconclusive rather than a false green
    return {
      status: "yellow",
      message: "The scan could not be completed reliably - please try again or add more identifying detail.",
      detailedSummary: "The scan could not be completed reliably - please try again or add more identifying detail.",
    };
  }

  // Deterministic override: even though the prompt now explicitly instructs
  // the model on this rule, this check runs independently of the model's
  // own output and can't be skipped by a bad single-pass judgement call.
  if (parsed.status === "green" && detectDeregistrationSignal(searchResults)) {
    console.warn("Deregistration signal found in search results but model returned green - overriding to yellow.", JSON.stringify({ name, company }));
    parsed.status = "yellow";
    parsed.message = DEREGISTRATION_OVERRIDE_MESSAGE;
    parsed.detailedSummary = `${DEREGISTRATION_OVERRIDE_MESSAGE} ${parsed.detailedSummary || ""}`.trim();
  }

  return parsed;
}
