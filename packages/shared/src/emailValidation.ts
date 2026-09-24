export const INVALID_EMAIL_MESSAGE = "Enter a valid email address";

export function isValidEmailAddress(value: string): boolean {
  const email = value.trim();
  if (email.length === 0 || email.length > 254) return false;
  if (/\s/.test(email)) return false;

  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length === 0) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || !domain.includes(".")) return false;
  if (domain.includes("..")) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateEmailAddress(value: string): string | null {
  return isValidEmailAddress(value) ? null : INVALID_EMAIL_MESSAGE;
}
