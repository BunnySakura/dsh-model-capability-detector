# 更新记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0]

### 新增

- **公开目录兜底**：端点只返回 `id` 时，从 models.dev 补齐能力。索引按模型名归一化，
  先剥 provider 前缀再保留小写字母数字，因此大小写、连字符、下划线与前缀差异都能命中同一模型。
- **按字段分级采信**：识图能力与思考挡位默认启用（跨渠道一致率 87% / 79%）；上下文长度与
  输出上限默认关闭，需 `catalogNumbers: true` 显式开启（一致率仅 52% / 47%）。
- **一致性判定**：即使字段已启用，也只有当该名称下所有目录条目取值一致时才写入；存在冲突时
  保留候选值并记录日志。
- **歧义拒绝**：同一名称能指向两个不同目录身份时返回 `ambiguous`，绝不取第一个；无法匹配
  时返回 `unknown` 并留待手填。
- **目录缓存**：写入 `$DSH_HOME/cache/model-capability-detector/catalog.json`，默认 7 天；
  刷新失败时回退到过期缓存而非放弃。
- **可选诊断日志**：设置 `logFile` 后按 JSONL 记录探测路由、披露字段数、目录命中与冲突、
  写入计划与结果。URL 剥离 query string，密钥与响应体永不写入；超过 2 MiB 轮转一次。

### 变更

- `hasBlanks()` 移入 `lib/plan.js`，签名改为 `(providers, overwrite)`。
- `mergeDetected()` 新增第四个参数，接受兜底来源与允许字段，并回报哪些改动来自目录。

### 已知限制

- 端点未披露且目录无法匹配的字段保持原样，不做推断。
- 仅处理 profile 自身层声明的路由，bundle 声明的路由不介入。
- 无独立 UI，结果通过 profile 配置与诊断日志体现。

## [1.0.0]

首个版本。

### 新增

- 监听 `settings/document-updated` 与 `app-boot/config-reload`，在提供商配置保存后自动探测模型能力。
- 从 `GET {baseURL}/models` 读取上下文长度、输出上限、识图能力与思考等级，兼容 OpenAI、
  Anthropic、OpenRouter、vLLM、LiteLLM 等常见字段写法与两种列表封装格式。
- 通过 settings 服务把结果写回 profile 的 `llm-pi-ai` 配置，默认只补空字段，`overwrite` 可改为覆盖。
- `dryRun` 模式用于接入新网关前预览写入内容。
- 启动兜底扫描，覆盖插件未启用或端点不可达期间导入的配置。
- 在 `AsyncLocalStorage.exit` 下执行写入，避免 `HMR transactions cannot be nested` 拒绝。

### 已知限制

- 端点未披露的能力字段保持原样，不做推断。
- 仅处理 profile 自身层声明的路由，bundle 声明的路由不介入。
- 无独立 UI，结果通过 profile 配置与 Host 日志体现。
