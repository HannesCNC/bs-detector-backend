import { google } from "googleapis";

/**
 * Thin wrapper around Google Sheets used as a lightweight database for the MVP.
 * Two tabs expected in the target spreadsheet:
 *   - "Checks"   : log of every scan performed (for usage limits + audit trail)
 *   - "Marketing": opt-in consent records, kept separate per the framework's
 *                  requirement that marketing consent never be bundled with
 *                  the service consent.
 *
 * Sheet columns (row 1 headers), Checks tab:
 *   timestamp | phone | email | name_checked | company_checked | town |
 *   reason | status | message | consent_version | ip | source | user_type
 *
 *   source: where the check came from, e.g. "direct" (existing Scammer Scan
 *   frontend) or "richlab" (RichLab-hosted Business Check page). Defaults to
 *   "direct" server-side if the caller doesn't send one - old rows and old
 *   frontend requests are unaffected.
 *
 *   user_type: optional organisational lead classification, one of
 *   personal | business | estate_hoa | managing_agent | security_company |
 *   other_organisation, or blank if not supplied/not recognised.
 *
 * Marketing tab:
 *   timestamp | phone | email | marketing_consent | consent_version
 *
 * Subscriptions tab (add this tab too, same header-row pattern):
 *   timestamp | phone | email | payment_status | amount_gross |
 *   pf_payment_id | item_name
 *
 * PromoCodes tab (you create/manage these rows manually):
 *   code | extra_scans | max_redemptions | times_redeemed | expiry_date | active | code_type
 *   (active = "yes"/"no" as plain text; expiry_date = YYYY-MM-DD or blank for none;
 *    code_type = "scans" or "summary" - leave blank for old codes, treated as "scans".
 *    "scans" codes grant extra checks per month; "summary" codes grant extra
 *    detailed-summary unlocks per month, beyond the base 5 free ones.)
 *
 * PromoRedemptions tab (the app writes to this automatically, don't edit):
 *   timestamp | phone | code | extra_scans_granted | code_type
 */

let sheetsClient = null;

function getClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      // Railway/most host env vars store newlines escaped - unescape them here
      private_key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
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
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!A:M",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

export async function appendMarketingConsent(row) {
  const sheets = getClient();
  const values = [[
    row.timestamp,
    row.phone || "",
    row.email || "",
    row.marketingConsent ? "yes" : "no",
    row.consentVersion || "",
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Marketing!A:E",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/**
 * Logs a VERIFIED PayFast payment notification (only ever called after
 * payfast.js has confirmed the notification is genuine - never call this
 * from unverified webhook data).
 */
export async function recordSubscriptionEvent(row) {
  const sheets = getClient();
  const values = [[
    row.timestamp,
    row.phone || "",
    row.email || "",
    row.paymentStatus || "",
    row.amountGross || "",
    row.pfPaymentId || "",
    row.itemName || "",
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Subscriptions!A:G",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
}

/**
 * Looks up a promo code. Returns null if it doesn't exist. rowNumber is
 * the actual sheet row (1-indexed, including header) so a redemption can
 * update the right cell later.
 */
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
        rowNumber: i + 1, // +1 because sheet rows are 1-indexed and this loop is 0-indexed from row 0
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

/** Bumps a promo code's times_redeemed count by 1 (column D). */
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

/** Sums extra SCAN-type promo grants for a phone this calendar month (blank code_type counts as "scans" for backward compatibility). */
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

/** Sums extra SUMMARY-unlock promo grants for a phone this calendar month. */
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

/**
 * Checks whether a phone number has a verified, recent PayFast payment on
 * record - treated as "currently subscribed" if a COMPLETE payment for that
 * phone was logged within the last 30 days. This is a simple MVP approach
 * (no real subscription start/end dates yet) - fine while there's no
 * cancellation flow; revisit once actual subscription periods matter.
 */
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

/**
 * Counts how many checks a phone number has used in the current calendar month.
 * Simple MVP approach - fine at low volume. Move to a real DB (Postgres on
 * Railway) once volume or concurrency makes repeated full-sheet reads slow.
 */
export async function countChecksThisMonth(phone) {
  if (!phone) return 0;
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!A:B",
  });

  const rows = res.data.values || [];
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`;

  return rows.filter((r) => {
    const [timestamp, rowPhone] = r;
    if (rowPhone !== phone) return false;
    const d = new Date(timestamp);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;
}
