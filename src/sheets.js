import { google } from "googleapis";
import crypto from "crypto";

/**
 * Thin wrapper around Google Sheets used as a lightweight database for the MVP.
 *
 * Tabs expected in the target spreadsheet:
 *
 *   "Checks" - log of every Business Check performed (usage limits + audit trail)
 *     timestamp | phone | email | name_checked | company_checked | town |
 *     reason | status | message | consent_version | ip | source | user_type |
 *     credit_source
 *
 *     credit_source: which allowance paid for this check - "paid", "promo",
 *     or "free". Blank on rows written before this column existed; those are
 *     treated as "free" everywhere this is read, so old data still counts
 *     correctly against the free monthly allowance.
 *
 *   "Marketing" - opt-in consent records, kept separate from service consent.
 *     timestamp | phone | email | marketing_consent | consent_version
 *
 *   "Subscriptions" - legacy recurring-subscriber payment log (unchanged,
 *   still used only to unlock detailed summaries - NOT extra Business Checks).
 *     timestamp | phone | email | payment_status | amount_gross |
 *     pf_payment_id | item_name
 *
 *   "CreditPurchases" - one row per verified Business Check bundle payment.
 *   pf_payment_id is the dedup key: an ITN that's already been recorded here
 *   is never granted credits twice, even if PayFast resends it.
 *     timestamp | phone | credits_granted | pf_payment_id | amount_gross | product
 *
 *   "Tool Events" - anonymous funnel tracking from the RichLab quick advert
 *   checker. Deliberately privacy-light: no raw IP, no advert content, no
 *   personal details - just enough to see how many people move from the free
 *   tool into the Business Check.
 *     timestamp | event | source | campaign | page | session_id |
 *     ip_hash | user_agent_summary
 *
 *   "PromoCodes" (managed manually) / "PromoRedemptions" (app-written) -
 *   unchanged from before.
 */

let sheetsClient = null;

function getClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

export function hashIp(ip) {
  if (!ip) return "";
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/** Very small best-effort UA summary - browser + OS only, never the raw string. */
export function summarizeUserAgent(ua) {
  if (!ua || typeof ua !== "string") return "";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Other";
  const os = /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Mac OS/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Other";
  return `${browser}/${os}`;
}

export async function appendCheckRow(row) {
  const sheets = getClient();
  const values = [[
    row.timestamp,
    row.phone || "",
    row.email || "",
    row.nameChecked || "",
    row.companyChecked || "",
    row.town || "",
    row.reason || "",
    row.status,
    row.message,
    row.consentVersion || "",
    row.ip || "",
    row.source || "direct",
    row.userType || "",
    row.creditSource || "free",
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!A:N",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

export async function appendMarketingConsent(row) {
  const sheets = getClient();
  const values = [[row.timestamp, row.phone || "", row.email || "", row.marketingConsent ? "yes" : "no", row.consentVersion || ""]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Marketing!A:E",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

export async function recordSubscriptionEvent(row) {
  const sheets = getClient();
  const values = [[row.timestamp, row.phone || "", row.email || "", row.paymentStatus || "", row.amountGross || "", row.pfPaymentId || "", row.itemName || ""]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Subscriptions!A:G",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/** Dedup check: has this exact PayFast payment already been credited? */
export async function getCreditPurchaseByPaymentId(pfPaymentId) {
  if (!pfPaymentId) return null;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "CreditPurchases!A:F",
  });
  const rows = res.data.values || [];
  return rows.slice(1).find((r) => r[3] === pfPaymentId) || null;
}

/** Records a VERIFIED, non-duplicate Business Check bundle payment. */
export async function appendCreditPurchase(row) {
  const sheets = getClient();
  const values = [[row.timestamp, row.phone || "", row.creditsGranted, row.pfPaymentId || "", row.amountGross || "", row.product || "check_bundle"]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "CreditPurchases!A:F",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/** All-time total credits ever purchased by this phone (bundles don't expire monthly). */
export async function getPaidCreditsPurchasedTotal(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "CreditPurchases!A:F",
  });
  const rows = res.data.values || [];
  return rows.slice(1).reduce((total, r) => (r[1] === phone ? total + (Number(r[2]) || 0) : total), 0);
}

/** All-time count of Checks rows that drew on a paid credit for this phone. */
export async function getPaidCreditsUsedTotal(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!B:N",
  });
  const rows = res.data.values || [];
  // B is index 0 in this narrowed range, N is index 12
  return rows.slice(1).filter((r) => r[0] === phone && (r[12] || "") === "paid").length;
}

/** This-calendar-month count of Checks rows that drew on a promo credit for this phone. */
export async function getPromoChecksUsedThisMonth(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!A:N",
  });
  const rows = res.data.values || [];
  const now = new Date();
  return rows.slice(1).filter((r) => {
    if (r[1] !== phone) return false;
    if ((r[13] || "") !== "promo") return false;
    const d = new Date(r[0]);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
}

/** This-calendar-month count of Checks rows that drew on the free allowance (blank credit_source = old rows = free). */
export async function getFreeChecksUsedThisMonth(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!A:N",
  });
  const rows = res.data.values || [];
  const now = new Date();
  return rows.slice(1).filter((r) => {
    if (r[1] !== phone) return false;
    const creditSource = r[13] || "free";
    if (creditSource !== "free") return false;
    const d = new Date(r[0]);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
}

export async function appendToolEvent(row) {
  const sheets = getClient();
  const values = [[row.timestamp, row.event, row.source || "", row.campaign || "", row.page || "", row.sessionId || "", row.ipHash || "", row.userAgentSummary || ""]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Tool Events!A:H",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

export async function getPromoCode(code) {
  if (!code) return null;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "PromoCodes!A:G",
  });
  const rows = res.data.values || [];
  const normalizedCode = code.trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const [rowCode, extraScans, maxRedemptions, timesRedeemed, expiryDate, active, codeType] = rows[i];
    if ((rowCode || "").trim().toLowerCase() === normalizedCode) {
      return {
        rowNumber: i + 1,
        code: rowCode,
        extraScans: Number(extraScans) || 0,
        maxRedemptions: maxRedemptions === "" || maxRedemptions == null ? null : Number(maxRedemptions),
        timesRedeemed: Number(timesRedeemed) || 0,
        expiryDate: expiryDate || null,
        active: (active || "").trim().toLowerCase() !== "no",
        codeType: (codeType || "scans").trim().toLowerCase() === "summary" ? "summary" : "scans",
      };
    }
  }
  return null;
}

export async function incrementPromoRedemption(rowNumber, newCount) {
  const sheets = getClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `PromoCodes!D${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newCount]] },
  });
}

export async function appendPromoRedemption(row) {
  const sheets = getClient();
  const values = [[row.timestamp, row.phone || "", row.code || "", row.extraScansGranted || 0, row.codeType || "scans"]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "PromoRedemptions!A:E",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

export async function getExtraScansThisMonth(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "PromoRedemptions!A:E",
  });
  const rows = res.data.values || [];
  const now = new Date();
  return rows.slice(1).reduce((total, r) => {
    const [timestamp, rowPhone, , extraScansGranted, codeType] = r;
    if (rowPhone !== phone) return total;
    if ((codeType || "scans").trim().toLowerCase() !== "scans") return total;
    const d = new Date(timestamp);
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) return total;
    return total + (Number(extraScansGranted) || 0);
  }, 0);
}

export async function getExtraSummaryUnlocksThisMonth(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "PromoRedemptions!A:E",
  });
  const rows = res.data.values || [];
  const now = new Date();
  return rows.slice(1).reduce((total, r) => {
    const [timestamp, rowPhone, , extraGranted, codeType] = r;
    if (rowPhone !== phone) return total;
    if ((codeType || "").trim().toLowerCase() !== "summary") return total;
    const d = new Date(timestamp);
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) return total;
    return total + (Number(extraGranted) || 0);
  }, 0);
}

export async function isSubscribedThisMonth(phone) {
  if (!phone) return false;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Subscriptions!A:D",
  });
  const rows = res.data.values || [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  return rows.slice(1).some((r) => {
    const [timestamp, rowPhone, , paymentStatus] = r;
    if (rowPhone !== phone) return false;
    if ((paymentStatus || "").trim().toUpperCase() !== "COMPLETE") return false;
    const d = new Date(timestamp);
    return d >= cutoff;
  });
}

export async function countChecksThisMonth(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!A:B",
  });
  const rows = res.data.values || [];
  const now = new Date();
  return rows.filter((r) => {
    const [timestamp, rowPhone] = r;
    if (rowPhone !== phone) return false;
    const d = new Date(timestamp);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
}
