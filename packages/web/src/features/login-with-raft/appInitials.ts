/** Up to two letters for an App without a logo: its first two words' initials, or its first two letters. */
export function initialsForApp(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "A";
  const second = parts[1];
  return (second ? `${first[0]}${second[0]}` : first.slice(0, 2)).toUpperCase();
}
