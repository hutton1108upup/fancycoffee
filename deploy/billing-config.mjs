/**
 * Server-side billing configuration boundary.
 *
 * The request never selects the environment or provider. The Worker chooses
 * the ledger from WAFFO_MODE and the provider from BILLING_PROVIDER.
 */
export function billingMode(env = {}) {
  return env.WAFFO_MODE === 'prod' || env.WAFFO_MODE === 'production' ? 'prod' : 'test';
}

export function billingDatabase(env = {}, mode = billingMode(env)) {
  return mode === 'prod' ? env.APP_DB : env.BILLING_TEST_DB;
}

export function billingProvider(env = {}) {
  const provider = String(env.BILLING_PROVIDER || 'waffo').trim().toLowerCase();
  return provider === 'paypal' ? 'paypal' : provider === 'waffo' ? 'waffo' : 'unsupported';
}

export function paypalConfig(env = {}, mode = billingMode(env)) {
  const prefix = mode === 'prod' ? 'PAYPAL_PRODUCTION_' : 'PAYPAL_TEST_';
  const productionEnabled = mode !== 'prod' || env.PAYPAL_PRODUCTION_ENABLED === 'true';
  return {
    provider: 'paypal',
    mode,
    enabled: env.BILLING_PROVIDER === 'paypal' && productionEnabled && env.PAYPAL_ENABLED === 'true',
    baseUrl: mode === 'prod' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    clientId: env[`${prefix}CLIENT_ID`],
    clientSecret: env[`${prefix}CLIENT_SECRET`],
    merchantId: env[`${prefix}MERCHANT_ID`],
    webhookId: env[`${prefix}WEBHOOK_ID`],
  };
}

export function billingConfigStatus(env = {}) {
  const mode = billingMode(env);
  const provider = billingProvider(env);
  const db = billingDatabase(env, mode);
  const paypal = paypalConfig(env, mode);
  const missing = [];
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') missing.push(mode === 'prod' ? 'APP_DB' : 'BILLING_TEST_DB');
  if (provider === 'paypal') {
    if (!paypal.enabled) missing.push('PAYPAL_ENABLED=true');
    for (const key of ['clientId', 'clientSecret', 'merchantId', 'webhookId']) if (!paypal[key]) missing.push(key);
  } else if (provider === 'waffo') {
    if (env.WAFFO_ENABLED !== 'true') missing.push('WAFFO_ENABLED=true');
  } else if (provider === 'unsupported') missing.push('BILLING_PROVIDER=waffo|paypal');
  return { mode, provider, configured: missing.length === 0, missing };
}
