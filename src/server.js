import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { runPublicSearch } from "./search.js";
import { assess, validateImageInput } from "./anthropic.js";
import {
  appendCheckRow,
  appendMarketingConsent,
  countChecksThisMonth,
  recordSubscriptionEvent,
  getExtraScansThisMonth,
  getExtraSummaryUnlocksThisMonth,
  isSubscribedThisMonth,
  getCreditPurchaseByPaymentId,
  appendCreditPurchase,
  getPaidCreditsPurchasedTotal,
  getPaidCreditsUsedTotal,
  getPromoChecksUsedThisMonth,
  getFreeChecksUsedThisMonth,
  appendToolEvent,
  hashIp,
  summarizeUserAgent,
} from "./sheets.js";
import { verifyPayFastNotification, buildCheckoutFields } from "./payfast.js";
import { applyPromoCode } from "./promo.js";

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy; needed for express-rate-limit and accurate client IPs
app.use(express.json({ limit: "8mb" })); // raised from 2mb to fit a base64-encoded phone photo of a quote/invoice

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
}));

const ALLOWED_USER_TYPES = [
  "personal",
  "business",
  "estate_hoa",
  "managing_agent",
  "security_company",
  "other_organisation",
];

// Anonymous funnel events from the RichLab quick advert checker. Deliberately
// a small closed allowlist - anything else is rejected, not just ignored.
const ALLOWED_EVENTS = [
  "quick_check_started",
  "quick_check_completed",
  "business_check_clicked",
  "business_check_submitted",
];

const MAX_EVENT_FIELD_LENGTH = 120; // "accept only small strings" per spec - generous enough for any real campaign/session id, small enough to block abuse

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
const CHECK_BUNDLE_PRICE_ZAR = Number(process.env.CHECK_BUNDLE_PRICE_ZAR || 100);
const CHECK_BUNDLE_QUANTITY = Number(process.env.CHECK_BUNDLE_QUANTITY || 25);
const CONSENT_VERSION = "v1.0-2026-07-24";

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Works out a phone's current balance across all three allowance types and,
 * per the agreed priority order, which one the NEXT check would draw from.
 * Read-only - callable freely from /api/check-balance without side effects.
 */
async function getAllowance(phone) {
  const [purchasedTotal, paidUsedTotal, promoGrantedThisMonth, promoUsedThisMonth, freeUsedThisMonth] = await Promise.all([
    getPaidCreditsPurchasedTotal(phone),
    getPaidCreditsUsedTotal(phone),
    getExtraScansThisMonth(phone),
    getPromoChecksUsedThisMonth(phone),
    getFreeChecksUsedThisMonth(phone),
  ]);

  const paidCreditsRemaining = Math.max(0, purchasedTotal - paidUsedTotal);
  const promoChecksRemaining = Math.max(0, promoGrantedThisMonth - promoUsedThisMonth);
  const freeChecksRemaining = Math.max(0, FREE_SCANS_PER_MONTH - freeUsedThisMonth);

  return {
    freeChecksRemaining,
    paidCreditsRemaining,
    promoChecksRemaining,
    totalChecksAvailable: freeChecksRemaining + paidCreditsRemaining + promoChecksRemaining,
  };
}

/** Priority order: paid credits, then promo credits, then the monthly free allowance. */
function pickCreditSource(allowance) {
  if (allowance.paidCreditsRemaining > 0) return "paid";
  if (allowance.promoChecksRemaining > 0) return "promo";
  if (allowance.freeChecksRemaining > 0) return "free";
  return null;
}

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
    try {
      const fields = req.body || {};
      const verification = await verifyPayFastNotification(fields, req.rawBody);

      if (verification.valid && verification.signatureMatched === false) {
        console.warn("PayFast ITN accepted via server confirmation, but local signature check did not match (advisory only, not blocking).", JSON.stringify({
          debug: verification.debug,
        }));
      }

      if (!verification.valid) {
        // Single JSON.stringify call -> one clean log line, not a multi-line
        // node inspect dump that can get fragmented/reordered by Railway's
        // log capture. Debug info (computed vs received signature, exact
        // param string used) is included so a mismatch can be diagnosed
        // directly from this one line without needing to reproduce it.
        console.warn("Rejected PayFast ITN:", JSON.stringify({
          reason: verification.reason,
          debug: verification.debug || null,
          receivedFields: fields,
        }));
        return res.sendStatus(200);
      }

      const isCreditBundle = fields.custom_str2 === "credit_bundle";
      console.log("PayFast ITN accepted (signature valid).", JSON.stringify({
        pfPaymentId: fields.pf_payment_id,
        paymentStatus: fields.payment_status,
        customStr2Received: fields.custom_str2 ?? null,
        treatedAsCreditBundle: isCreditBundle,
      }));

      if (isCreditBundle) {
        // Only ever grant credits for a COMPLETE payment, and only once per
        // pf_payment_id - PayFast can and does resend ITNs, so this dedup
        // check is what stops a resend from doubling someone's balance.
        const paymentStatus = (fields.payment_status || "").trim().toUpperCase();

        if (paymentStatus === "COMPLETE") {
          const already = await getCreditPurchaseByPaymentId(fields.pf_payment_id);
          if (already) {
            console.log("Bundle ITN: credits already granted for this pf_payment_id, skipping.", JSON.stringify({
              pfPaymentId: fields.pf_payment_id, phone: fields.custom_str1,
            }));
          } else {
            await appendCreditPurchase({
              timestamp: new Date().toISOString(),
              phone: fields.custom_str1 || "",
              creditsGranted: CHECK_BUNDLE_QUANTITY,
              pfPaymentId: fields.pf_payment_id || "",
              amountGross: fields.amount_gross || "",
              product: "check_bundle_25",
            });
            console.log("Bundle ITN: credits granted.", JSON.stringify({
              pfPaymentId: fields.pf_payment_id, phone: fields.custom_str1, creditsGranted: CHECK_BUNDLE_QUANTITY,
            }));
          }
        } else {
          console.log("Bundle ITN: received but payment_status was not COMPLETE, no credits granted.", JSON.stringify({
            pfPaymentId: fields.pf_payment_id, phone: fields.custom_str1, paymentStatus: fields.payment_status,
          }));
        }
        return res.sendStatus(200);
      }

      // Legacy recurring-subscription path - unchanged behaviour.
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
    return res.status(500).json({ error: "payment_error", message: "Could not start checkout. Please try again shortly." });
  }
});

// Dedicated checkout for the Business Check credit bundle (25 checks / R100
// by default). Kept as its own endpoint rather than overloading
// /api/create-checkout, since the two products have different amounts,
// item names, and post-payment handling (credits vs a subscription flag).
app.post("/api/create-bundle-checkout", (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: "validation_error", message: "A phone number is required to start checkout." });
    }

    const backendUrl = `https://${req.get("host")}`;
    const { fields, processUrl } = buildCheckoutFields({
      phone,
      amount: CHECK_BUNDLE_PRICE_ZAR,
      itemName: `Business Check bundle (${CHECK_BUNDLE_QUANTITY} checks)`,
      returnUrl: process.env.CHECKOUT_RETURN_URL || "https://hannescnc.github.io/bs-detector-backend/",
      cancelUrl: process.env.CHECKOUT_CANCEL_URL || "https://hannescnc.github.io/bs-detector-backend/",
      notifyUrl: `${backendUrl}/webhooks/payfast-itn`,
      productTag: "credit_bundle",
    });

    return res.json({ fields, processUrl, bundleQuantity: CHECK_BUNDLE_QUANTITY, bundlePriceZar: CHECK_BUNDLE_PRICE_ZAR });
  } catch (err) {
    console.error("Error in /api/create-bundle-checkout:", err);
    return res.status(500).json({ error: "payment_error", message: "Could not start checkout. Please try again shortly." });
  }
});

// Lets the frontend show "X checks remaining" without submitting a check.
app.post("/api/check-balance", async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ error: "validation_error", message: "A phone number is required." });
    }

    const allowance = await getAllowance(phone);
    const allowanceType = pickCreditSource(allowance) || "none";

    return res.json({ ...allowance, allowanceType });
  } catch (err) {
    console.error("Error in /api/check-balance:", err);
    return res.status(500).json({ error: "server_error", message: "Could not check your balance right now. Please try again shortly." });
  }
});

// Anonymous, unlimited funnel-tracking endpoint for the RichLab quick advert
// checker. No personal data, no advert content - just enough to see how the
// funnel is performing. Rejects anything outside a small fixed allowlist.
app.post("/api/track-event", async (req, res) => {
  try {
    const { event, source, campaign, page, sessionId } = req.body || {};

    if (!ALLOWED_EVENTS.includes(event)) {
      return res.status(400).json({ error: "validation_error", message: "Unrecognised event name." });
    }

    const fields = { source, campaign, page, sessionId };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && (typeof value !== "string" || value.length > MAX_EVENT_FIELD_LENGTH)) {
        return res.status(400).json({ error: "validation_error", message: `Invalid ${key}.` });
      }
    }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

    await appendToolEvent({
      timestamp: new Date().toISOString(),
      event,
      source: source || "richlab",
      campaign: campaign || "",
      page: page || "",
      sessionId: sessionId || "",
      ipHash: hashIp(ip),
      userAgentSummary: summarizeUserAgent(req.headers["user-agent"]),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Error in /api/track-event:", err);
    return res.status(500).json({ success: false, error: "server_error", message: "Could not record that event." });
  }
});

app.post("/api/check", async (req, res) => {
  try {
    const {
      name,
      company,
      town,
      phone,
      subjectPhone,
      email,
      website,
      pastedText,
      reason,
      marketingConsent,
      source,
      userType,
      imageBase64,
      imageMediaType,
    } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ error: "validation_error", message: "Name and a verified phone number are required." });
    }

    // Validate the image BEFORE touching any allowance - a bad/oversized
    // image should never cost the user a check.
    const imageValidation = validateImageInput({ imageBase64, imageMediaType });
    if (!imageValidation.valid) {
      return res.status(400).json({ error: "validation_error", message: imageValidation.error });
    }

    const resolvedSource = (typeof source === "string" && source.trim()) ? source.trim().toLowerCase() : "direct";
    const resolvedUserType = (typeof userType === "string" && ALLOWED_USER_TYPES.includes(userType.trim().toLowerCase()))
      ? userType.trim().toLowerCase()
      : "";

    // --- Work out which allowance (if any) this check would draw from ---
    const allowance = await getAllowance(phone);
    const creditSource = pickCreditSource(allowance);

    if (!creditSource) {
      return res.status(402).json({
        error: "no_credits_remaining",
        message: `Your ${FREE_SCANS_PER_MONTH} free Business Checks have been used. Unlock ${CHECK_BUNDLE_QUANTITY} more checks for R${CHECK_BUNDLE_PRICE_ZAR}.`,
        bundlePriceZar: CHECK_BUNDLE_PRICE_ZAR,
        bundleQuantity: CHECK_BUNDLE_QUANTITY,
      });
    }

    // --- Run the actual scan ---
    // Isolated try/catch: failures here are almost always an upstream
    // dependency (search provider or the assessment call) rather than a bug
    // in our own logic, so they get a distinct 503 response. Crucially,
    // nothing is deducted/logged if this fails - a failed attempt never
    // costs the user a check.
    let generalResults, submittedLink, result;
    try {
      ({ generalResults, submittedLink } = await runPublicSearch({ name, company, town, website }));
      result = await assess({
        // NOTE: intentionally passing subjectPhone here, NOT phone. `phone`
        // is the identity/metering key for whoever is running the check -
        // it has nothing to do with the business being investigated, and
        // was previously (incorrectly) fed into the assessment prompt as if
        // it were information about the subject. subjectPhone is the
        // business/contractor's own number, if the user has and supplied it.
        name, company, town, subjectPhone, website, pastedText, reason, searchResults: generalResults, submittedLink,
        imageBase64: imageValidation.present ? imageBase64 : undefined,
        imageMediaType: imageValidation.present ? imageMediaType : undefined,
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
    const freeSummariesUsedThisMonth = await getFreeChecksUsedThisMonth(phone); // detailed-summary allowance still tracks off free-tier usage count, unchanged from before
    const includeDetailedSummary = isPaidSubscriber || freeSummariesUsedThisMonth < summaryAllowance;

    // --- Log to Sheets (this write IS the deduction - see credit_source) ---
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
      creditSource,
    });

    if (typeof marketingConsent === "boolean") {
      await appendMarketingConsent({
        timestamp: new Date().toISOString(),
        phone,
        email,
        marketingConsent,
        consentVersion: CONSENT_VERSION,
      });
    }

    // Backend-side automatic funnel logging - preferred over relying on the
    // frontend to send this separately, since it can't be missed or double-fired.
    try {
      await appendToolEvent({
        timestamp: new Date().toISOString(),
        event: "business_check_submitted",
        source: resolvedSource,
        campaign: "",
        page: "check-business",
        sessionId: "",
        ipHash: hashIp(ip),
        userAgentSummary: summarizeUserAgent(req.headers["user-agent"]),
      });
    } catch (eventErr) {
      // Never let funnel-tracking failure affect the actual check response.
      console.error("Error logging business_check_submitted event:", eventErr);
    }

    const remainingAfterThisCheck = Math.max(0, allowance.totalChecksAvailable - 1);

    return res.json({
      status: result.status,
      message: result.message,
      scansRemaining: remainingAfterThisCheck,
      creditSource,
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
