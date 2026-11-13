# JCS 共享测试向量（协议 v3.2.2 §10、§16）

文件：
- `jcs-vectors.json`：145 条，其中 72 条 ok、73 条 reject（SHA-256 `52dc8b28dbf7799dc35d71da33df4eb09bab3639c9e1193c8cc29cc0dca3ecbd`，测试里固定）。
- 生成脚本 `jcs-vectors-gen.py`：运行 `python3 jcs-vectors-gen.py jcs-vectors.json` 可以重新生成，结果逐字节相同。

Raft（TS）、Stamp（Go）、Vault（Go）都跑同一组向量。三方对所有 ok 向量算出相同的规范字节和摘要，并且对所有 reject 向量都拒绝（不修复、不替换），§16 的 #40 才算通过。

## 补充 4 的变化（相对 140 条的 v3.2.2 版）

协议补充 4 第 4 条：对象 key 解码转义之后含 U+0000–U+001F 的，整份文档非法，值不受影响。

1. 改为 reject：`jcs_key_with_nul_between_prefix_and_longer`（key 含 U+0000）、`jcs_rfc8785_sort_example_strings`（RFC 8785 的例子有 `"\r"` key）。
2. 新增 reject：`jcs_reject_key_escape_char`（key 为 U+001B）、`jcs_reject_key_c0_short_escape_nested`（数组里的对象，key 为 `"\t"`）。
3. 新增 ok：`jcs_key_with_space_and_del_around_longer`、`jcs_rfc8785_sort_example_space_key`（接替上面两条的排序覆盖），`jcs_c0_in_value_and_escaped_backslash_key`（值里的控制字符、字面的 `\\u001b` key 照常通过）。

| 层 | ok | reject |
|---|---|---|
| `jcs` | 45 | 30 |
| `description` | 27 | 43 |

## v3.2.2 的变化（相对 80 条的 v3.2.1 版）

1. **解析分两层**（Tenny `77619123` #3；Cardy v3.2.1 复核 R5.4）：
   - 通用层只检查语法、重复 key 和 Unicode 是否合法，**允许数字、布尔和 `null`**。handle 和 ticket 的 `iat`/`exp`/`epoch`/`requiresPrepare`，以及 Button 描述里的 `undoWindowMs`，都要经过这一层。
   - 原来在 `jcs` 层拒绝数字、布尔、`null` 的 8 条向量，改为 ok 向量，名字去掉了 `reject_`。“不允许数字、布尔、`null`”只属于确认描述（`description` 层），对应的 reject 向量放在 `desc_reject_*` 下。
2. **`read_at` 向量**（Tenny `6e486d6c`；Cardy R5.3）：
   - 有毫秒和无毫秒、1 位和 9 位小数、闰日都接受。
   - 2 月 30 日、非闰年 2 月 29 日、4 月 31 日、13 月、24 时、60 分、闰秒 60、缺 `Z`、小写 `z`、数字偏移、空格分隔、10 位小数、空小数、逗号小数、缺秒、全角数字都拒绝。
   - `.120` 原样进入摘要，与 `.12` 的摘要不同。
3. **长度按 code point 计数**（Tenny `6e486d6c`）：title 120/121（ASCII、补充平面字符、组合字符各一组）、confirm_label 40/41、body 500/501、rows 的 label 40/41 和 value 200/201。
4. **接受非字符**（Tenny `6e486d6c`）：U+FFFF、U+FFFE、U+FDD0、U+FDEF、U+1FFFF、U+10FFFF，转义和原样两种写法，作为值和作为 key 都有。
5. **合法的 U+FFFD 必须接受**：转义和原样各一条，用来防止 Go 实现为了检测孤立代理项而误拒 U+FFFD。
6. **`terms.__proto__`** 在 description 层也有一条 ok 向量。
7. 新增 4 条数字语法的 reject 向量：`Infinity`、`+1`、`01`，以及原有的 `NaN`。

## 每条向量的字段

| 字段 | 含义 |
|---|---|
| `name` | 唯一名称，前缀为 `jcs_` 或 `desc_` |
| `layer` | `jcs`：只做通用严格解析和 JCS；`description`：另外做 §5.2 的确认描述 schema |
| `input_json` | App 实际可能发来的原始 JSON 文本 |
| `canonical` | 正确的 JCS 输出；reject 向量为 `null` |
| `sha256_hex` | `lowercase_hex(SHA-256(UTF-8(canonical)))`；reject 向量为 `null` |
| `expect` | `"ok"` 或 `"reject"` |
| `note` | 这条向量测的是什么 |

| 层 | ok | reject |
|---|---|---|
| `jcs` | 44 | 26 |
| `description` | 27 | 43 |

## 怎么跑

对每一条向量：

1. **通用严格解析**（所有进入摘要或签名的 JSON 都要做）：
   - 语法按 RFC 8259：BOM、注释、尾逗号、`NaN`、`Infinity`、`+1`、`01` 都拒绝；顶层必须是对象。
   - 重复 key 一律拒绝，包括反转义之后才重复的 key，任何层级都算。
   - Unicode 必须合法：孤立代理项、顺序颠倒的代理对都拒绝。**合法的 U+FFFD 和非字符都接受。**
   - **数字、布尔、`null` 在这一层是允许的。**
2. **`layer == "description"` 时**，再做 §5.2 的 schema：
   - 只允许字符串、对象、数组；数字、布尔、`null` 都拒绝。
   - 未知字段拒绝，必填字段缺失拒绝。
   - `rows` 每项恰好是 `{label, value}`，最多 8 项；`terms` 是 `{string: string}`，最多 16 项。
   - 长度**按 code point 计数**：一个合法代理对算 1 个，组合字符各算 1 个，不做 NFC。
   - `read_at` 先匹配 ASCII 正则 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`（`\d` 必须只匹配 ASCII 数字），**再做真实的日历检查**：月 01–12，日不超过当月天数（含闰年），时 00–23，分 00–59，秒 00–59（不接受闰秒 60）。**不修复日期，不重新格式化**；进入摘要的就是原文。
3. `expect == "reject"`：上面任何一步报错即可。
4. `expect == "ok"`：JCS 的输出必须逐字节等于 `canonical`，SHA-256 必须等于 `sha256_hex`。

## 需要两两比较的向量

**摘要必须相同：**
- `jcs_solidus_escaped` / `jcs_solidus_raw`
- `jcs_u2028_u2029_escaped_input` / `jcs_u2028_u2029_raw_input`
- `jcs_non_ascii_escaped_input` / `jcs_non_ascii_raw_input`
- `jcs_u_fffd_escaped_is_valid` / `jcs_u_fffd_raw_is_valid`
- `jcs_noncharacters_escaped` / `jcs_noncharacters_raw`
- `desc_stamp_merge_zh_CN` / `desc_stamp_merge_zh_CN_escaped`
- `desc_vault_approve_zh_CN` / `desc_vault_approve_zh_CN_escaped`
- `desc_title_120_supplementary` / `desc_title_120_supplementary_escaped`

**摘要必须不同：**
- NFC 与 NFD：`jcs_nfc_precomposed` / `jcs_nfd_decomposed`
- 不同语言：zh-CN 与 en 的 `desc_stamp_merge_*`、`desc_vault_approve_*`
- 只改 `locale` 字段：`desc_vault_approve_locale_field_only_differs`
- 空字段与缺失字段：`desc_minimal_*`
- `read_at` 原文不同但时刻相同：`desc_read_at_millis_trailing_zero`（`.120`）/ `desc_read_at_two_digit_fraction`（`.12`）
- 有无小数：`desc_read_at_seconds` / `desc_read_at_millis`

## 校验情况（2026-10-21）

全部 71 条 ok 向量，用以下 5 种实现分别计算，`canonical` 和 `sha256_hex` 完全一致：
1. 生成脚本里手写的 JCS：key 按 UTF-16 排序；字符串转义手写；数字只用安全范围内的整数和一份固定的短小数清单（ES 格式），清单之外的数字会让生成脚本直接报错。
2. Python 标准库 `json.dumps`，加 UTF-16 排序。
3. **Raft 的 `canonicalJson.ts`**：v3.2.1 复核时取的 `c085a724` 副本，用 Node 24 直接运行，前面用 `JSON.parse` 解析。
4. npm `canonicalize@5.1.0`。
5. PyPI `rfc8785@0.1.4`。

这次**没有**在 Go 上运行：本机没有 Go 工具链。Stamp 和 Vault 的 Go 实现要在各自的 CI 里跑这组向量。

**reject 向量：** 生成脚本按上述两层规则拒绝全部 69 条。拿“`JSON.parse` + Raft `canonicalJson`”这条现有路径来跑，仍会接受其中 51 条：
- `jcs` 层 8 条：4 条重复 key、4 条孤立代理项；
- `description` 层 43 条：现有路径没有 schema。

这在意料之中：C1 的严格解析器和 description schema 就是用来拦这些的。

## 实现注意事项

**Raft `canonicalJson.ts`**
- 它只负责序列化，不做校验。
- 重复 key：`JSON.parse` 会静默保留最后一个。必须换成能检测重复 key 的解析器。
- 孤立代理项：`JSON.parse` 能接受，`canonicalJson` 会原样输出 `"\ud83d"`。必须在解析层拒绝，或者让序列化器对不合法的 Unicode 报错。
- 数字、布尔、`null`：它照常序列化（`-0` 输出 `0`），这在通用层是**正确的**。只有 description schema 才拒绝它们，**不要**把这条限制加进通用的解析器或序列化器，否则 handle 和撤销按钮会坏掉。
- `__proto__`：要求它作为普通数据被保留，并且没有原型副作用。真正的风险在于会触发 setter 的赋值、按字段重建对象，以及 schema 库自己的处理方式；原生的对象展开不一定会丢掉它。要测的是**实际的解析加 schema 管线**，见 `jcs_js_special_keys`、`desc_terms_proto_key_kept`。

**Go（Stamp、Vault）**

`encoding/json` 的输出不能直接当 JCS 用：
- `map` 的 key 按 UTF-8 字节排序，不是按 UTF-16 code unit 排序。
- 总是转义 U+2028 和 U+2029；默认也会转义 `<`、`>`、`&`。
- Go 1.22 之前，`\b`、`\f` 会被输出成 `\u0008`、`\u000c`。
- 解码时，孤立代理项和非法 UTF-8 会被静默替换成 U+FFFD（`Unmarshal` 和 `Decoder.Token` 都是这样），重复 key 保留最后一个。

所以要手写排序和字符串转义，或者用经过审查的 JCS 库。数字按 ES 格式输出：整数直接输出，`-0` 输出 `0`，`1e2` 输出 `100`。

**解析**（协议 §10.1；Cardy v3.2 复核 §6；证据 `cardy-v32/go-token-probe.log`）：
- Token 流**可以**用来检测重复 key。
- Token 流**不能**用来检测孤立代理项：`"\ud800"` 和合法的 `"�"` 得到的 token 完全相同，事后已经无法区分。
- 所以必须在解码之前检查原始字节：每个 `\uD800`–`\uDBFF` 后面必须紧跟一个 `\uDC00`–`\uDFFF`，单独出现的 `\uDC00`–`\uDFFF` 都算错误；原始字节用 `utf8.Valid` 检查。另一种做法是换用严格解析器。
- **不得**拒绝合法的 U+FFFD（`jcs_u_fffd_*`）。
- `read_at` 的正则只能匹配 ASCII 数字（`desc_reject_read_at_fullwidth_digit`）。日历检查要在正则之后单独做，例如用 `time.Date` 构造之后比较各个字段是否与原值相同，因为 `time.Date` 会把 2 月 30 日“修复”成 3 月 2 日。**不要**用 `time.Parse` 之后重新格式化的结果代替原文。

## 仍然没有覆盖的内容

- `locale` 的 BCP 47 语法校验：协议只规定它是实际显示的语言，没有规定校验到哪一层。
- 超出 IEEE-754 安全整数范围的数字：协议的签名载荷里不会出现，向量里也没有。
