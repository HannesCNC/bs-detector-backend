import { getPromoCode, incrementPromoRedemption, appendPromoRedemption } from "./sheets.js";

/**
 * Validates and redeems a promo code for a given phone number.
 * Returns { success: true, extraScans } on a valid redemption, or
 * { success: false, message } with a user-facing reason on failure.
 *
 * Note: this does NOT check whether this specific phone number has already
 * redeemed this code before - max_redemptions is a simple total-uses cap
 * across all users, not a per-user limit. That's fine for a first version
 * (e.g. "first 20 people to use SPRING2026 get 10 extra scans"); a
 * per-user-per-code check can be added later if needed by cross-referencing
 * PromoRedemptions by phone+code.
 */
export async function applyPromoCode({ code, phone }) {
  if (!code || !code.trim()) {
    return { success: false, message: "No promo code entered." };
  }

  const promo = await getPromoCode(code);
  if (!promo) {
    return { success: false, message: "That promo code was not recognised." };
  }

  if (!promo.active) {
    return { success: false, message: "That promo code is no longer active." };
  }

  if (promo.expiryDate) {
    const expiry = new Date(promo.expiryDate);
    if (!isNaN(expiry) && expiry < new Date()) {
      return { success: false, message: "That promo code has expired." };
    }
  }

  if (promo.maxRedemptions != null && promo.timesRedeemed >= promo.maxRedemptions) {
    return { success: false, message: "That promo code has reached its redemption limit." };
  }

  // Redeem: bump the running count on the PromoCodes tab, and log this
  // specific redemption for the monthly extra-scans calculation.
  await incrementPromoRedemption(promo.rowNumber, promo.timesRedeemed + 1);
  await appendPromoRedemption({
    timestamp: new Date().toISOString(),
    phone,
    code: promo.code,
    extraScansGranted: promo.extraScans,
  });

  return { success: true, extraScans: promo.extraScans };
}
