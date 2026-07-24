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
 *   reason | status | message | consent_version | ip
 *
 * Marketing tab:
 *   timestamp | phone | email | marketing_consent | consent_version
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
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Checks!A:K",
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
