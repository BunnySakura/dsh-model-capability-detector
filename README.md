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

## 数据优先级与上下文冲突

| 来源 | 行为 |
|---|---|
| 已有配置 | 默认保留；`overwrite: true` 才会替换 |
| 当前渠道 API | 对披露字段优先于公开目录 |
| 公开目录数值 | 默认取同一已解析模型身份的最小有效正安全整数 |
| 公开目录输入模态 | 已披露的条目必须一致，否则不填 |
| 公开目录推理等级 | 取已披露等级的交集；明确支持/不支持推理的冲突不填 |
| 无数据或身份歧义 | 保持空白，等待手工填写 |

例如目录记录 `128000`、`131072`、`200000`，默认填写 **128000**，不按 K/M 四舍五入。token 数本来就应该是整数；把候选值取整不能解决不同渠道的容量差异，数值越大也不代表信息越准确。非整数、0、负数及超出 JavaScript 安全整数范围的值会被忽略。

最小值是一种保守估计，**不能保证未公开的转售渠道也支持这个容量**，也可能导致提前压缩上下文。更精确的渠道 API 数据或你手工设置的容量应优先。插件不会发送推理请求来探测真实上限，不会消耗聊天 token。

可选择更严格的策略：

```yaml
catalogNumericStrategy: consensus  # 数值只有完全一致才填
# 或：
catalogNumbers: false              # 关闭上下文与输出上限的目录兜底
```

`catalogFallback: false` 则完全关闭公开目录。API 只披露部分字段时，目录只补其余字段；API 已披露全部待填字段时不下载目录。API 不可达时仍可用目录补齐缺失字段，但后续设置变化仍允许重试 API。

目录缓存位于 `$DSH_HOME/cache/model-capability-detector/catalog.json`，默认 7 天有效；切换源 URL 会使旧源缓存失效，缓存仅保存源 URL 的 SHA-256 指纹。刷新失败可以使用同源同版本的过期缓存。缓存格式升级后旧缓存会重新获取。

### 名称匹配

先去掉最后一个 `/` 之前的前缀，再转小写并保留字母数字。因此 `GPT-6.1-SOL`、`gpt_6_1_sol`、`openai/gpt-6.1-sol` 可命中同一身份。日期、版本等尾缀不会被主动删除。同名可达多个不同目录身份时拒绝填写，不任取一条。

## API 解析

| 配置字段 | 常见 API 字段 |
|---|---|
| `contextWindow` | `contextWindow`、`context_window`、`context_length`、`max_model_len`、`max_input_tokens`、`limit.context`、`top_provider.context_length` |
| `maxTokens` | `max_output_tokens`、`max_tokens`、`max_completion_tokens`、`limit.output`、`top_provider.max_completion_tokens` |
| `input` | `architecture.input_modalities`、`modalities.input`、`input`、`supports_vision`、`vision` 等 |
| `reasoningEfforts` | `reasoning.supported_efforts`、`reasoning_efforts`、`thinking_levels`、`parameters.reasoning_effort.enum` 等 |

支持 `{data:[...]}`、`{models:{id:{...}}}`、`{models:[...]}` 和顶层数组。模型映射的 key 是实际请求 ID，优先于条目内的 canonical id。等级会归一化到 pi-ai 词汇，例如 `none → off`、`mid → medium`、`extra high → xhigh`；仅声明支持推理而未披露等级时不会凭空生成等级。

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
    catalogNumericStrategy: minimum
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

通过 DSH 的插件管理器安装本地目录或已发布包；Agent 使用 `plugin_manager` 的 `install_bundle` 操作，目标为插件目录绝对路径。安装会影响当前 profile 的所有会话，请在希望启用该版本时执行。

主要实现位于 `index.js`、`lib/catalog.js`、`lib/detect.js`、`lib/discovery.js`、`lib/http.js` 和 `lib/diagnostics.js`。本插件无独立 UI，不修改 DSH 安装文件，也没有安装脚本或运行时下载依赖。
