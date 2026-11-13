import { currentRandomUnit } from "./clock";

// Classic first names for a suggested agent name (artin, 2026-10-20: the old
// "adjective-noun" pairs such as `misty-lagoon` read as noise). Short, widely
// known, ASCII letters only, capitalized like the onboarding assistant "Cindy"
// (which is deliberately not in the list). Every name, bare or paired with an
// adjective below, must pass validateAgentName; the test checks it. The name
// becomes the agent's @handle, so keep entries unambiguous; add names here,
// nowhere else.
//
// KEEP IN SYNC with botiverse/mobile `AgentNameGenerator.kt`
// (AGENT_CLASSIC_NAMES, same names, same order). Both tests pin a checksum of
// the two lists; update it in both repos when a list changes.
export const AGENT_CLASSIC_NAMES = [
  "Ada", "Adam", "Alan", "Albert", "Alice", "Amelia", "Amy", "Andrew", "Anna", "Anne",
  "Arthur", "Audrey", "Barbara", "Beatrice", "Ben", "Bella", "Benjamin", "Betty", "Bruce", "Caroline",
  "Carl", "Catherine", "Charles", "Charlotte", "Chloe", "Claire", "Clara", "Daisy", "Daniel", "David",
  "Diana", "Dorothy", "Edgar", "Edith", "Edward", "Eleanor", "Elena", "Eliza", "Ella", "Emily",
  "Emma", "Eric", "Ethan", "Eva", "Felix", "Fiona", "Frank", "George", "Grace", "Hannah",
  "Harry", "Hazel", "Helen", "Henry", "Hugo", "Ian", "Iris", "Isaac", "Isabel", "Ivy",
  "Jack", "Jacob", "James", "Jane", "Jasper", "Jean", "Jessica", "Joan", "John", "Jonathan",
  "Joseph", "Judith", "Julia", "Julian", "Kate", "Laura", "Leo", "Leon", "Lily", "Linda",
  "Lionel", "Louis", "Louise", "Lucas", "Lucy", "Luke", "Lydia", "Margaret", "Maria", "Martha",
  "Martin", "Mary", "Matthew", "Max", "Maya", "Michael", "Miles", "Molly", "Nancy", "Nathan",
  "Nina", "Noah", "Nora", "Oliver", "Olivia", "Oscar", "Owen", "Patrick", "Paul", "Peter",
  "Philip", "Rachel", "Ralph", "Rebecca", "Richard", "Robert", "Rose", "Ruby", "Ruth", "Sam",
  "Samuel", "Sarah", "Simon", "Sophia", "Sophie", "Stella", "Susan", "Thomas", "Tom", "Victor",
  "Victoria", "Vincent", "Violet", "Walter", "William", "Zoe",
] as const;

// Adjectives that tell agents with the same first name apart (artin,
// 2026-10-20: "重名了，就用形容词"): once a name is taken, the suggestion
// becomes `Swift-Leo`. Same rules as the names above.
//
// KEEP IN SYNC with botiverse/mobile `AgentNameGenerator.kt`
// (AGENT_NAME_ADJECTIVES, same words, same order).
export const AGENT_NAME_ADJECTIVES = [
  "Amber", "Bold", "Brave", "Breezy", "Bright", "Brisk", "Calm", "Candid", "Cheery", "Clever",
  "Cosmic", "Crisp", "Curious", "Daring", "Dashing", "Deft", "Eager", "Earnest", "Easy", "Fancy",
  "Fearless", "Fleet", "Fluent", "Frank", "Fresh", "Gentle", "Giddy", "Glad", "Golden", "Grand",
  "Happy", "Hardy", "Hearty", "Honest", "Humble", "Jolly", "Jovial", "Keen", "Kind", "Lively",
  "Lucid", "Lucky", "Lunar", "Mellow", "Merry", "Mighty", "Misty", "Modest", "Nimble", "Noble",
  "Patient", "Peppy", "Plucky", "Polite", "Proud", "Quick", "Quiet", "Radiant", "Rapid", "Ready",
  "Regal", "Rosy", "Rustic", "Sage", "Serene", "Sharp", "Shiny", "Silent", "Silver", "Sincere",
  "Sleek", "Smooth", "Snappy", "Solar", "Sparkly", "Spry", "Steady", "Stellar", "Sturdy", "Sunny",
  "Swift", "Tidy", "Tranquil", "Trusty", "Upbeat", "Vivid", "Warm", "Wise", "Witty", "Zesty",
] as const;

/**
 * A suggested agent name, compared case-insensitively against `exclude`
 * (names already taken by agents or members): a classic first name not yet
 * taken, picked at random (`Leo`). Once every first name is taken, an
 * adjective plus a name not yet taken (`Swift-Leo`). Only when all of those
 * are taken too does it add the first free number (`Swift-Leo2`), so the
 * suggestion never collides with a name in `exclude`.
 */
export function suggestAgentName(
  exclude: Iterable<string> = [],
  random: () => number = currentRandomUnit,
): string {
  const taken = new Set([...exclude].map((name) => name.trim().toLowerCase()));
  const pick = (pool: readonly string[]) => pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
  const isFree = (name: string) => !taken.has(name.toLowerCase());
  const names = AGENT_CLASSIC_NAMES.filter(isFree);
  if (names.length > 0) return pick(names);
  const paired = AGENT_NAME_ADJECTIVES.flatMap((adjective) => AGENT_CLASSIC_NAMES.map((name) => `${adjective}-${name}`));
  const pairs = paired.filter(isFree);
  if (pairs.length > 0) return pick(pairs);
  const base = pick(paired);
  for (let suffix = 2; ; suffix += 1) {
    if (isFree(`${base}${suffix}`)) return `${base}${suffix}`;
  }
}
