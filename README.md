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
    settingsNs: llm-pi-ai   # 要填充的适配器 profile 条目 id
    enabled: true           # false 完全关闭自动探测
    overwrite: false        # true 覆盖你已设置的值
    dryRun: false           # true 只记录计划，不写 profile
    timeoutMs: 15000        # 单端点探测超时
    debounceMs: 800         # 配置变更后的静默期
    startupDelayMs: 3000    # 启动兜底扫描的延迟
    maxResponseBytes: 4194304
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
index.js              Host 插件：配置监听、端点探测、回写
lib/detect.js         纯函数：列表解析、等级归一化、URL 与请求头构造
lib/plan.js           纯函数：把探测结果合并进已配置的模型行
test/detect.test.mjs  两个纯模块的单元测试
test/plugin.test.mjs  apply() 的行为测试（含 HMR 事务场景）
test/live-probe.mjs   对公开列表的只读探测脚本
cordis.patch.yml      本包插入的 bundle 行
```

## 运行测试

```bash
node --test test/detect.test.mjs test/plugin.test.mjs
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
- 纯 Host 侧实现，无独立 UI；结果通过 profile 配置与 Host 日志体现。
