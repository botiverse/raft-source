// App names that read as Raft itself (#proj-apps:#69).
//
// Raft shows an App's name as the speaker of its own surfaces: a card action's
// toast and confirm dialog read "{App name}: …". An App called "Raft" (or
// "R a f t", "Rаft" with a Cyrillic а, "Raft Official") would make its text
// read as Raft's own. Only Apps on an official publisher Server may use such a
// name; the Server enforces it where an App is created or renamed
// (oauthService.assertAppNameAllowed).

/** Brand words an App outside an official publisher may not be named after. */
export const RESERVED_APP_NAME_BRANDS = ["raft", "slock", "botiverse"] as const;
/**
 * What a reserved name reads as: one of the brands, or "official" for a name
 * made only of role words around "official" ("Official Support Bot"), which
 * reads as the platform speaking without naming it.
 */
export type ReservedAppNameBrand = (typeof RESERVED_APP_NAME_BRANDS)[number] | "official";

/**
 * Role words that, around a brand word, still read as the brand speaking:
 * "Raft Bot", "Official Raft", "Raft Billing", "Raft Security Team". Any number
 * of them, in any order, before and after the brand. A name with any other
 * word ("Raft Notes Sync", "Life Raft Tracker") is the App's own and stays
 * allowed. Written already folded (foldAppName), with no spaces, so a folded
 * name is matched by splitting it into these words.
 */
const ROLE_WORDS: ReadonlySet<string> = new Set([
  "the", "real", "my", "your", "official", "verified",
  "app", "apps", "bot", "bots", "robot", "team", "teams", "admin", "admins", "administrator", "system", "systems",
  "support", "help", "helpdesk", "desk", "center", "centre", "care", "customer", "customers", "contact",
  "notification", "notifications", "notify", "notifier", "noreply", "alert", "alerts", "update", "updates",
  "news", "announcement", "announcements", "status", "assistant", "assistants", "agent", "agents", "hq",
  "staff", "service", "services", "platform", "security", "safety", "trust", "account", "accounts", "ai",
  "inc", "corp", "billing", "bill", "bills", "payment", "payments", "pay", "finance", "invoice", "invoices",
  "legal", "compliance", "ops", "operations", "verify", "verification", "auth", "login", "signin", "sso",
  "identity", "moderator", "moderators", "mod", "mods", "moderation", "review", "reviews", "it", "hr",
  "官方", "系统", "助手", "小助手", "团队", "通知", "公告", "安全", "客服", "管理员", "账单", "计费", "支付",
  "审核", "机器人", "中心", "服务", "支持",
]);

/**
 * Characters that look like a Latin letter once case and accents are gone and
 * that NFKC does not fold: digits and symbols used as letters, letters of
 * other scripts, and small capitals. Only what can spell a brand word (or
 * "official") matters. A letter of another script that is not here still
 * cannot slip a brand through: see `foldAppNameForMatch`.
 */
const LETTER_LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "к": "k", "т": "t", "г": "r", "ѕ": "s", "і": "i", "ӏ": "l", "в": "b", "ғ": "f",
  "ԁ": "d", "һ": "h", "ј": "j", "ԛ": "q", "ѵ": "v", "ԝ": "w", "х": "x", "у": "y", "ӓ": "a", "ё": "e", "ї": "i", "ӧ": "o", "ꙅ": "s",
  // Greek
  "α": "a", "ο": "o", "τ": "t", "ρ": "p", "κ": "k", "ι": "i", "ε": "e", "ϝ": "f", "β": "b", "ν": "v", "υ": "u", "χ": "x", "ϲ": "c", "ϳ": "j",
  // Armenian
  "օ": "o", "ս": "u", "ց": "g", "զ": "q", "հ": "h", "ո": "n", "ւ": "l", "ք": "f",
  // Cherokee (lower-cased forms)
  "ꭺ": "a", "ꮯ": "c", "ꭼ": "e", "ꮋ": "h", "ꮖ": "i", "ꮶ": "k", "ꮮ": "l", "ꮇ": "m", "ꮎ": "o", "ꮲ": "p", "ꭱ": "r", "ꮪ": "s", "ꭲ": "t", "ꮩ": "v", "ꮃ": "w",
  // Latin small capitals, IPA and other look-alike letters
  "ʀ": "r", "ᴀ": "a", "ꜰ": "f", "ᴛ": "t", "ꜱ": "s", "ʟ": "l", "ᴏ": "o", "ᴄ": "c", "ᴋ": "k", "ʙ": "b", "ᴇ": "e", "ɪ": "i", "ᴠ": "v",
  "ƒ": "f", "ſ": "s", "ı": "i", "ɑ": "a", "ɾ": "r", "ɼ": "r", "ɽ": "r", "ȶ": "t", "ƭ": "t", "ɩ": "i", "ɫ": "l", "ɭ": "l", "ꞁ": "l",
  "ɡ": "g", "ɢ": "g", "ʜ": "h", "ɴ": "n", "ᴘ": "p", "ʏ": "y", "ᴜ": "u", "ᴡ": "w", "ᴢ": "z", "ɒ": "a", "ɐ": "a", "ɔ": "c", "ø": "o", "ɵ": "o",
};

/**
 * Digits and symbols written for letters ("R4FT", "R@ft"). Read both ways
 * (reservedAppNameBrand): mapped, and dropped as punctuation, so "Raft!" or
 * "Raft @" can't escape by turning a trailing mark into a letter.
 */
const SYMBOL_LOOKALIKES: Readonly<Record<string, string>> = {
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "|": "l", "!": "l",
};

/** Scripts whose letters are never read as Latin look-alikes: a Chinese or Japanese word next to "Raft" stays a word. */
const NON_CONFUSABLE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
/** Stands for a letter of another script that may be a look-alike nobody listed (foldAppNameForMatch). */
const UNKNOWN_LOOKALIKE = "\u0000";

function fold(name: string, symbolsAsLetters: boolean, unknownLookalikes: boolean): string {
  const base = name.normalize("NFKC").toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "");
  let out = "";
  for (const ch of base) {
    const mapped = LETTER_LOOKALIKES[ch] ?? (symbolsAsLetters ? SYMBOL_LOOKALIKES[ch] : undefined) ?? ch;
    if (!/[\p{L}\p{N}]/u.test(mapped)) continue;
    if (unknownLookalikes && !/^[a-z0-9]$/.test(mapped) && !NON_CONFUSABLE_SCRIPT.test(mapped)) out += UNKNOWN_LOOKALIKE;
    else out += mapped;
  }
  return out;
}

/**
 * A name reduced to how it reads: compatibility forms folded (full-width,
 * mathematical letters), lower case, accents dropped, look-alike characters
 * replaced (and, with `symbolsAsLetters`, digits and symbols used as
 * letters), and everything that is not a letter or digit removed (spaces,
 * punctuation, zero-width and emoji).
 */
export function foldAppName(name: string, options: { symbolsAsLetters?: boolean } = {}): string {
  return fold(name, options.symbolsAsLetters ?? false, false);
}

/**
 * Whether `word` is spelled at `at` in a folded name. A letter of another
 * script nobody listed (UNKNOWN_LOOKALIKE) may stand for any letter, but at
 * least half of the word's letters must be spelled out, so a name written
 * wholly in another script never matches.
 */
function spelledAt(folded: string, at: number, word: string): boolean {
  if (at + word.length > folded.length) return false;
  let exact = 0;
  for (let i = 0; i < word.length; i++) {
    const ch = folded[at + i];
    if (ch === word[i]) exact++;
    else if (ch !== UNKNOWN_LOOKALIKE) return false;
  }
  return exact * 2 >= word.length;
}

const LONGEST_ROLE_WORD = Math.max(...[...ROLE_WORDS].map((word) => word.length));

/**
 * For every cut i of a folded name: whether folded[0, i) is made only of role
 * words (prefix[i]) and whether folded[i, end) is (suffix[i]). Each word is at
 * most LONGEST_ROLE_WORD long, so this is linear in the name's length, and so
 * is checking every brand position against it: a long name costs no more
 * than its length.
 */
function roleWordCuts(folded: string): { prefix: boolean[]; suffix: boolean[] } {
  const n = folded.length;
  const prefix = new Array<boolean>(n + 1).fill(false);
  const suffix = new Array<boolean>(n + 1).fill(false);
  prefix[0] = true;
  for (let end = 1; end <= n; end++) {
    for (let len = 1; len <= LONGEST_ROLE_WORD && len <= end && !prefix[end]; len++) {
      if (prefix[end - len] && ROLE_WORDS.has(folded.slice(end - len, end))) prefix[end] = true;
    }
  }
  suffix[n] = true;
  for (let start = n - 1; start >= 0; start--) {
    for (let len = 1; len <= LONGEST_ROLE_WORD && start + len <= n && !suffix[start]; len++) {
      if (suffix[start + len] && ROLE_WORDS.has(folded.slice(start, start + len))) suffix[start] = true;
    }
  }
  return { prefix, suffix };
}

/**
 * What a name reads as, or null. A name reads as a brand when, folded, it is
 * the brand word with only role words (any number, either side) around it:
 * "Raft", "Raft Billing", "Official Raft Bot", "Raft Security Team". A name of
 * role words only that includes "official" ("Official Support") reads as
 * "official".
 */
export function reservedAppNameBrand(name: string): ReservedAppNameBrand | null {
  const variants = [...new Set([fold(name, false, true), fold(name, true, true)])].map((folded) => ({ folded, cuts: roleWordCuts(folded) }));
  for (const { folded, cuts } of variants) {
    for (const brand of RESERVED_APP_NAME_BRANDS) {
      for (let at = 0; at + brand.length <= folded.length; at++) {
        if (cuts.prefix[at] && cuts.suffix[at + brand.length] && spelledAt(folded, at, brand)) return brand;
      }
    }
  }
  for (const { folded, cuts } of variants) {
    if (!folded.includes(UNKNOWN_LOOKALIKE) && folded.includes("official") && cuts.prefix[folded.length]) return "official";
  }
  return null;
}

export const APP_NAME_RESERVED_CODE = "APP_NAME_RESERVED";

/** The refusal sentence for a reserved name. */
export function appNameReservedMessage(brand: ReservedAppNameBrand): string {
  if (brand === "official") return "An App's name can't read as an official Raft notice; names made only of words like \"Official\", \"Support\" or \"Bot\" are kept for Raft's own Apps, so choose a name of your own.";
  const word = brand === "raft" ? "Raft" : brand === "slock" ? "Slock" : "Botiverse";
  return `An App's name can't read as "${word}"; that name and its look-alikes are kept for Raft's own Apps, so choose a name of your own.`;
}
