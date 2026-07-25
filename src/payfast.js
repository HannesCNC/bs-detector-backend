import crypto from "crypto";

/**
 * PayFast sends a server-to-server POST ("ITN" - Instant Transaction
 * Notification) whenever a payment's status changes. This is the ONLY
 * signal that should ever be trusted to mark a subscription as paid -
 * never the browser redirect PayFast sends the user to afterwards, since
 * a user could just visit that "success" URL directly without paying.
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

/**
 * Recomputes the MD5 signature from the posted fields and compares it to
 * the "signature" field PayFast included. If PAYFAST_PASSPHRASE is set
 * (recommended - configured in your PayFast merchant dashboard), it must
 * be included in the hash too, exactly as PayFast does on their side.
 */
function verifySignature(fields) {
  const { signature, ...rest } = fields;
  if (!signature) return false;

  const passphrase = process.env.PAYFAST_PASSPHRASE || "";

  const paramString = Object.keys(rest)
    .filter((key) => rest[key] !== undefined && rest[key] !== "")
    .map((key) => `${key}=${encodeURIComponent(rest[key]).replace(/%20/g, "+")}`)
    .join("&");

  const withPassphrase = passphrase
    ? `${paramString}&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, "+")}`
    : paramString;

  const computed = crypto.createHash("md5").update(withPassphrase).digest("hex");
  return computed === signature;
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
 * (in Rand, as a string like "199.00") you expected to charge for this
 * subscription tier, so a tampered/replayed notification for a different
 * amount can't sneak through.
 */
export async function verifyPayFastNotification(fields, rawBody, expectedAmount) {
  if (!verifySignature(fields)) {
    return { valid: false, reason: "Signature mismatch - notification may be forged." };
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
