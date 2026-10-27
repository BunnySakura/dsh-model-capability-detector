# 更新记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
