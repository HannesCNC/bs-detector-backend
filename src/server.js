import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { runPublicSearch } from "./search.js";
import { assess } from "./anthropic.js";
import { appendCheckRow, appendMarketingConsent, countChecksThisMonth, recordSubscriptionEvent, getExtraScansThisMonth, getExtraSummaryUnlocksThisMonth, isSubscribedThisMonth } from "./sheets.js";
import { verifyPayFastNotification, buildCheckoutFields } from "./payfast.js";
import { applyPromoCode } from "./promo.js";

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy; needed for express-rate-limit and accurate client IPs
app.use(express.json({ limit: "2mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));

// Values accepted for the optional userType field (RichLab organisational
// lead classification). Anything else submitted is silently ignored rather
// than rejected, so this stays a non-breaking, optional field.
const ALLOWED_USER_TYPES = [
  "personal",
  "business",
  "estate_hoa",
  "managing_agent",
  "security_company",
  "other_organisation",
];

// Basic bot/abuse throttle on top of the per-phone monthly cap below.
// Custom handler so a rate-limit hit returns clean, frontend-friendly JSON
// instead of the default plain-text response.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "rate_limited",
      message: "Our system is receiving too many checks at the moment. Please try again shortly.",
    });
  },
});
app.use("/api/", limiter);

const FREE_SCANS_PER_MONTH = Number(process.env.FREE_SCANS_PER_MONTH || 5);
const CONSENT_VERSION = "v1.0-2026-07-24";

app.get("/health", (_req, res) => res.json({ ok: true }));

// PayFast sends its ITN as application/x-www-form-urlencoded. We need the
// EXACT raw body (not re-encoded by a parser) to pass back to PayFast's own
// validation endpoint, so we capture it manually before parsing.
app.post(
  "/webhooks/payfast-itn",
  express.urlencoded({
    extended: false,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
  async (req, res) => {
    // Always respond 200 quickly - PayFast retries if it doesn't get one.
    // We do the actual verification after responding is not safe though,
    // since we must not act on unverified data - so we verify first, but
    // keep it fast (signature check is instant; the PayFast confirmation
    // call is the only network round-trip).
    try {
      const fields = req.body || {};
      const verification = await verifyPayFastNotification(fields, req.rawBody);

      if (!verification.valid) {
        console.warn("Rejected PayFast ITN:", verification.reason, fields);
        // Still return 200 so PayFast doesn't endlessly retry a forged/bad
        // notification, but we never mark anything as paid.
        return res.sendStatus(200);
      }

      // Genuine, verified payment notification - record it.
      // custom_str1 is where we'll pass the user's phone number when the
      // checkout is initiated (front-end/checkout-initiation piece not yet
      // built - this endpoint currently only handles the receiving side).
      await recordSubscriptionEvent({
        timestamp: new Date().toISOString(),
        phone: fields.custom_str1 || "",
        email: fields.email_address || "",
        paymentStatus: fields.payment_status || "",
        amountGross: fields.amount_gross || "",
        pfPaymentId: fields.pf_payment_id || "",
        itemName: fields.item_name || "",
      });

      return res.sendStatus(200);
    } catch (err) {
      console.error("Error handling PayFast ITN:", err);
      // Return 200 anyway - a 500 here just causes PayFast to hammer retries
      // for an error that's on our side, not something re-sending will fix.
      return res.sendStatus(200);
    }
  }
);

app.post("/api/redeem-promo", async (req, res) => {
  try {
    const { code, phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, error: "validation_error", message: "A phone number is required to redeem a code." });
    }
    const result = await applyPromoCode({ code, phone });
    return res.json(result);
  } catch (err) {
    console.error("Error in /api/redeem-promo:", err);
    return res.status(500).json({ success: false, error: "server_error", message: "Something went wrong redeeming that code. Please try again shortly." });
  }
});

app.post("/api/create-checkout", (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: "validation_error", message: "A phone number is required to start checkout." });
    }

    const backendUrl = `https://${req.get("host")}`;
    const { fields, processUrl } = buildCheckoutFields({
      phone,
      amount: process.env.SUBSCRIPTION_PRICE || "99.00",
      itemName: "BS Detector - Personal subscription (1 month)",
      returnUrl: process.env.CHECKOUT_RETURN_URL || "https://hannescnc.github.io/bs-detector-backend/",
      cancelUrl: process.env.CHECKOUT_CANCEL_URL || "https://hannescnc.github.io/bs-detector-backend/",
      notifyUrl: `${backendUrl}/webhooks/payfast-itn`,
    });

    return res.json({ fields, processUrl });
  } catch (err) {
    console.error("Error in /api/create-checkout:", err);
    return res.status(500).json({ error: "server_error", message: "Could not start checkout. Please try again shortly." });
  }
});

app.post("/api/check", async (req, res) => {
  try {
    const {
      name,
      company,
      town,
      phone,
      email,
      website,
      pastedText,
      reason,
      marketingConsent,
      source,
      userType,
    } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ error: "validation_error", message: "Name and a verified phone number are required." });
    }

    // Optional, non-breaking fields. Any caller that omits them (the
    // existing Scammer Scan frontend) behaves exactly as before.
    const resolvedSource = (typeof source === "string" && source.trim()) ? source.trim().toLowerCase() : "direct";
    const resolvedUserType = (typeof userType === "string" && ALLOWED_USER_TYPES.includes(userType.trim().toLowerCase()))
      ? userType.trim().toLowerCase()
      : "";

    // --- Free tier enforcement (base allowance + any promo-granted extra scans) ---
    const usedThisMonth = await countChecksThisMonth(phone);
    const extraScans = await getExtraScansThisMonth(phone);
    const totalAllowance = FREE_SCANS_PER_MONTH + extraScans;
    if (usedThisMonth >= totalAllowance) {
      return res.status(429).json({
        error: "free_tier_exceeded",
        message: `You've used your ${totalAllowance} available scans this month. Upgrade to a paid plan or enter a promo code for more checks.`,
      });
    }

    // --- Run the actual scan ---
    // Isolated try/catch: failures here are almost always an upstream
    // dependency (search provider or the assessment call) rather than a bug
    // in our own logic, so they get a distinct 503 "temporarily overloaded"
    // response instead of the generic 500 used below.
    let generalResults, submittedLink, result;
    try {
      ({ generalResults, submittedLink } = await runPublicSearch({ name, company, town, website }));
      result = await assess({
        name, company, town, phone, website, pastedText, reason, searchResults: generalResults, submittedLink,
      });
    } catch (scanErr) {
      console.error("Error running scan (search/assess) in /api/check:", scanErr);
      return res.status(503).json({
        error: "temporarily_unavailable",
        message: "Our system is currently overloaded. Please try again in a couple of hours.",
      });
    }

    const isPaidSubscriber = await isSubscribedThisMonth(phone);
    const extraSummaryUnlocks = await getExtraSummaryUnlocksThisMonth(phone);
    const BASE_FREE_SUMMARIES = Number(process.env.FREE_DETAILED_SUMMARIES_PER_MONTH || 5);
    const summaryAllowance = BASE_FREE_SUMMARIES + extraSummaryUnlocks;
    // usedThisMonth is the count BEFORE this request - so this check is the
    // (usedThisMonth + 1)th of the month. It gets the full summary for free
    // if it falls within the base+promo allowance, or if the user is a paid
    // subscriber (who always gets it regardless of count).
    const includeDetailedSummary = isPaidSubscriber || usedThisMonth < summaryAllowance;

    // --- Log to Sheets (audit trail + usage counting) ---
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
    await appendCheckRow({
      timestamp: new Date().toISOString(),
      phone,
      email,
      nameChecked: name,
      companyChecked: company,
      town,
      reason,
      status: result.status,
      message: result.message,
      consentVersion: CONSENT_VERSION,
      ip,
      source: resolvedSource,
      userType: resolvedUserType,
    });

    // Marketing consent is stored separately and only if explicitly ticked -
    // never inferred from the service consent, per the framework's requirement.
    if (typeof marketingConsent === "boolean") {
      await appendMarketingConsent({
        timestamp: new Date().toISOString(),
        phone,
        email,
        marketingConsent,
        consentVersion: CONSENT_VERSION,
      });
    }

    return res.json({
      status: result.status,
      message: result.message,
      scansRemaining: Math.max(0, totalAllowance - usedThisMonth - 1),
      disclaimer: "This is a limited public-source scan based on the information supplied. It is not a formal background check or legal clearance.",
      isPaidSubscriber,
      detailedSummary: includeDetailedSummary ? result.detailedSummary : null,
      upgradePrompt: includeDetailedSummary
        ? null
        : "You've used your free detailed summaries for this month. Upgrade for unlimited full summaries, or enter a promo code for 5 more.",
    });
  } catch (err) {
    console.error("Error in /api/check:", err);
    return res.status(500).json({ error: "server_error", message: "Something went wrong running the scan. Please try again shortly." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BS Detector backend listening on port ${port}`));
