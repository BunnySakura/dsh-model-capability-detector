# dsh-model-capability-detector

在 DSH 中获取或保存第三方 API 渠道时，自动采集模型上下文长度、输出上限、识图能力和推理等级。API 明确披露的字段优先，缺失字段可由 [models.dev](https://models.dev) 兜底。

> English: [README.en.md](README.en.md)

## 触发与写入

- 点击「获取可用模型」时：第三方渠道立即请求模型列表，解析能力并补充公开目录数据，将上下文、输出上限和输入模态交给模型编辑草稿。**获取列表本身不会保存配置**。
- 保存或编辑渠道后：监听 `settings/document-updated`，将缺失能力写入 profile；推理等级也在此时补入。
- profile 重载后，以及启动数秒后：执行一次兜底扫描。

默认只补空字段，保留手工填写的值；`overwrite: true` 可覆盖已有值。仅改动 profile 自己层声明的路由，bundle 继承的路由不回写。保存经 `settings.update` 完成，带版本检查，并通过现有 HMR 流程生效。

模型获取接入仅作用于 `settingsNs` 指定命名空间、带明确 `baseURL` 的自定义渠道；内置目录渠道继续使用原适配器。DSH 当前没有模型发现完成事件，也不允许重复注册同一命名空间的 discovery，因此插件对公共 `llm.discoverModels` 方法做可卸载包装，不访问私有发现注册表，不改 HTTP/RPC 传输。`discoveryTrigger: false` 可单独关闭这一接入；将来 DSH 若改变该方法或草稿接口，需要重新验证兼容性。

DSH 的发现结果结构不传递推理等级。插件在内存中缓存原始能力元数据，最多 8 份、5 分钟，保存时复用；缓存按端点、协议、凭据和自定义头的 SHA-256 指纹隔离，**不保存原始密钥或响应体**。过期、端点或凭据变化后重新探测。未保存的草稿不会被后台写入。

## 数据优先级与原厂规格

默认顺序：**保留已有配置 → 当前渠道 API → 直接核验的原厂规格 → models.dev 的原厂记录镜像**。不会默认聚合其他转售渠道，也不取它们的最小值。

`catalogNumericStrategy: official` 是新默认值，影响全部目录能力字段。已内置直接核验的 DeepSeek-V4.1-Flash-1017：上下文 **1048576**、最大输出 **393216**、图片输入及明确披露的推理等级。来源为官方[发布页](https://api-docs.deepseek.com/news/news261017/)、其链接的[固定快照配置](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/config.json)和[API 文档](https://api-docs.deepseek.com/api/create-chat-completion/)，核验日期为 2026-10-31。它可在目录不可用时使用，仅精确版本 ID 命中；浮动名称 `deepseek-flash` 通过原厂目录记录解析，不永久绑定到旧快照。

其他模型使用 models.dev 时，要求明确的原厂 provider、受信任的原厂文档域名，并排除 canonical ID 属于其他厂商的记录。**models.dev 是社区镜像，插件没有逐次抓取并验证每个官网字段。** 数据来源记录会明确区分 `official-verified` 与 `original-provider-mirror`。当前原厂域名规则覆盖 DeepSeek、OpenAI、Anthropic、Google、xAI、Mistral、Cohere、Moonshot 和智谱；未识别厂商保持空白。

匹配保留标点、日期与版本后缀，只忽略大小写及首尾空白；允许渠道前缀不同但完整模型名一致。不同原厂身份或同一身份披露的字段有冲突时，不自动填写该字段。API 只披露部分字段时，只补其余字段。不会发送推理请求来测容量。

官网规格表示原厂能力，**不保证第三方渠道开放相同上限**。来源中的 `channelVerified: false` 保留这一事实。用户已有值默认不覆盖；旧版本写入的低值因无法区分手工配置，不自动上调。确认要采用新值时，可先清空对应字段再保存。

```yaml
catalogNumericStrategy: official   # 默认：原厂规格
# catalogNumericStrategy: minimum   # 显式兼容模式：跨渠道最小值
# catalogNumericStrategy: consensus # 显式兼容模式：跨渠道数值一致才填
catalogNumbers: true               # false 可关闭数值目录兜底
catalogFallback: true              # false 关闭所有公开来源兜底，包括内置规格
```

目录缓存为 v5，位于 `$DSH_HOME/cache/model-capability-detector/catalog.json`，默认有效期 7 天。同源同格式的过期缓存可在刷新失败时复用；未来时间戳不能视为新鲜。仅保存源 URL 指纹，不保存其查询参数。

每次配置成功写入后，来源记录保存到同目录的 `provenance.json`：字段和值、来源 URL、记录时间，以及路由/模型/字段的 SHA-256 标识。不保存渠道地址、密钥或请求头。公开原厂模型名仍可能出现在来源元数据中；这些本地文件不应分享。

## API 解析

| 配置字段 | 常见 API 字段 |
|---|---|
| `contextWindow` | `contextWindow`、`context_window`、`context_length`、`max_model_len`、`max_input_tokens`、`limit.context`、`top_provider.context_length` |
| `maxTokens` | `max_output_tokens`、`max_tokens`、`max_completion_tokens`、`limit.output`、`top_provider.max_completion_tokens` |
| `input` | `architecture.input_modalities`、`modalities.input`、`input`、`supports_vision`、`vision` 等 |
| `reasoningEfforts` | `reasoning.supported_efforts`、`reasoning_efforts`、`thinking_levels`、`parameters.reasoning_effort.enum` 等 |

支持 `{data:[...]}`、`{models:{id:{...}}}`、`{models:[...]}` 和顶层数组。模型映射的 key 是实际请求 ID，优先于条目内的 canonical id。等级会归一化到 pi-ai 词汇，例如 `none → off`、`mid → medium`、`extra high → xhigh`；API 等级仅含 `off` / `none` 时写入 `reasoningEfforts: false`，阻止目录补入推理能力。仅声明支持推理而未披露等级时不会凭空生成等级。`text->image` 等模态字符串只解析箭头左侧的输入部分，不把图片输出视为识图能力。

OpenAI 兼容协议请求 `GET {baseURL}/models`；Anthropic 请求 `GET /v1/models?limit=1000`，接受根地址或带 `/v1` 的地址。自定义请求头会发送到渠道端点，API key 经 credentials 服务即时解析；显式设置但无法解析的引用不会退化成匿名请求。草稿只有在端点和协议与已保存渠道一致时才复用其凭据及请求头；换地址后需提供新凭据，显式输入的新密钥优先。API 请求拒绝重定向，避免自定义认证头被转发。响应在读取时按字节限制大小，超限即取消。

## 日志与隐私

**默认关闭全部插件日志**：`logging: false` 且 `logFile: ""` 时既不输出 Host 日志，也不创建诊断日志。公开目录缓存仍可能写入磁盘，与日志开关无关。

调试时可以任选：

```yaml
logging: true                         # 仅启用 DSH Host 日志
logFile: "logs/model-capability-detector.log"  # 显式路径启用 JSONL 文件及 Host 日志
```

文件路径为空则关闭文件日志；如需恢复完全静默，同时将 `logging` 设为 `false`。相对路径基于 DSH home；`~/` 也表示 DSH home，例如 `~/logs/detector.log`，不要重复加 `.dsh`。

诊断记录事件、模型字段和决策，不记录密钥、请求头原始值或响应体；URL 的 userinfo、查询参数、fragment 以及常见凭据模式会被脱敏，错误对象不原样输出。日志超过 2 MiB 时保留一份 `.1` 历史。路由名、模型 ID 等仍可能属于你的部署信息，分享前应检查日志。默认忽略日志、环境文件和本地缓存，避免误提交到 GitHub。

## 配置

在 profile 的 `cordis.patch.yml` 中按行 id 覆盖配置：

```yaml
- id: dsh-model-capability-detector
  name: dsh-model-capability-detector
  config:
    settingsNs: llm-pi-ai
    enabled: true
    overwrite: false
    dryRun: false
    timeoutMs: 15000
    debounceMs: 800
    startupDelayMs: 3000
    maxResponseBytes: 4194304
    catalogFallback: true
    catalogUrl: https://models.dev/api.json
    catalogTimeoutMs: 30000
    catalogMaxBytes: 16777216
    catalogTtlMs: 604800000
    catalogNumbers: true
    catalogNumericStrategy: official
    updateCheckOnStartup: false
    discoveryTrigger: true
    logging: false
    logFile: ""
```

`dryRun: true` 仅计算计划，不写 profile；搭配 `logging: true` 或 `logFile` 查看计划。此选项仍允许把发现候选交给编辑草稿。

从 1.1 升级时，已有 profile 显式设置的 `catalogNumbers: false` 或 `logFile` 会继续生效。想采用新的数值默认策略，需要修改自己的覆盖项；已填写的旧数值默认不会被覆盖。

## 稳定性与验证

配置变化会合并处理，后台 pass 串行运行。写入前重新核对配置版本，避免慢请求覆盖用户刚做的编辑；卸载会取消请求、清理定时器和内存缓存，已开始的探测也不会继续写配置。配置写入保留已有的 HMR 事务隔离方式。

```sh
node --test test/*.test.mjs
```

测试使用合成数据和假 fetch，不读取真实渠道或密钥。覆盖列表解析、目录冲突与缓存隔离、日志脱敏、获取列表后保存、卸载取消、并发编辑及 HMR 场景。该版本的实际模型页点击行为仍应在目标 DSH 版本中验证，离线测试不等同于浏览器验收。

## 安装

本仓库支持直接从 GitHub 安装，无需先下载或生成 `.tgz` 压缩包。在 DSH「插件」页面的安装输入框中填写：

```text
https://github.com/BunnySakura/dsh-model-capability-detector
```

也可以使用 pnpm 的 GitHub 简写：

```text
github:BunnySakura/dsh-model-capability-detector
```

Agent 使用 `plugin_manager` 的 `install_bundle` 操作，将上述地址作为 `target`。默认安装仓库默认分支；需要固定版本时，在地址末尾追加 `#<tag 或完整 commit SHA>`，对应的 tag 或 commit 必须已推送到 GitHub。安装需要能连接 GitHub，并满足包中声明的 DSH 版本要求。

仓库根目录已包含 bundle 声明、补丁、JavaScript 入口、运行模块、语言资源和图标，无需额外编译或执行安装脚本。仍可通过插件管理器安装本地目录（使用绝对路径）或 `.tgz` 包。安装会影响当前 profile 的所有会话，请在希望启用该版本时执行。

## 插件更新

在 DSH「插件」页面打开「插件更新」标签。页面仅读取本机缓存状态；点击「检查更新」后访问固定仓库 `BunnySakura/dsh-model-capability-detector` 的 GitHub Releases，显示最新稳定版本、纯文本发布说明和固定 tag 的安装目标。草稿、预发布和无效 tag 不会成为候选；GitHub 404 表示尚无正式发布，限流或网络失败不会影响检测。

「查看并更新」显示确认内容；确认后调用 **DSH 插件页原生安装对话框**。安装进度、兼容性检查、脚本授权、失败及是否重启由 DSH 管理。插件不自行卸载旧包、不执行 pnpm、不自动授权脚本。如果当前 DSH 以「已安装」拒绝覆盖，请先保留配置覆盖项，再使用其卸载、重新安装流程；卸载成功后安装失败会保持未安装状态，无法保证原子回滚。

`updateCheckOnStartup: false` 默认不额外联网。开启后，每次启动延迟检查一次；同一进程缓存 24 小时，重启会清空缓存。手动检查可刷新缓存。只读 Agent 工具 `model_capability_detector_updates` 提供 `status` 与 `check`，不执行升级。检查不上传渠道地址、模型列表、API key 或配置。

维护者需发布 1.3.0 稳定 GitHub Release 和对应版本 tag；仅推送分支提交不会产生更新提示。插件自身的公开模型目录刷新与代码更新独立。

此实现使用 DSH 0.2.1-rc.5 的插件页扩展接口。用户配置覆盖项会按 DSH 的配置层继续生效；显式保留的 `minimum` 不会被新默认值强制替换。界面必须在安装本轮代码后才可使用；离线测试不代表当前运行实例已经更新。
