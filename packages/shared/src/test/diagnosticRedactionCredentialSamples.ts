/**
 * Known credential samples every producer must mask before it may upload.
 * Exported so each surface's test asserts the SAME list rather than its own
 * abbreviated one (the transcript path's gap was exactly a sample nobody had
 * written down). Synthetic, and test-only: it lives under `test/` so the
 * source-available export's secret scans never see credential-shaped strings
 * in shipped source.
 */
// Built at runtime so secret scanners don't flag this test sample.
const AKIA = "AK" + "IA";
const ASIA = "AS" + "IA";
const GHP = "gh" + "p_";
const GITHUB_PAT = "github" + "_pat_";
const XOXB = "xo" + "xb-";
const AIZA = "AI" + "za";
const YA29 = "ya" + "29.";
const JWT_HEAD = "ey" + "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
const GOCSPX = "GOC" + "SPX-";
const GOOGLE_REFRESH = "1/" + "/0g";
const HF = "h" + "f_";
const GLPAT = "gl" + "pat-";
const NPM = "np" + "m_";
const RK_LIVE = "r" + "k_live_";
const RK_TEST = "r" + "k_test_";
/** The PEM private-key BEGIN header line, assembled at runtime for the same reason. */
export const PEM_PRIVATE_KEY_BEGIN = "-----BEGIN " + "PRIVATE KEY-----";

export const DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES: readonly { label: string; sample: string; mustNotContain: string }[] = [
  { label: "bare JWT without Bearer", sample: "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.dGVzdHNpZ25hdHVyZQ", mustNotContain: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
  { label: "Bearer token", sample: "Authorization: Bearer abcDEF123456_secret-token", mustNotContain: "abcDEF123456_secret-token" },
  { label: "Authorization header without scheme", sample: `authorization: ${XOXB}1234-ABCDEFGHIJKLMNOP`, mustNotContain: `${XOXB}1234-ABCDEFGHIJKLMNOP` },
  { label: "PEM private key block", sample: `${PEM_PRIVATE_KEY_BEGIN}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----`, mustNotContain: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7" },
  { label: "Raft agent key", sample: "using sk_agent_9f7c12d7abcdef0123456789", mustNotContain: "sk_agent_9f7c12d7abcdef0123456789" },
  { label: "Raft sap key", sample: "sap_ZZZ111aaa222bbb", mustNotContain: "sap_ZZZ111aaa222bbb" },
  { label: "api_key pair", sample: `api_key="${AKIA}IOSFODNN7EXAMPLE"`, mustNotContain: `${AKIA}IOSFODNN7EXAMPLE` },
  { label: "URL query token", sample: "GET https://api.example.test/v1/thing?access_token=abc123secret&x=1", mustNotContain: "abc123secret" },
  { label: "URL basic auth", sample: "https://user:p4ssw0rd@host.example.test/path", mustNotContain: "p4ssw0rd" },
  // Kabi's #263 R6 corpus (2026-09-15): these three still passed through.
  { label: "GitHub classic token", sample: `GITHUB_TOKEN=${GHP}AbCdEf0123456789AbCdEf0123456789abcd`, mustNotContain: `${GHP}AbCdEf0123456789AbCdEf0123456789abcd` },
  { label: "AWS access key id", sample: `aws_access_key_id = ${AKIA}IOSFODNN7EXAMPLE`, mustNotContain: `${AKIA}IOSFODNN7EXAMPLE` },
  { label: "AWS secret access key", sample: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", mustNotContain: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  // Jianwei (#7791 review): the id rule pinned the 20-char example only; the
  // IAM contract is 16–128 chars.
  { label: "AWS access key id (17 chars)", sample: `key ${AKIA}IOSFODNN7EXAM`, mustNotContain: `${AKIA}IOSFODNN7EXAM` },
  { label: "AWS access key id (24 chars)", sample: `key ${AKIA}IOSFODNN7EXAMPLEABCD`, mustNotContain: `${AKIA}IOSFODNN7EXAMPLEABCD` },
  { label: "AWS STS temporary key id (24 chars)", sample: `key ${ASIA}IOSFODNN7EXAMPLEABCD`, mustNotContain: `${ASIA}IOSFODNN7EXAMPLEABCD` },
  // Kabi (#263 R6, 07:03Z): bare keys in log text, not next to a NAME= assignment.
  { label: "Google API key bare in a URL-less log line", sample: `request rejected for key ${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q`, mustNotContain: `${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q` },
  { label: "Google API key ending in '-' before a space", sample: `key ${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6- rejected`, mustNotContain: `${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6-` },
  { label: "Google API key ending in '_' at end of line", sample: `key ${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6_`, mustNotContain: `${AIZA}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6_` },
  { label: "xAI API key bare in a log line", sample: "provider rejected token xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 (401)", mustNotContain: "xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
  { label: "GitHub fine-grained token", sample: `token ${GITHUB_PAT}11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`, mustNotContain: `${GITHUB_PAT}11ABCDEFG0123456789` },
  { label: "OpenAI project key", sample: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", mustNotContain: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
  { label: "Slack bot token", sample: `${XOXB}1234567890-abcdefghijklmnop`, mustNotContain: `${XOXB}1234567890-abcdefghijklmnop` },
  { label: "camelCase authToken in JSON", sample: '{"authToken":"tok_ABC123def456"}', mustNotContain: "tok_ABC123def456" },
  // Security review of the runtime error excerpt (2026-11): shapes its
  // scrubber let through. Each surface's test asserts these too.
  { label: "JSON-quoted api_key", sample: 'Error: 401 {"api_key": "Zq81mNw2Lp0x"}', mustNotContain: "Zq81mNw2Lp0x" },
  { label: "JSON-quoted token, no space", sample: '{"token":"tq.82Hd-1x"}', mustNotContain: "tq.82Hd-1x" },
  { label: "JSON-quoted password with spaces", sample: '{"password": "correct horse battery"}', mustNotContain: "horse" },
  { label: "JSON-quoted secret", sample: '{"secret": "s3cr3tValue"}', mustNotContain: "s3cr3tValue" },
  { label: "JSON-quoted access_token", sample: '{"access_token": "at-9f8e7d6c"}', mustNotContain: "at-9f8e7d6c" },
  { label: "JSON-quoted refresh_token", sample: '{"refresh_token": "rt-1a2b3c4d"}', mustNotContain: "rt-1a2b3c4d" },
  { label: "JSON-quoted client_secret, JSON-escaped", sample: String.raw`{\"client_secret\":\"cs-5e6f7a8b\"}`, mustNotContain: "cs-5e6f7a8b" },
  { label: "JSON-quoted SecretAccessKey", sample: '{"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', mustNotContain: "wJalrXUtnFEMI" },
  { label: "Authorization: Basic", sample: "Authorization: Basic dXNlcjpodW50ZXIy", mustNotContain: "dXNlcjpodW50ZXIy" },
  { label: "Basic credentials outside a header", sample: "curl: (22) 401 with Basic dXNlcjpwYXNz", mustNotContain: "dXNlcjpwYXNz" },
  { label: "bare JWT in an error", sample: `401: jwt ${JWT_HEAD}.eyJzdWIiOiIxIn0.c2ln expired`, mustNotContain: JWT_HEAD },
  { label: "Google OAuth access token", sample: `token ${YA29}a0AfB_byC1d2E3f4G5h6I7j8K9 rejected`, mustNotContain: `${YA29}a0AfB_byC1d2E3f4G5h6I7j8K9` },
  { label: "--api-key flag, space", sample: "spawn claude --api-key Zq81mNw2Lp0x --verbose", mustNotContain: "Zq81mNw2Lp0x" },
  { label: "--api-key flag, equals", sample: "spawn claude --api-key=Zq81mNw2Lp0x", mustNotContain: "Zq81mNw2Lp0x" },
  { label: "--token flag", sample: "gh auth --token abcdEFGH1234", mustNotContain: "abcdEFGH1234" },
  { label: "--password flag, quoted", sample: 'db --password "correct horse"', mustNotContain: "horse" },
  { label: "--client-secret flag", sample: "oauth --client-secret cs9 --x", mustNotContain: "cs9" },
  { label: "--auth flag", sample: "proxy --auth u1:p2 up", mustNotContain: "u1:p2" },
  // Adversarial review of #14933 (2026-11).
  { label: "Raft key after a JSON-escaped newline", sample: String.raw`{"msg":"line1\nsk_agent_ABCDEF123456"}`, mustNotContain: "ABCDEF123456" },
  { label: "Raft key after a URL escape", sample: "key%3Dsk_agent_ABCDEF123456", mustNotContain: "ABCDEF123456" },
  { label: "Raft sap key after an escaped newline", sample: String.raw`\nsap_ABCDEFGH1234`, mustNotContain: "ABCDEFGH1234" },
  { label: "AWS key id after an escaped newline", sample: String.raw`"\n${AKIA}IOSFODNN7EXAMPLE"`, mustNotContain: `${AKIA}IOSFODNN7EXAMPLE` },
  { label: "Bearer after an escaped newline", sample: String.raw`\nBearer abcdEFGH12345678`, mustNotContain: "abcdEFGH12345678" },
  { label: "JWT after an escaped tab", sample: String.raw`\t${JWT_HEAD}.eyJzdWIiOiIxIn0.c2ln`, mustNotContain: JWT_HEAD },
  { label: "--password after an escaped newline", sample: String.raw`\n--password hunter2!`, mustNotContain: "hunter2" },
  { label: "quoted value with an apostrophe", sample: `{"password": "it's secret value"}`, mustNotContain: "secret value" },
  { label: "quoted value with an escaped quote", sample: String.raw`{"password":"p\"ASSTAIL"}`, mustNotContain: "ASSTAIL" },
  { label: "quoted value with a unicode-escaped quote", sample: '{"api_key":"xxxxx\\u0022SECRETAFTERESCAPE"}', mustNotContain: "SECRETAFTERESCAPE" },
  { label: "quoted value with a stray raw quote", sample: '{"api_key":"xxxxx"SECRETAFTERQUOTE"}', mustNotContain: "SECRETAFTERQUOTE" },
  { label: "quoted value with escaped slashes", sample: String.raw`{"client_secret":"ab\/cd\\ef\/SECRETTAIL"}`, mustNotContain: "SECRETTAIL" },
  { label: "inner JSON value with an escaped quote", sample: String.raw`{\"password\":\"p\\\"ASSTAIL\"}`, mustNotContain: "ASSTAIL" },
  { label: "credentials name", sample: `{"credentials": "c9-SECRETVAL"}`, mustNotContain: "c9-SECRETVAL" },
  { label: "Google OAuth client secret", sample: `client ${GOCSPX}AbCdEfGhIjKlMnOpQrStUv12 rejected`, mustNotContain: `${GOCSPX}AbCdEfGhIjKlMnOpQrStUv12` },
  { label: "Google OAuth refresh token", sample: `refresh ${GOOGLE_REFRESH}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-x failed`, mustNotContain: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" },
  { label: "connection-string password", sample: "connect ECONNREFUSED postgres://app:hunter2@db:5432/x", mustNotContain: "hunter2" },
  { label: "connection-string password, empty user", sample: "redis://:pw42xyz@host:6379", mustNotContain: "pw42xyz" },
  // Tenny's review of #14933 (2026-11): cookies, more token prefixes, YAML
  // block values and connection-string passwords with an unencoded `/`.
  { label: "Cookie header", sample: "GET /x Cookie: session=CK1sessval99; theme=dark", mustNotContain: "CK1sessval99" },
  { label: "Cookie header, later cookie", sample: "cookie: theme=dark; sid=CK2sidval88", mustNotContain: "CK2sidval88" },
  { label: "Set-Cookie header", sample: "Set-Cookie: sid=CK3setval77; Path=/; HttpOnly", mustNotContain: "CK3setval77" },
  { label: "JSON cookie header", sample: '{"headers": {"cookie": "sid=CK4jsonval66; theme=dark"}}', mustNotContain: "CK4jsonval66" },
  { label: "JSON set-cookie list", sample: '{"set-cookie": ["a=CK5first; Path=/", "b=CK6second; Secure"]}', mustNotContain: "CK6second" },
  { label: "Node-inspected set-cookie list", sample: "headers: { 'set-cookie': [ 'a=CK7nodeval; Path=/' ] }", mustNotContain: "CK7nodeval" },
  { label: "Hugging Face token", sample: `pull failed for ${HF}AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh`, mustNotContain: `${HF}AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh` },
  { label: "GitLab personal access token", sample: `remote: ${GLPAT}AbCdEf0123456789_-xy rejected`, mustNotContain: `${GLPAT}AbCdEf0123456789_-xy` },
  { label: "npm token", sample: `//registry.npmjs.org/:_authToken=${NPM}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789`, mustNotContain: `${NPM}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789` },
  { label: "Stripe restricted live key", sample: `stripe error for ${RK_LIVE}51HqAbCdEfGhIjKlMnOpQrStUv`, mustNotContain: `${RK_LIVE}51HqAbCdEfGhIjKlMnOpQrStUv` },
  { label: "Stripe restricted test key", sample: `key ${RK_TEST}51HqAbCdEfGhIjKlMnOpQrStUv`, mustNotContain: `${RK_TEST}51HqAbCdEfGhIjKlMnOpQrStUv` },
  { label: "YAML block secret, literal", sample: "config:\n  private_key: |\n    YAMLBLOCKLINE1\n    YAMLBLOCKLINE2\n  user: bob", mustNotContain: "YAMLBLOCKLINE2" },
  { label: "YAML block secret, folded with chomping", sample: "db:\n  password: >-\n    YAMLFOLDEDPW\n  host: db", mustNotContain: "YAMLFOLDEDPW" },
  { label: "connection-string password with /", sample: "connect postgres://app:SLASHPWL/SLASHPWR@db.example.com:5432/x", mustNotContain: "SLASHPWL" },
  // Adversarial review of #14963.
  { label: "YAML block secret in a sequence item", sample: "users:\n- password: |\n    YAMLLISTPW\n  name: bob", mustNotContain: "YAMLLISTPW" },
  { label: "YAML block secret with a tag", sample: "config:\n  password: !!binary |\n    YAMLTAGPW\n  next: 1", mustNotContain: "YAMLTAGPW" },
  { label: "GitLab deploy token", sample: `deploy ${"gl" + "dt-"}AbCdEf0123456789_-xy failed`, mustNotContain: `${"gl" + "dt-"}AbCdEf0123456789_-xy` },
  { label: "doubly escaped JSON cookie", sample: String.raw`{\\\"cookie\\\":\\\"sid=CK8deepval\\\"}`, mustNotContain: "CK8deepval" },
  { label: "http password with /", sample: "fetch http://u:HTTPSLASHL/HTTPSLASHR@10.0.0.1/x failed", mustNotContain: "HTTPSLASHL" },
  { label: "connection-string password with / and @", sample: "mongodb://u:AT/PW@RIGHT@cluster0.example.net/db", mustNotContain: "PW@RIGHT" },
];
