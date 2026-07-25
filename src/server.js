import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { runPublicSearch } from "./search.js";
import { assess } from "./anthropic.js";
import { appendCheckRow, appendMarketingConsent, countChecksThisMonth, recordSubscriptionEvent, getExtraScansThisMonth } from "./sheets.js";
import { verifyPayFastNotification } from "./payfast.js";
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

// Basic bot/abuse throttle on top of the per-phone monthly cap below.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
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
      return res.status(400).json({ success: false, message: "A phone number is required to redeem a code." });
    }
    const result = await applyPromoCode({ code, phone });
    return res.json(result);
  } catch (err) {
    console.error("Error in /api/redeem-promo:", err);
    return res.status(500).json({ success: false, message: "Something went wrong redeeming that code. Please try again shortly." });
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
    } = req.body || {};

    if (!name || !phone) {
      return res.status(400).json({ error: "Name and a verified phone number are required." });
    }

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
    const { generalResults, submittedLink } = await runPublicSearch({ name, company, town, website });
    const result = await assess({
      name, company, town, phone, website, pastedText, reason, searchResults: generalResults, submittedLink,
    });

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
    });
  } catch (err) {
    console.error("Error in /api/check:", err);
    return res.status(500).json({ error: "Something went wrong running the scan. Please try again shortly." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BS Detector backend listening on port ${port}`));
