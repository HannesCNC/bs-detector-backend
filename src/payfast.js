import crypto from "crypto";

/**
 * PayFast sends a server-to-server POST ("ITN" - Instant Transaction
 * Notification) whenever a payment's status changes. This is the ONLY
 * signal that should ever be trusted to mark a payment as paid - never the
 * browser redirect PayFast sends the user to afterwards, since a user could
 * just visit that "success" URL directly without paying.
 *
 * This module implements PayFast's documented ITN validation steps:
 *   1. Verify the signature (MD5 hash) matches what PayFast would have sent
 *   2. Confirm the amount matches what we expected to charge
 *   3. Call PayFast back (server-to-server) to confirm the data is genuine
 *
 * Reference: https://developers.payfast.co.za/docs#step_4_confirm_payment
 */

const PAYFAST_VALIDATE_URL = process.env.PAYFAST_SANDBOX === "true"
  ? "https://sandbox.payfast.co.za/eng/query/validate"
  : "https://www.payfast.co.za/eng/query/validate";

const PAYFAST_PROCESS_URL = process.env.PAYFAST_SANDBOX === "true"
  ? "https://sandbox.payfast.co.za/eng/process"
  : "https://www.payfast.co.za/eng/process";

/**
 * PayFast is a PHP system and computes its own side of the signature using
 * PHP's urlencode() rules - which is NOT the same as JavaScript's
 * encodeURIComponent(). urlencode() also escapes ! ' ( ) * (encodeURIComponent
 * leaves those six characters alone) and uses "+" for spaces rather than %20.
 */
function pfEncode(value) {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function buildParamString(fields, passphrase) {
  const paramString = Object.keys(fields)
    .filter((key) => fields[key] !== undefined && fields[key] !== "")
    .map((key) => `${key}=${pfEncode(fields[key])}`)
    .join("&");
  return passphrase ? `${paramString}&passphrase=${pfEncode(passphrase)}` : paramString;
}

/**
 * Builds the signed field set for a PayFast checkout. The front-end posts
 * these fields (as a plain HTML form, not fetch/JSON - PayFast expects a
 * real form submission that redirects the browser) to processUrl.
 *
 * custom_str1 carries the phone number through so the ITN webhook later
 * knows which phone number the payment belongs to.
 *
 * custom_str2 is an optional product tag, e.g. "credit_bundle" - lets the
 * ITN webhook tell a Business Check bundle purchase apart from the legacy
 * recurring-subscriber purchase, which has no custom_str2 (undefined/blank).
 */
export function buildCheckoutFields({ phone, amount, itemName, returnUrl, cancelUrl, notifyUrl, productTag }) {
  const fields = {
    merchant_id: process.env.PAYFAST_MERCHANT_ID,
    merchant_key: process.env.PAYFAST_MERCHANT_KEY,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    notify_url: notifyUrl,
    amount: Number(amount).toFixed(2),
    item_name: itemName,
    custom_str1: phone,
  };

  if (productTag) {
    fields.custom_str2 = productTag;
  }

  const passphrase = process.env.PAYFAST_PASSPHRASE || "";
  const withPassphrase = buildParamString(fields, passphrase);
  fields.signature = crypto.createHash("md5").update(withPassphrase).digest("hex");

  return { fields, processUrl: PAYFAST_PROCESS_URL };
}

/**
 * Recomputes the MD5 signature from the posted fields and compares it to
 * the "signature" field PayFast included. Returns rich debug info alongside
 * the boolean result so a mismatch can be diagnosed from logs without
 * needing to reproduce it separately - this was added after a live signature
 * mismatch that was hard to pin down from a plain true/false result.
 */
function verifySignature(fields) {
  const { signature, ...rest } = fields;
  if (!signature) return { valid: false, reason: "No signature field present in notification." };

  const passphrase = process.env.PAYFAST_PASSPHRASE || "";
  const paramString = buildParamString(rest, passphrase);
  const computed = crypto.createHash("md5").update(paramString).digest("hex");

  return {
    valid: computed === signature,
    debug: {
      receivedSignature: signature,
      computedSignature: computed,
      paramStringUsed: paramString,
      passphraseWasSet: Boolean(passphrase),
    },
  };
}

/**
 * Calls PayFast's own server to confirm the ITN data is genuine and wasn't
 * spoofed. This is the step that actually closes the "fake a payment" hole -
 * signature verification alone can be sufficient if the passphrase is kept
 * secret, but this second check is PayFast's own recommended belt-and-braces
 * step and costs little.
 */
async function confirmWithPayFast(rawBody) {
  try {
    const res = await fetch(PAYFAST_VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: rawBody,
    });
    const text = (await res.text()).trim();
    return text === "VALID";
  } catch (err) {
    console.error("PayFast server-to-server validation failed:", err.message);
    return false;
  }
}

/**
 * Full verification: signature + PayFast server confirmation.
 * expectedAmount is optional but strongly recommended - pass the amount
 * (in Rand, as a string like "199.00") you expected to charge, so a
 * tampered/replayed notification for a different amount can't sneak through.
 */
export async function verifyPayFastNotification(fields, rawBody, expectedAmount) {
  const sigResult = verifySignature(fields);
  if (!sigResult.valid) {
    return { valid: false, reason: "Signature mismatch - notification may be forged.", debug: sigResult.debug };
  }

  if (expectedAmount && fields.amount_gross && fields.amount_gross !== expectedAmount) {
    return { valid: false, reason: `Amount mismatch: expected ${expectedAmount}, got ${fields.amount_gross}.` };
  }

  const confirmed = await confirmWithPayFast(rawBody);
  if (!confirmed) {
    return { valid: false, reason: "PayFast server-to-server confirmation failed." };
  }

  return { valid: true };
}
