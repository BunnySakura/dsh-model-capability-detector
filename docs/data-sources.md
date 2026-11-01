# 数据来源与取值规则

本文说明每个能力字段怎样取值。面向用户的概览见 [README](../README.md)，实现位置见 [设计与架构](architecture.md)。

## 字段

插件处理四个字段：`contextWindow`（上下文窗口）、`maxTokens`（最大输出）、`input`（输入模态，`["text"]` 或 `["text","image"]`）、`reasoningEfforts`（推理等级，字典或 `false`）。

## 来源档位

同一个字段有多个来源时，取等级最高的。等级高到低：

| 等级 | 来源种类 | 说明 |
|---|---|---|
| 99 | `manual` | 你在设置页里手动套用的值，插件永远不替换 |
| 7 | `channel-api` | 渠道模型列表里含义明确的字段 |
| 6 | `official-verified` | 内置、逐项核验过的原厂规格 |
| 5 | `original-provider-mirror` | models.dev 中带原厂文档域名的原厂记录 |
| 4 | `official-sibling` | 无快照后缀的名字，从同一厂商带日期快照的原厂记录推断，仅限推理等级 |
| 3 | `third-party-consensus` | OpenRouter、LiteLLM、models.dev 中至少两家一致的值 |
| 2 | `api-hint` | `max_input_tokens`、`max_tokens` 这类含义不明的字段 |
| 1 | `preset` | 来源一致认为模型会推理、却没有等级时，按 `reasoningPreset` 填入的预设，仅限推理等级 |
| 0 | `legacy-catalog` | 旧版 `minimum`、`consensus` 策略得到的目录值 |

已有的值默认保留，除非开启 `overwrite`，或满足下面的升级条件。

### 渠道 API 字段

解析器认下面的写法，并接受 `{data:[...]}`、`{models:{id:{...}}}`、`{models:[...]}` 和顶层数组。模型映射的 key 是实际请求 ID，优先于条目内的 canonical id。

| 字段 | 认可的 API 字段 |
|---|---|
| `contextWindow` | `contextWindow`、`context_window`、`context_length`、`contextLength`、`max_context_length`、`max_model_len`、`limit.context`、`top_provider.context_length`、`capabilities.context_window` |
| `maxTokens` | `maxOutputTokens`、`max_output_tokens`、`max_completion_tokens`、`limit.output`、`top_provider.max_completion_tokens`、`capabilities.max_output_tokens` |
| `input` | `architecture.input_modalities`、`input_modalities`、`modalities.input`、`input`、`supported_modalities`、`capabilities.vision` 等布尔标志，以及 `text+image->text` 这类字符串 |
| `reasoningEfforts` | `reasoning.supported_efforts`、`reasoning_efforts`、`thinking_levels`、`parameters.reasoning_effort.enum` 等 |

模态字符串只解析箭头左侧，不把图片输出当成识图。推理等级会归一化到 pi-ai 词汇（`none → off`、`mid → medium`、`extra high → xhigh` 等）；等级只含 `off` 时写 `reasoningEfforts: false`，阻止目录补入推理能力；只声明支持推理而没有等级时，不会凭空生成等级。

`max_input_tokens` 与 `max_tokens` 没有统一含义（可能只是输入上限，或默认输出大小），因此只作为参考值，等级 1。

## 原厂记录

### 内置核验记录

经核验的记录放在 `data/verified.json`，由 `lib/official.js` 读取。当前内有 DeepSeek-V4.1-Flash-1017：上下文 1048576、最大输出 393216、支持图片输入，推理等级 `off / low / high / max`。出处是官方[发布页](https://api-docs.deepseek.com/news/news261017/)、其链接的[固定快照配置](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/config.json)和 [API 文档](https://api-docs.deepseek.com/api/create-chat-completion/)，核验日期 2026-10-31。它在公开来源不可用时仍然可用，且只匹配精确的快照 ID，不套用到浮动别名或其他快照。

新增核验记录时，需要同时有发布页、固定版本的配置或文档、API 文档三处出处，并写明核验日期。`official.test.mjs` 会检查每条记录：三个互不相同的 https 出处、日期格式、`canonical` 以自己的厂商开头、输出不超过上下文。不满足则测试失败。

### models.dev 原厂镜像

满足下面全部条件的 models.dev 记录才算原厂记录：provider 的 `id` 与白名单里的 `provider` 一致；`doc` 是 https 地址、无账号密码，主机名（和路径前缀，如果写了）在白名单内；记录的 `canonical_model_id` 没有指向其他厂商。没有 `canonical_model_id` 的记录，要么该行没写 `models`，要么模型名匹配它。未识别的厂商不会被当作原厂。

### 原厂白名单

白名单是数据文件 [data/vendors.json](../data/vendors.json)，代码不含任何厂商名。新模型厂商出现或域名变了，只改这个文件，提交里一眼能看出是在维护白名单。每行：

| 字段 | 含义 |
|---|---|
| `vendor` | 厂商命名空间，对应 `canonical_model_id` 的前缀。同一厂商的多个 provider 写同一个值，如 `zhipuai` 与 `zai` |
| `provider` | models.dev 里的 provider id |
| `docs` | 能证明这条记录来自原厂的文档地址。`host` 只比主机名，`host/path` 同时要求路径以该前缀开头（前缀后面必须是 `/` 或结束） |
| `models` | 可选的正则。没有 `canonical_model_id` 的记录，模型名必须匹配它，用来挡掉该平台上托管的其他厂商的模型 |

当前覆盖 OpenAI、Anthropic、DeepSeek、Google（Gemini）、xAI（Grok）、智谱（GLM）、月之暗面（Kimi）、阿里云（Qwen），以及原有的 Mistral、Cohere。同一厂商的两个 provider 对某个字段给出不同的值时（例如国内外区域的上下文长度不同），该字段不填。

`test/reasoning.test.mjs` 检查这份文件：上面八家都在，每个 provider 只列一次，格式非法的行会被丢弃而不是放宽信任。

### 推理等级为什么常常是空的

`reasoningEfforts` 要的是「等级名加发送值」。能给出它的只有渠道列表、原厂记录和同系快照推断。第三方来源不给等级，因为各家转售商对同一个模型写出的等级互相矛盾。大量模型的原厂记录也只写了开关或 token 预算，没有等级，例如智谱 17 个推理模型里 13 个只有开关。

DSH 对没有 `reasoningEfforts` 的模型，取内置目录里同名模型的设置，找不到就当作不推理，界面不提供等级选项，也不发送推理参数。

因此插件把两件事分开：

- **是否推理**（`reasoningSupport`）：原厂记录单独就能决定，包括只有开关或预算的；否则至少两家第三方（OpenRouter 的 `supported_parameters`、LiteLLM 的 `supports_reasoning`、models.dev 的 `reasoning`）一致，才给出「是」或「否」。某个来源没有写，不算「否」。
- **有哪些等级**（`reasoningEfforts`）：照旧只来自渠道 API 和原厂记录。

### 预设

[data/presets.json](../data/presets.json) 里是几套完整的 `reasoningEfforts`：`openai`（low/medium/high）、`extended`（再加 xhigh）、`deepseek`（low/high/max）、`toggle`（只有开和关）。预设是对渠道可接受取值的猜测，所以：

- 默认不自动套用。`reasoningPreset` 设成某一套后，只有在「来源认为模型会推理」且没有任何等级来源、原厂记录之间也没有分歧时才填，来源档位是 `preset`，等级最低，之后出现任何真实来源都会升级替换。
- 在检测报告里，对没有等级的模型可以手动选一套套用。手动套用的来源档位是 `manual`，永远不会被替换。
- DSH 会把 `high` 这样的值作为 `reasoning_effort` 发给网关。DSH 认得的网关（DeepSeek、智谱、Together、OpenRouter 等）会自动换成各自的参数格式；其他自定义网关统一走 `reasoning_effort`。通义千问等需要 `enable_thinking` 的网关，要靠 DSH 的 `compat.thinkingFormat`，本插件不设置它。

### 探测请求

默认关闭。打开 `probeEnabled` 后，报告里 OpenAI 兼容对话渠道的模型会出现「探测渠道」按钮。一次探测发约 8 个极小的对话请求（计费，每个最多 256 个输出 token），固定提示词，只报告状态，不返回提示、回答、地址或密钥：

1. 不带等级的请求，看模型是否默认就推理。
2. 带一个无效等级的请求，看渠道是否校验这个参数。接受任何等级的渠道，接受一个真实等级什么也说明不了。
3. 逐个试 minimal、low、medium、high、xhigh、max。

只有「渠道接受，并且返回里出现推理 token 或推理文本」的等级才进入建议；模型默认就推理且渠道不校验时，只给出「无法判断」。建议要你点击才会写入，来源档位是 `manual`。同一时间只运行一个探测，渠道返回错误就立即停止。

models.dev 是社区镜像，插件不会逐次抓取并核对每个官网字段。同一模型的多条原厂记录对某字段取值不同时，该字段不填。

## 名称匹配

对原厂记录，依次尝试，命中即止：

1. **完整名称**一致（忽略大小写和首尾空白），包括 `厂商/模型` 形式。
2. **去掉渠道前缀**后的最后一段一致。
3. **族匹配**：用 `names.js` 的 `family` 键比较，它去掉厂商前缀、`:变体` 后缀、末尾的 8 位日期快照，并忽略所有标点。

族匹配在报告里标 `≈`。命中的记录对应多个模型身份，或取值互相不一致时，该字段不填。`-1017` 这类短数字后缀属于模型身份，不会被去掉，所以不同快照不会互相借用规格。

对第三方来源，先比较 `compact` 键（去前缀和变体、忽略标点），不中再比较 `family` 键。

用户别名在最前面生效：键忽略大小写，精确匹配整个名字，不嵌套，最多 64 条。

### 同系快照推断

`deepseek-v4.1-flash` 这类名字指一条模型线，`deepseek-v4.1-flash-1017` 是其中一个快照。多数渠道只列前者，原厂记录却只登记后者，按精确身份匹配会落空，推理等级因此补不上（第三方来源不提供等级）。

规则（`resolveSibling`）：

- 只推断 `reasoningEfforts`。上下文、最大输出可能随快照变化，仍不共享。
- 请求名自身不带快照后缀。后缀指 `-20241022`、`-2024-12-17`，或能读成月日的四位数（`-0731`、`-1017`）；`-2507` 这类版本号不算快照。
- 候选记录去掉快照后缀后，与请求名折叠标点后相同，且属于同一厂商。主干折叠后不足 4 个字符不推断。
- 所有给出该字段的快照取值必须完全相同，否则不填。

结果标为 `official-sibling`，报告里带 `≈`，等级低于直接的原厂记录，之后若出现精确记录会被升级。不想采用这个推断时，手填 `reasoningEfforts` 即可，手填值不会被改动。

## 第三方一致

第三方有三家投票者：OpenRouter、LiteLLM、models.dev。它们只能给 `contextWindow`、`maxTokens` 和 `input`；推理等级没有统一的等级名，只取自渠道 API 和原厂记录。

### 各来源怎么给出一票

| 来源 | 上下文 | 最大输出 | 识图 |
|---|---|---|---|
| OpenRouter | `context_length`，缺失时取 `top_provider.context_length` | `top_provider.max_completion_tokens` | `architecture.input_modalities` 含图片为是，只有文本为否 |
| LiteLLM | `max_input_tokens` | `max_output_tokens`，缺失时取 `max_tokens` | `supports_vision` 为 `true` 才算是；缺失不代表否 |
| models.dev | 全部发布者条目的 `limit.context` | `limit.output` | `modalities.input` |

LiteLLM 只读 `mode` 为 `chat`、`responses`、`completion` 的条目。同一来源内部有多条匹配记录时，先看不带 `/` 前缀的主条目（OpenRouter 为没有 `:变体` 的条目）；没有主条目才看全部。然后在这组值里按下面的规则选出该来源的一票。来源内部票数持平时，这个来源对该字段弃权，不会否决其他来源。

### 选值规则（`pickAgreed`）

- 数值按从小到大排序，与当前组最小值相差不超过 5% 的并入同一组。组的取值是组内最小值，因此不会高估上限。
- 非数值（如识图的是/否）必须完全相同才算一组。
- 成员最多的组获胜；最大两组并列，则没有结果。

跨来源时：弃权的来源不计，剩下至少两家，并且获胜组严格多于其他组，才采用。因此：

- 三家里两家一致，压过另一家。
- 只剩一家来源：不填，原因「只有一家第三方来源」。
- 两家数值相差超过 5%：并列，不填，原因「第三方来源不一致」。

## 原因码

没有填上的字段，报告里的原因对应这些代码：

| 代码 | 出现位置 |
|---|---|
| `no-original-record` | 原厂记录里找不到这个模型 |
| `not-disclosed-by-original` | 找到了，但没有这一项 |
| `original-records-disagree` | 原厂记录之间取值不同 |
| `no-third-party-data` | 没有任何第三方来源给出这一项 |
| `single-third-party-source` | 有效票数不足两家 |
| `third-party-conflict` | 两组数值票数持平，或全部来源都在内部持平 |
| `catalog-disabled` | `catalogFallback` 为 `false` |
| `field-disabled` | 该字段不从公开来源填写（例如 `catalogNumbers` 为 `false`） |

## 升级

写入时，每个字段的来源种类会记进回执。之后若满足下面全部条件，已有的值会被更强的来源替换：

- `upgradeWritten` 没有关闭；
- 当前值与回执里的值相同（说明没有被用户改过）；
- 回执的等级低于新候选的等级。

回执等级低于原厂核验的字段会让一次检测「值得做」，即使没有空字段。值相同但来源更强时，只更新回执，不改配置。没有回执的值，包括旧版本写入的，一律按用户手填处理。

## 缓存

| 文件 | 内容 | 版本 |
|---|---|---|
| `catalog.json` | models.dev 目录索引 | 6 |
| `thirdparty.json` | OpenRouter 与 LiteLLM 的紧凑索引 | 2 |
| `provenance.json` | 来源回执 | 1 |

均位于 `$DSH_HOME/cache/model-capability-detector/`。目录与第三方索引的有效期都是 `catalogTtlMs`，默认 7 天。刷新失败时，同一来源的旧缓存可继续使用，并在下一轮重试。时间戳晚于当前时间的缓存视为不新鲜。目录缓存只保存源地址的哈希。

第三方响应的字节上限分别是 OpenRouter 8 MiB、LiteLLM 12 MiB。

两个第三方来源的地址可用 `openrouterUrl`、`litellmUrl` 改成镜像。缓存条目记录地址的 SHA-256 前 16 位，地址变了就不复用旧快照，也不会把镜像的快照当成默认地址的数据。没有这个字段的旧条目视为默认地址的快照。无效地址（非 http(s)、含凭据）在 Host 侧回退到默认地址。

两份缓存的版本在加入「是否推理」信号时各升了一级，旧缓存因此在下一轮重新下载。

## 已知限制

- LiteLLM 对同一模型常有多条转售商条目且数值不同，来源可能因此弃权，部分国产模型因此只能凑到一家来源。
- 同一模型不同档位的上下文（如标准版与测试版）在来源间可能不同，此时不填比填错更安全。
- 不发送推理请求来测容量，所有上限都来自文档或目录。
- 原厂规格不保证第三方渠道开放同样的上限，来源里保留 `channelVerified: false`。
