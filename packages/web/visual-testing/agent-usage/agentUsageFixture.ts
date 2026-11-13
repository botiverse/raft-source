import type { AgentUsageResponse, AgentUsageRow } from "@botiverse/raft-shared";

// A small agent-usage fixture for the Usage tab's tests and screenshots: three
// agents over 30 UTC days, numbers taken from a real 30-day daily usage table
// (#proj-o11y:#36), agent names replaced. Days are counted back from "today"
// (0 = today, a partial day), so the fixture answers for any date.
// Claude reports no reasoning (null); Codex reports no cache write (null).

export const AGENT_USAGE_FIXTURE_AGENTS = {
  mixed: "usage-agent-mixed",
  codex: "usage-agent-codex",
  claude: "usage-agent-claude",
} as const;

type FixtureRow = [agentId: string, daysAgo: number, runtime: string, model: string, inputNew: number, cacheRead: number, cacheWrite: number | null, output: number, reasoning: number | null, turns: number];

const ROWS: FixtureRow[] = [
  ["usage-agent-claude", 29, "claude", "opus", 4344, 1119762703, 3096509, 562386, null, 531],
  ["usage-agent-claude", 28, "claude", "opus", 3946, 1102974810, 2647061, 518956, null, 471],
  ["usage-agent-claude", 27, "claude", "opus", 3438, 773108924, 2112844, 458593, null, 452],
  ["usage-agent-claude", 26, "claude", "opus", 1596, 420400955, 3018174, 250930, null, 190],
  ["usage-agent-claude", 25, "claude", "opus", 5726, 1382097147, 2521135, 836287, null, 689],
  ["usage-agent-claude", 24, "claude", "opus", 5308, 1461312173, 2311613, 833376, null, 606],
  ["usage-agent-claude", 23, "claude", "opus", 7398, 1803745508, 3324148, 1087110, null, 952],
  ["usage-agent-claude", 22, "claude", "opus", 10926, 2916584327, 4861590, 1711318, null, 1306],
  ["usage-agent-claude", 21, "claude", "opus", 4448, 1112342539, 1705562, 631170, null, 542],
  ["usage-agent-claude", 20, "claude", "opus", 6812, 1884541277, 5114601, 1126897, null, 872],
  ["usage-agent-claude", 19, "claude", "opus", 4842, 1298869405, 2035213, 685124, null, 736],
  ["usage-agent-claude", 18, "claude", "opus", 1896, 315285624, 907655, 290810, null, 251],
  ["usage-agent-claude", 17, "claude", "opus", 7328, 1744801320, 3755430, 1191676, null, 833],
  ["usage-agent-claude", 16, "claude", "opus", 9386, 1931236201, 3831050, 1211047, null, 1214],
  ["usage-agent-claude", 15, "claude", "opus", 11136, 2221312265, 3947314, 1355488, null, 1311],
  ["usage-agent-claude", 14, "claude", "opus", 9798, 1855966768, 4091636, 1214789, null, 1107],
  ["usage-agent-claude", 13, "claude", "opus", 8252, 1572870294, 2930635, 998879, null, 1004],
  ["usage-agent-claude", 12, "claude", "opus", 6220, 1188913210, 3711987, 682069, null, 877],
  ["usage-agent-claude", 11, "claude", "opus", 7368, 1327431567, 2616018, 753772, null, 1051],
  ["usage-agent-claude", 10, "claude", "opus", 7564, 1490646789, 3436145, 1067675, null, 807],
  ["usage-agent-claude", 9, "claude", "opus", 7660, 1665716824, 3573363, 1117949, null, 730],
  ["usage-agent-claude", 8, "claude", "opus", 7774, 1662113584, 3738393, 1070065, null, 734],
  ["usage-agent-claude", 7, "claude", "opus", 12796, 2695600187, 6507863, 1910850, null, 1030],
  ["usage-agent-claude", 6, "claude", "opus", 6794, 1420664861, 5305485, 1281352, null, 882],
  ["usage-agent-claude", 5, "claude", "opus", 4736, 914374579, 2810714, 516807, null, 652],
  ["usage-agent-claude", 4, "claude", "opus", 6120, 1288213805, 3281272, 798459, null, 636],
  ["usage-agent-claude", 3, "claude", "opus", 8252, 1814826817, 3782610, 1175485, null, 755],
  ["usage-agent-claude", 2, "claude", "fable", 3290, 832404686, 2809089, 726126, null, 235],
  ["usage-agent-claude", 2, "claude", "opus", 4629, 960386996, 2359222, 668017, null, 421],
  ["usage-agent-claude", 1, "claude", "fable", 0, 0, 0, 0, null, 7],
  ["usage-agent-claude", 1, "claude", "opus", 7916, 1529256957, 3524327, 920815, null, 800],
  ["usage-agent-claude", 0, "claude", "opus", 4532, 1017185642, 1882071, 592163, null, 446],
  ["usage-agent-codex", 24, "codex", "gpt-6.1-sol", 107097, 3257216, null, 10360, 917, 60],
  ["usage-agent-codex", 23, "codex", "gpt-6.1-sol", 580158, 59657856, null, 94374, 39965, 395],
  ["usage-agent-codex", 22, "codex", "gpt-6.1-sol", 1398084, 148138240, null, 151640, 37726, 908],
  ["usage-agent-codex", 21, "codex", "gpt-6.1-sol", 966691, 116168704, null, 141136, 54380, 610],
  ["usage-agent-codex", 20, "codex", "gpt-6.1-sol", 3070948, 298170880, null, 415635, 164685, 1571],
  ["usage-agent-codex", 19, "codex", "gpt-6.1-sol", 1048483, 141688960, null, 69744, 9038, 499],
  ["usage-agent-codex", 18, "codex", "gpt-6.1-sol", 964188, 59277568, null, 61388, 13836, 316],
  ["usage-agent-codex", 17, "codex", "gpt-6.1-sol", 1250249, 94347520, null, 91137, 25132, 425],
  ["usage-agent-codex", 16, "codex", "gpt-6.1-sol", 417988, 84552704, null, 52804, 9637, 297],
  ["usage-agent-codex", 15, "codex", "gpt-6.1-sol", 747814, 79111424, null, 93425, 30906, 375],
  ["usage-agent-codex", 14, "codex", "gpt-6.1-sol", 1473909, 183462016, null, 189779, 50630, 779],
  ["usage-agent-codex", 13, "codex", "gpt-6.1-sol", 564532, 85210752, null, 76399, 12968, 354],
  ["usage-agent-codex", 12, "codex", "gpt-6.1-sol", 1397121, 376081536, null, 307808, 57607, 1462],
  ["usage-agent-codex", 11, "codex", "gpt-6.1-sol", 2871291, 519674112, null, 531863, 149878, 2086],
  ["usage-agent-codex", 10, "codex", "gpt-6.1-sol", 1784608, 192036480, null, 184856, 46999, 757],
  ["usage-agent-codex", 9, "codex", "gpt-6.1-sol", 2125541, 370127872, null, 288942, 76553, 1471],
  ["usage-agent-codex", 8, "codex", "gpt-6.1-sol", 3093598, 361078272, null, 408356, 125120, 1472],
  ["usage-agent-codex", 7, "codex", "gpt-6.1-sol", 2168854, 210707328, null, 176354, 33903, 842],
  ["usage-agent-codex", 5, "codex", "gpt-6.1-sol", 1356458, 80531072, null, 92497, 25770, 365],
  ["usage-agent-codex", 4, "codex", "gpt-6.1-sol", 838545, 129476864, null, 92895, 17707, 494],
  ["usage-agent-codex", 3, "codex", "gpt-6.1-sol", 2006948, 167919872, null, 143288, 27601, 752],
  ["usage-agent-codex", 2, "codex", "gpt-6.1-sol", 3098915, 278100864, null, 369998, 104851, 1228],
  ["usage-agent-codex", 1, "codex", "gpt-6.1-sol", 1514057, 112567552, null, 138176, 32258, 533],
  ["usage-agent-codex", 0, "codex", "gpt-6.1-sol", 1448980, 101374080, null, 84944, 9049, 403],
  ["usage-agent-mixed", 29, "claude", "claude-opus-5-5", 1644, 139549938, 1213592, 381454, null, 66],
  ["usage-agent-mixed", 28, "claude", "claude-opus-5-5", 710, 39931712, 622044, 133985, null, 35],
  ["usage-agent-mixed", 27, "claude", "claude-opus-5-5", 1800, 290028457, 1028539, 345987, null, 168],
  ["usage-agent-mixed", 26, "claude", "claude-opus-5-5", 1008, 193830376, 1187211, 325261, null, 33],
  ["usage-agent-mixed", 25, "claude", "claude-opus-5-5", 684, 45266292, 535896, 156154, null, 19],
  ["usage-agent-mixed", 24, "claude", "claude-opus-5-5", 3874, 798252664, 2894859, 681648, null, 340],
  ["usage-agent-mixed", 23, "claude", "claude-opus-5-5", 3486, 877070382, 1455557, 506992, null, 480],
  ["usage-agent-mixed", 23, "builtin", "deepseek/deepseek-flash", 0, 0, 0, 0, 0, 220],
  ["usage-agent-mixed", 23, "claude", "opus", 372, 20568190, 161983, 40455, null, 60],
  ["usage-agent-mixed", 22, "claude", "opus", 7706, 1961491648, 3914101, 1348048, null, 895],
  ["usage-agent-mixed", 21, "claude", "opus", 5514, 1348864842, 3366256, 810751, null, 809],
  ["usage-agent-mixed", 20, "claude", "opus", 6266, 1465765160, 3776644, 1447546, null, 418],
  ["usage-agent-mixed", 19, "claude", "opus", 2106, 471547425, 1237675, 394288, null, 204],
  ["usage-agent-mixed", 18, "claude", "opus", 2214, 441958041, 2615272, 524262, null, 122],
  ["usage-agent-mixed", 17, "claude", "opus", 5070, 989852009, 3485423, 933384, null, 399],
  ["usage-agent-mixed", 16, "claude", "opus", 5598, 1397703027, 3668305, 938101, null, 628],
  ["usage-agent-mixed", 15, "claude", "opus", 7417, 1615823353, 3504978, 1275844, null, 744],
  ["usage-agent-mixed", 14, "claude", "opus", 4430, 981430256, 2319144, 906613, null, 359],
  ["usage-agent-mixed", 13, "claude", "opus", 3147, 420862154, 1520116, 458751, null, 296],
  ["usage-agent-mixed", 12, "claude", "opus", 4412, 951099520, 2556177, 791668, null, 353],
  ["usage-agent-mixed", 11, "claude", "opus", 4463, 1050931303, 3944379, 824186, null, 363],
  ["usage-agent-mixed", 10, "claude", "opus", 5040, 1002762481, 3112975, 926564, null, 467],
  ["usage-agent-mixed", 9, "claude", "opus", 7611, 1665097893, 3736598, 1385473, null, 556],
  ["usage-agent-mixed", 8, "claude", "opus", 7918, 1619769191, 4139277, 1336710, null, 722],
  ["usage-agent-mixed", 7, "claude", "opus", 7505, 1545060984, 3996614, 1211335, null, 610],
  ["usage-agent-mixed", 6, "claude", "opus", 5669, 1035360420, 3041905, 999968, null, 452],
  ["usage-agent-mixed", 5, "claude", "opus", 4711, 908148392, 2312103, 750362, null, 390],
  ["usage-agent-mixed", 4, "claude", "opus", 5967, 1256423538, 2767435, 769541, null, 601],
  ["usage-agent-mixed", 3, "builtin", "deepseek/deepseek-flash", 0, 0, 0, 0, 0, 387],
  ["usage-agent-mixed", 3, "claude", "opus", 6064, 1200703370, 3613461, 899260, null, 429],
  ["usage-agent-mixed", 2, "claude", "opus", 8422, 1813725189, 3724446, 1181190, null, 772],
  ["usage-agent-mixed", 1, "claude", "fable", 62, 6046533, 378232, 7006, null, 2],
  ["usage-agent-mixed", 1, "claude", "opus", 7308, 1456997736, 3957231, 1176623, null, 620],
  ["usage-agent-mixed", 0, "claude", "fable", 2270, 498460762, 2386046, 440586, null, 119],
  ["usage-agent-mixed", 0, "claude", "opus", 2434, 524251117, 1495038, 364668, null, 163],
];

/** The latest context reading per agent: only the Codex agent reports a window. */
const CONTEXT: Record<string, { used: number | null; window: number | null }> = {
  [AGENT_USAGE_FIXTURE_AGENTS.codex]: { used: 182_400, window: 258_400 },
  [AGENT_USAGE_FIXTURE_AGENTS.mixed]: { used: null, window: null },
  [AGENT_USAGE_FIXTURE_AGENTS.claude]: { used: null, window: null },
};

function isoDaysBefore(today: string, days: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * What GET /api/servers/:serverId/agent-usage would answer for these
 * parameters, with `asOf` (an ISO instant) as now: the server's usage starts
 * 29 days ago (`since`), each agent's on its first row's day.
 */
export function agentUsageFixtureResponse(params: { from: string; to: string; agents: string }, asOf: string): AgentUsageResponse {
  const today = asOf.slice(0, 10);
  const agents = new Set(params.agents.split(","));
  const allRows: AgentUsageRow[] = ROWS
    .map(([agentId, daysAgo, runtime, model, inputNew, cacheRead, cacheWrite, output, reasoning, turns]) => ({
      day: isoDaysBefore(today, daysAgo),
      agent_id: agentId,
      model,
      runtime,
      input_new: inputNew,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      output,
      reasoning_output: reasoning,
      turns,
    }))
    .filter((row) => agents.has(row.agent_id));
  const firstDayOf = (agentId: string) => allRows
    .filter((row) => row.agent_id === agentId)
    .reduce<string | null>((first, row) => (first === null || row.day < first ? row.day : first), null);
  return {
    as_of: asOf,
    from: params.from,
    to: params.to,
    since: isoDaysBefore(today, 29),
    visible_agents: agents.size,
    agents: [...agents].map((id) => ({ agent_id: id, since: firstDayOf(id), usage_reported: firstDayOf(id) !== null })),
    rows: allRows.filter((row) => row.day >= params.from && row.day <= params.to),
    context: [...agents].filter((id) => CONTEXT[id]).map((id) => ({
      agent_id: id,
      context_used: CONTEXT[id]!.used,
      context_window: CONTEXT[id]!.window,
      at: asOf,
    })),
  };
}
