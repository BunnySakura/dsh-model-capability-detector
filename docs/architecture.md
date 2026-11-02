# 设计与架构

本文面向维护者，说明插件的模块划分、运行流程、对外接口和安全边界。面向用户的说明见 [README](../README.md)，取值规则见 [数据来源与取值规则](data-sources.md)。

## 模块

| 文件 | 职责 |
|---|---|
| `index.js` | Host 入口。读取设置、调度检测、写回 profile、提供报告/试查/重新检测 |
| `client.js` | 浏览器端。在插件详情页的 `plugins.bundle.config` 槽位渲染设置、报告与更新界面 |
| `lib/settings.js` | 选项定义、校验、三层取值与带 revision 的设置存储 |
| `lib/detect.js` | 把渠道模型列表解析成能力；区分含义明确的字段与参考值 |
| `lib/plan.js` | 按来源档位合并能力、升级判断、空字段判断 |
| `lib/catalog.js` | models.dev 目录的下载、索引、缓存，以及旧版 `minimum` / `consensus` 策略 |
| `lib/official.js` | 原厂记录：读取 `data/verified.json` 的核验记录，按 `data/vendors.json` 筛选 models.dev 的原厂镜像，汇总「是否推理」 |
| `lib/presets.js` | 读取并校验 `data/presets.json`，提供 `reasoningEfforts` 预设与字典校验 |
| `lib/probe.js` | 可选的探测请求：向一个 OpenAI 兼容渠道试探它接受哪些推理等级 |
| `data/verified.json` | 逐项核验过的原厂规格，随包发布 |
| `data/vendors.json` | 原厂白名单：provider、厂商命名空间、文档地址（可带路径前缀）、模型名正则 |
| `data/presets.json` | 推理等级预设 |
| `scripts/` | 维护者脚本：测试入口、隐私扫描、打包清单检查、`live-probe.mjs`；不随包发布 |
| `lib/sources.js` | OpenRouter 与 LiteLLM 的下载、索引、缓存和投票 |
| `lib/tiers.js` | 把原厂记录与第三方来源合成一次解析，并定义来源等级 |
| `lib/names.js` | 模型名归一化与别名 |
| `lib/provenance.js` | 来源回执：记录插件写过哪些值、来自哪一档 |
| `lib/discovery.js` | 对 `llm.discoverModels` 的可卸载包装与短期内存缓存 |
| `lib/diagnostics.js` | 脱敏与 JSONL 诊断日志 |
| `lib/http.js` | 按字节限制读取 JSON 响应 |
| `lib/fsutil.js` | 先写临时文件再重命名的原子写入，缓存、回执和设置共用 |
| `lib/update-host.js` | Host 路由与只读 Agent 工具 |
| `lib/updates.js` | GitHub Releases 检查；Release 说明为空时读取同名附注标签的注释 |

## 触发与写入流程

后台检测由这些事件触发：

- `settings/document-updated`，且命名空间等于 `settingsNs`
- `app-boot/config-reload`
- Loader 就绪后再等 `startupDelayMs` 的启动扫描
- 设置页保存了新的选项
- 设置页的「立即重新检测」

一次检测（`runOnce`）依次做：

1. 从设置服务读取 profile 层的 `providers`，计算签名；与上次相同则跳过。
2. 读取来源回执。若没有空字段，也没有可升级的字段（回执等级低于原厂），则记下签名并结束。
3. 对每个仍有可改善字段的渠道请求模型列表。同一次获取草稿时缓存过的结果会被复用。
4. 对仍缺的字段向公开来源取值：先用原厂记录，仍缺才下载第三方来源。
5. 按档位合并（见 `mergeDetected`），得到新的 `providers`、改动清单、来源回执和升级清单。
6. 写入前重新读取 profile。版本或内容已变则放弃本次写入并再排一轮，避免慢请求覆盖用户刚做的编辑。
7. 通过 `settings.update` 带 revision 写回，再写来源回执。写入通过 `AsyncLocalStorage.exit` 脱离当前的 HMR 事务，以避开 HMR 事务不可嵌套的限制。

后台检测串行执行，密集的变更被合并。插件卸载时会取消在途请求，清理定时器与缓存，已开始的检测不会再写配置。只处理 profile 自己层声明的路由，bundle 继承的路由不回写。

### 获取可用模型

DSH 没有「模型发现完成」事件，也不允许同一命名空间注册第二个 discovery。插件因此对公共方法 `llm.discoverModels` 做可卸载包装，只作用于 `settingsNs` 且带明确 `baseURL` 的自定义渠道，内置目录渠道仍走原适配器。包装不碰私有发现注册表，也不改 HTTP/RPC 传输。`discoveryTrigger` 随设置变化实时挂上或卸下。

DSH 的发现结果结构不传递推理等级。插件在内存里缓存解析后的能力，最多 8 份、5 分钟，保存草稿时复用。缓存键是端点、协议、凭据和自定义头的 SHA-256 指纹，不保存原始密钥和响应体。

#### 已知限制：发现结果没有推理等级

这是 DSH 的接口约束，不是插件可以绕过的行为。设置页在推理分组下有一句说明，让「导入后开关是关的」不被读成检测失败。

- `llm.discoverModels` 的返回结构固定为 `id`、`name`、`contextWindow`、`maxTokens`、`inputModalities` 五个字段。DSH 用 zod schema 校验这条 RPC 结果，多给的键不会到达界面。
- DSH 模型页的 `adopt()` 只把这五个字段拷进草稿行，`reasoningEfforts` 因此保持未设置。
- 草稿行的推理状态由模型页的 `readEfforts(model)` 读 `model.reasoningEfforts` 得出，所以「获取可用模型」之后推理开关必然是关的。

插件因此把等级写进**已保存的** `providers`：保存卡片或跑一轮检测后，重开模型页才会显示。`lib/discovery.js` 的包装有意不透传 `reasoningEfforts`，因为多传只会被 schema 丢掉，还可能在契约收紧时让整条发现请求失败。

如果将来 DSH 放宽这条契约，按下面三步接上即可：

1. `lib/discovery.js` 的 `models.map(...)` 里增加 `...(reasoningEfforts === undefined ? {} : { reasoningEfforts })`。
2. 确认模型页的 `adopt()` 与 `readEfforts()` 会读取该字段；只放宽 schema 而不推进草稿映射没有效果。
3. 为「发现结果带等级」补一条 `test/plugin.test.mjs` 用例，并删掉设置页的说明与 `updates.test.mjs` 里对应的两条断言。

判断契约是否已放宽，看 DSH 的 RPC 结果 schema 是否包含推理字段，不要以 `adopt()` 是否拷贝为准：两者可以不同步。

## 设置存储

取值分三层，后者覆盖前者：内置默认值、`cordis.patch.yml` 里本插件的 `config`、GUI 保存的值。

- GUI 的值保存在 `$DSH_HOME/model-capability-detector/settings.json`，先写临时文件再重命名。
- 存储的 revision 是已保存覆盖项的 SHA-256 前 16 位。保存请求必须带上它读到的 revision，不一致则返回冲突。
- 每次读取都会重新读文件，所以手工改文件也会被跟随。
- 选项的类型、范围和校验集中在 `FIELDS`，Host、界面和测试共用同一份。`config` 里的无效项被忽略并记录，不会让插件加载失败。GUI 保存时额外要求日志文件位于 DSH 主目录内。
- 插件不导出 `Config` schema。DSH 把 `@deepseek-ai/schemastery` 当作宿主包，但它不在 profile 的 `node_modules` 里，无法在插件内可靠解析，因此改为自己校验。

设置变化时，存储通知 `index.js`：重算日志与目录字段，必要时清掉目录缓存，重新挂接或卸下发现包装，并安排一次检测。

## Host 接口

所有路由都挂在 DSH 的 `connection.fetch` 上，路径前缀 `/api/model-capability-detector`，由 DSH 先做登录与来源检查。

| 路径 | 方法 | 作用 |
|---|---|---|
| `/updates` | GET | 读取更新状态（缓存 24 小时），含 `linked` |
| `/updates` | POST | `{ action: "check", refresh }`，检查最新稳定版，结果含 `linked` |
| `/settings` | GET | 返回生效值、默认层、已保存覆盖项、字段范围、revision |
| `/settings` | POST | `{ revision, set, unset }`，原子保存一组变更 |
| `/detector` | GET | 检测报告 |
| `/detector` | POST | `{ action: "lookup", model }` 试查；`{ action: "rescan" }` 重新检测；`{ action: "apply-reasoning", route, model, preset \| efforts }` 给一个没有等级的模型写入预设或探测建议；`{ action: "probe", route, model }` 探测渠道 |

所有 POST 要求 `content-type: application/json`、自定义请求头 `x-model-capability-detector: 1`，请求体不超过 16 KiB。自定义头会触发浏览器的跨域预检，外部页面因此无法直接写入。状态码：缺少请求头 403、类型不对 415、过大 413、JSON 无效 400；设置保存的冲突 409、校验失败 400、只读 403、写盘失败 500。

报告与试查只读已保存的 profile 和公开来源，不联系渠道，返回内容里没有地址、密钥或请求头。

两个会改动东西的动作有各自的防护：

- `apply-reasoning` 只写一个空的 `reasoningEfforts`：已有值（包括 `false`）返回 409，`dryRun` 时返回 409。字典用 `cleanEfforts` 校验，与 DSH 的要求一致（只认已知等级，除 `off` 外都要有发送值，至少一个非 `off` 的等级）。写入走 `settings.update` 带 revision，之后记一条 `manual` 回执，让后续检测不会替换它。路由只传 `route`、`model`、`preset`、`efforts` 四个字段，路由名用 `Object.hasOwn` 查找。
- `probe` 默认拒绝（403），必须先开 `probeEnabled`。只接受 `openai-completions` 路由和该路由里已有的模型，同一时间只运行一个（否则 409）。凭据通过凭据服务取用，请求拒绝重定向，响应按字节限制读取。结果和日志只含状态、判定和请求数，不含路由名、模型名、地址、提示词或回答。渠道返回认证、限流或服务错误时立即停止，返回码对应 401/403、429、5xx 的原因，不转发渠道的错误内容。

只读 Agent 工具 `model_capability_detector_updates` 与 `/updates` 共用同一份检查，只能查询。

## 浏览器端

`client.js` 把设置页注册到 `plugins.bundle.config` 槽位，键为包名，所以只出现在本插件自己的详情页。

- 界面的字段范围来自 `/settings` 返回的 `fields`，不在前端重复定义。
- 保存把改动字段放进 `set`，重置字段放进 `unset`。冲突时载入最新值并提示。
- 更新通过 `remote.pluginManager.installBundle(spec, { enabled: true, requestId })` 交给 DSH 插件管理器。页面只接受 `git+https://github.com/BunnySakura/dsh-model-capability-detector.git#<稳定版标签>` 形式的目标，Host 生成时也按同一规则校验。

## 来源回执

每次写入成功后，`provenance.json` 记录字段、值、来源种类和时间，键是路由、模型、字段三元组的 SHA-256，因此不含渠道地址、密钥或明文路由名。最多保留最近 5000 条。

回执是升级的依据：只有当前值与回执里的值相同，才认定它是插件写的；用户改过或手填的值没有匹配的回执，不会被升级。唯一的例外是 DSH 模型页打开推理开关时写入的默认等级 `off/low/medium/high`，见[数据来源与取值规则](data-sources.md)。

## 安全边界

- 渠道请求拒绝重定向，避免自定义认证头被转发；响应按实际字节限制，超限即取消。
- 渠道凭据通过 DSH 凭据服务即时取用。草稿只在端点和协议与已保存渠道一致时才复用其凭据和请求头；换地址后需提供新凭据，显式输入的密钥优先。
- 请求头或密钥无效时抛出固定消息，不引用原值。
- 公开来源只用固定的 URL（models.dev 地址可配置，但只接受不含凭据的 http(s)），请求不带凭据，响应有字节上限。
- 日志与诊断在写入边界统一脱敏，不输出原始错误对象、请求头或响应体。
- 更新目标由代码拼接，只指向本项目仓库的稳定版标签，不接受外部传入的地址。
- 开发检出目录不提供更新。`isDevCheckout`（`lib/update-host.js`）在插件目录不在 `node_modules` 内，或其下有 `.git` 时为真，Host 在 `/updates` 返回 `linked: true`，设置页据此隐藏「更新」按钮，`installUpdate` 也会拒绝。原因：profile 用 `link:` 指向工作目录时，`node_modules` 里的条目是指向它的 Junction，插件管理器（pnpm）替换时在 Windows 上报 `EPERM`；失败后开发目录的 `.git` 曾少了几个文件，推断是 pnpm 沿链接清理所致（细节见[开发与发布](development.md)）。
