/**
 * A Stripe amount (minor units) in the display language's own currency format:
 * `$1,234.50` in en, `US$ 1.234,50` in pt-BR.
 */
export function formatBillingAmount(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
}
