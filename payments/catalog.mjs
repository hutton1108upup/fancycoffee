/**
 * Local payment contract for Fancy Cafe AI.
 *
 * This is the application's source of truth for one-time credit packs. It
 * contains no Waffo product IDs and never creates a checkout session.
 */
export const PAYMENT_MODE = 'unconfigured';
export const CURRENCY = 'USD';

export const CREDIT_PACKS = Object.freeze([
  Object.freeze({ id: 'credits-20', name: '20 credits', credits: 20, amountCents: 999, currency: CURRENCY, billingType: 'one_time' }),
  Object.freeze({ id: 'credits-60', name: '60 credits', credits: 60, amountCents: 2499, currency: CURRENCY, billingType: 'one_time' }),
  Object.freeze({ id: 'credits-200', name: '200 credits', credits: 200, amountCents: 6999, currency: CURRENCY, billingType: 'one_time' }),
]);

export function getCreditPack(packId) {
  return CREDIT_PACKS.find((pack) => pack.id === packId) ?? null;
}

export function listCreditPacks() {
  return CREDIT_PACKS.map((pack) => ({ ...pack }));
}
