import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { runPublicSearch } from "./search.js";
import { assess } from "./anthropic.js";
import { appendCheckRow, appendMarketingConsent, countChecksThisMonth } from "./sheets.js";

const app = express();
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

    // --- Free tier enforcement ---
    const usedThisMonth = await countChecksThisMonth(phone);
    if (usedThisMonth >= FREE_SCANS_PER_MONTH) {
      return res.status(429).json({
        error: "free_tier_exceeded",
        message: `You've used your ${FREE_SCANS_PER_MONTH} free scans this month. Upgrade to a paid plan for more checks.`,
      });
    }

    // --- Run the actual scan ---
    const searchResults = await runPublicSearch({ name, company, town });
    const result = await assess({
      name, company, town, phone, website, pastedText, reason, searchResults,
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
      scansRemaining: Math.max(0, FREE_SCANS_PER_MONTH - usedThisMonth - 1),
      disclaimer: "This is a limited public-source scan based on the information supplied. It is not a formal background check or legal clearance.",
    });
  } catch (err) {
    console.error("Error in /api/check:", err);
    return res.status(500).json({ error: "Something went wrong running the scan. Please try again shortly." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`BS Detector backend listening on port ${port}`));
