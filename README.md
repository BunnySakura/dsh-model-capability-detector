# dsh-model-capability-detector

导入提供商时自动探测并填写模型能力，省去逐项手填。

> English: [README.en.md](README.en.md)

## 这个插件解决什么

DSH 的「模型」设置页本身会请求提供商的模型列表，但它只在点击「获取模型」时采纳
`id`、`name`、`contextWindow`、`maxTokens` 和输入模态这几项，字段名不完全一致的
元数据会被丢弃，思考等级则完全不会获取。

本插件读取同一份模型列表，把其中**明确披露**的能力写回你的 profile：

| 字段 | 含义 |
|---|---|
| `contextWindow` | 模型可接受的上下文长度 |
| `maxTokens` | 模型声明的输出上限 |
| `input` | `["text"]` 或 `["text", "image"]` |
| `reasoningEfforts` | 模型提供的思考等级；不支持思考时为 `false` |

## 触发时机

- 在「模型」页保存或编辑提供商配置后（`settings/document-updated`）。
- profile 的补丁重新协调完成后（`app-boot/config-reload`）。
- 启动数秒后执行一次兜底扫描，覆盖「插件当时未启用」或「端点当时不可达」的配置。

多次配置写入会被合并成一次探测，且同一时刻只有一个探测在跑。

## 判定规则

各家模型列表对同一能力的表述方式并不统一：字段名不同、嵌套层级不同，甚至同一项能力
可能是布尔值、数组或字符串。探测覆盖以下常见写法：

- **上下文** — `contextWindow`、`context_window`、`context_length`、
  `max_context_length`、`max_model_len`、`max_input_tokens`、`limit.context`、
  `top_provider.context_length`。
- **输出上限** — `maxOutputTokens`、`max_output_tokens`、`max_tokens`、
  `max_completion_tokens`、`limit.output`、`top_provider.max_completion_tokens`。
- **识图能力** — `architecture.input_modalities`、`input_modalities`、
  `modalities.input`、`input`、`architecture.modality`（如 `text+image->text`），
  以及 `capabilities.vision`、`supports_vision`、`vision` 等布尔标志。
- **思考等级** — `reasoning.supported_efforts`、`reasoning.efforts`、
  `reasoning_efforts`、`thinking_levels`、`supported_thinking_levels`、
  `parameters.reasoning_effort.enum`，并把厂商写法映射到 pi-ai 的词汇表
  （`none` → `off`、`mid` → `medium`、`extra high` → `xhigh`、`ultra` → `max`）。

两种列表封装格式都会读取：OpenAI 的 `{ "data": [...] }` 数组，以及部分网关使用的
`{ "models": { "<id>": {…} } }` 映射。

**端点没有披露的能力一律不写。** 这里猜测的代价高于留空：`contextWindow` 猜大会导致
对话被静默截断，`input` 猜错会让本该支持的图片无法发送。

## 写入范围与策略

只处理**你自己 profile 层声明**的路由。由已安装 bundle 声明的路由不会被改动，否则会把
该路由冻结成一份副本，遮蔽 bundle 后续的更新。

默认策略是「已有值优先」，只补空字段；设置 `overwrite: true` 才会覆盖列表披露的值。

写入经由 settings 服务，因此落在 profile 自己的 `cordis.patch.yml`，走正常 Loader 流程
生效，无需重启。

## 公开目录兜底

很多转售网关的 `/models` 只返回 `{"id":"...","object":"model"}`，没有任何能力字段。
此时插件会查询公开目录 [models.dev](https://models.dev)（约 5.8 MB，缓存在
`$DSH_HOME/cache/model-capability-detector/catalog.json`，有效期 7 天）。

**但兜底按字段分级，不是全盘采信。** 因为同一个模型名在不同渠道下含义不同——转售商常见
截断上下文。实测同名条目的跨渠道一致率：

| 字段 | 一致率 | 默认 |
|---|---|---|
| 识图能力 | 87.1% | 启用 |
| 思考挡位 | 79.4% | 启用 |
| 上下文长度 | 52.1% | **关闭**，需 `catalogNumbers: true` |
| 输出上限 | 47.3% | **关闭**，需 `catalogNumbers: true` |

理由：上下文猜大会静默截断对话，是最糟的失败模式；识图或挡位出错会立刻暴露（发不了图、
API 拒绝请求），不会静默出错。

进一步地，即使字段已启用，也只有当**该名称下的所有目录条目取值一致**时才会写入。存在冲突
时保留候选值并记入日志，交由你判断。

### 名称归一化

第三方渠道的命名差异由两级归一化处理：先剥掉首个 `/` 之前的 provider 段，再转小写并删除
所有非字母数字字符。因此 `GPT-6.1-SOL`、`gpt_6_1_sol`、`Gpt-6.1-Sol`、
`openai/gpt-6.1-sol` 都会落到同一身份。

两种情形会明确拒绝而非猜测：

- **无法匹配**：`gpt-9-ultra`、带日期后缀的 `gpt-6.1-sol-2026-01-01` 返回 unknown，
  留给你手填。
- **身份歧义**：若同一名称能指向两个不同的目录身份（例如带日期与不带日期是不同条目），
  返回 ambiguous，绝不取第一个。

## 诊断日志

DSH 的 logger 只保留 1000 条内存环形缓冲，本部署没有注册任何落盘 sink，所以插件失败时
**磁盘上没有任何记录**——"决定不写"和"从未运行"无法区分。这是排查困难的根因。

设置 `logFile` 可开启一个可选的 JSONL 诊断日志：

```yaml
    logFile: "~/.dsh/logs/model-capability-detector.log"
```

记录每次探测的路由、披露字段数、目录命中与冲突、写入计划与结果。**不记录任何凭据**：
URL 会剥离 query string，密钥与响应体永不写入。单文件超过 2 MiB 时轮转一次保留历史。

留空即关闭（默认），不产生任何磁盘写入。

## 关于 HMR 事务的限制

`settings.update` 最终会调用 `configEditor.edit`，后者把工作包在 `hmr.runExclusive` 里，
遇到嵌套事务会抛 `HMR transactions cannot be nested`。而 Loader 激活插件本身就在这个
独占作用域内执行，`app-boot/config-reload` 也从内部发布，所以由此启动的探测会通过
定时器和 Promise 继承该事务标记。

因此写在 `AsyncLocalStorage.exit` 下执行——这是离开该作用域唯一有文档保证的方式。换成
新建 `AsyncResource` 无效：它捕获的是构造时的 store，而 `apply` 执行时已经在事务内。

这一点经过端到端验证，而不只是单元测试：安装后向 profile 加入一条指向公开列表的临时
路由，该路由的 `contextWindow`、`maxTokens`、`input`、`reasoningEfforts` 全部被自动
填入，随后移除该路由并还原 profile。

## 配置项

编辑 profile 的 `cordis.patch.yml` 中对应行：

```yaml
- id: dsh-model-capability-detector
  name: "dsh-model-capability-detector"
  config:
    settingsNs: llm-pi-ai     # 要填充的适配器 profile 条目 id
    enabled: true             # false 完全关闭自动探测
    overwrite: false          # true 覆盖你已设置的值
    dryRun: false             # true 只记录计划，不写 profile
    timeoutMs: 15000          # 单端点探测超时
    debounceMs: 800           # 配置变更后的静默期
    startupDelayMs: 3000      # 启动兜底扫描的延迟
    maxResponseBytes: 4194304
    catalogFallback: true     # false 完全不查询公开目录
    catalogUrl: "https://models.dev/api.json"
    catalogTimeoutMs: 30000   # 目录下载超时
    catalogMaxBytes: 16777216 # 目录体积上限
    catalogTtlMs: 604800000   # 缓存有效期，默认 7 天
    catalogNumbers: false     # true 时也采信上下文长度与输出上限
    logFile: ""               # 诊断日志路径，留空关闭
```

接入新网关时建议先设 `dryRun: true`：只会在日志里列出将要写入的内容，不改动 profile。

## 凭据使用

探测请求使用路由自身的 `apiKeyEnv` 引用，经 credentials 服务在调用时解析——与适配器用
的是同一个引用，因此在「模型」页轮换密钥后无需重启即可生效。未配置 `apiKeyEnv` 的路由
以无鉴权方式探测，这对本地 vLLM、Ollama 是正确的。

路由上配置的自定义 `headers` 也会一并发送，因此需要额外请求头的网关同样能被探测。

## 失败行为

端点不可达、密钥被拒、列表无法解析时，只记录一条包含路由名与原因的警告，不做任何改动，
也不会阻塞导入：本插件运行时配置已经保存完毕。

若两次写入竞争，过期版本的写入会被拒绝，随后的文档事件会基于新值再触发一次探测。

## 目录结构

```
index.js              Host 插件：配置监听、端点探测、兜底查询、回写
lib/detect.js         纯函数：列表解析、等级归一化、URL 与请求头构造
lib/plan.js           纯函数：把探测结果合并进已配置的模型行，含字段分级
lib/catalog.js        纯函数：公开目录索引、名称归一化、一致性判定、缓存
lib/diagnostics.js    可选的 JSONL 诊断日志，含脱敏与轮转
test/detect.test.mjs       列表解析与合并的单元测试
test/catalog.test.mjs      目录兜底与名称归一化的单元测试
test/diagnostics.test.mjs  日志脱敏、并发与轮转的测试
test/fallback.test.mjs     兜底在真实 pass 中的集成测试
test/plugin.test.mjs       apply() 的行为测试（含 HMR 事务场景）
test/live-probe.mjs        对公开列表的只读探测脚本
cordis.patch.yml           本包插入的 bundle 行
```

## 运行测试

```bash
node --test test/detect.test.mjs test/catalog.test.mjs test/diagnostics.test.mjs test/fallback.test.mjs test/plugin.test.mjs
```

## 安装

以本地目录方式安装到当前 profile：

```
plugin_manager install_bundle target=<本目录绝对路径>
```

或使用 DSH CLI：

```bash
dsh plugin --profile <profile> add ./dsh-model-capability-detector
```

发布到 npm 后，也可以直接从注册表安装。

## 已知边界

- 只处理 profile 自己层声明的路由；bundle 声明的路由留给声明方维护。
- 端点未披露的字段保持原样，不进行推断。
- 目录兜底按字段分级：数值字段默认关闭，需要 `catalogNumbers: true` 显式开启。
- 名称无法匹配或身份存在歧义时一律不写，交由你手填。
- 纯 Host 侧实现，无独立 UI；结果通过 profile 配置与诊断日志体现。

