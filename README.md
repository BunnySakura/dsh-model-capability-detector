# dsh-model-capability-detector

在 DSH 中添加或保存第三方 API 渠道时，自动补全模型的上下文长度、最大输出、识图能力和推理等级，不必逐个手填。

> English: [README.en.md](README.en.md)

## 功能

- 点击「获取可用模型」时，立刻为每个模型补全能力，并交给编辑草稿。这一步本身不保存配置。
- 保存或修改渠道、重载配置、启动数秒后，在后台为空字段补值。
- 只补空字段。你手填的值不会被改动。
- 设置页提供检测报告，告诉你每个字段的值来自哪里，没填上的原因是什么。

## 安装

在 DSH「插件」页的安装输入框填写：

```text
https://github.com/BunnySakura/dsh-model-capability-detector
```

要固定版本，在地址末尾加 `#<标签>`，例如 `#1.4.0`，该标签必须已在 GitHub 上。也可以安装本地目录（绝对路径）或 `.tgz` 压缩包。安装影响当前 profile 的全部会话。

需要 Node.js 20.3.0 或更高版本，以及满足包内声明的 DSH 版本。无需编译，也不执行安装脚本。

## 设置

打开「插件」页，进入本插件的详情页，所有选项都在页面里，保存后立即生效，只有「启动延迟」要等下次启动。点「重置」可让某个字段回到默认值。

此外还可以在 profile 的 `cordis.patch.yml` 里为本插件写 `config`。取值优先级从低到高：内置默认值、`config`、设置页保存的值。设置页保存的值写在 `$DSH_HOME/model-capability-detector/settings.json`，只含下表的选项，不含密钥。

| 选项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后停止后台检测和模型页增强 |
| `settingsNs` | `llm-pi-ai` | 保存渠道配置的设置命名空间 |
| `discoveryTrigger` | `true` | 在「获取可用模型」时补全草稿 |
| `overwrite` | `false` | 用新结果覆盖已有值 |
| `dryRun` | `false` | 只计算不写入，配合日志查看计划 |
| `timeoutMs` | `15000` | 单次渠道模型列表请求的超时 |
| `maxResponseBytes` | `4194304` | 渠道响应大小上限，超过即取消 |
| `debounceMs` | `800` | 合并短时间内连续的渠道改动 |
| `startupDelayMs` | `3000` | 启动后多久做一次兜底扫描 |
| `catalogFallback` | `true` | 允许使用公开来源，关闭后连内置规格也不用 |
| `catalogNumbers` | `true` | 允许公开来源补上下文和最大输出 |
| `catalogNumericStrategy` | `official` | `official` 为分档取值；`minimum`、`consensus` 为旧版兼容模式 |
| `thirdPartySources` | `true` | 允许参考 OpenRouter 和 LiteLLM |
| `upgradeWritten` | `true` | 出现更强来源时升级插件早先写入的值 |
| `modelAliases` | `{}` | 模型名别名，格式见下文 |
| `catalogUrl` | `https://models.dev/api.json` | models.dev 目录地址，只接受不含凭据的 http(s) |
| `catalogTimeoutMs` | `30000` | 目录请求超时 |
| `catalogMaxBytes` | `16777216` | 目录大小上限 |
| `catalogTtlMs` | `604800000` | 公开来源缓存有效期，7 天 |
| `logging` | `false` | 向 DSH 日志输出脱敏的诊断信息 |
| `logFile` | `""` | 诊断日志路径，相对路径基于 DSH 主目录，非空时也启用日志；在设置页保存时须位于主目录内 |
| `updateCheckOnStartup` | `false` | 启动约 10 秒后检查一次新版本 |

写在 `cordis.patch.yml` 里的例子：

```yaml
- id: dsh-model-capability-detector
  name: dsh-model-capability-detector
  config:
    timeoutMs: 20000
    modelAliases:
      my-gateway-gpt: gpt-4o
```

`config` 里的无效值会被忽略并记入日志，不会让插件加载失败。

## 能力值从哪里来

每个字段按下面的顺序取值，越靠前越优先：

1. **渠道 API**：渠道模型列表里含义明确的字段，如 `context_length`、`max_output_tokens`。
2. **原厂文档**：内置的核验记录，以及 models.dev 里带原厂文档域名的原厂记录。
3. **权威第三方**：OpenRouter、LiteLLM、models.dev 三家中至少两家一致才采用。数值相差 5% 以内算一致，取较小的值。
4. **API 参考值**：`max_input_tokens` 和 `max_tokens` 在各家网关里含义不一，只在前面都没有值时才用。

推理等级只来自渠道 API 和原厂记录。渠道只列 `deepseek-v4.1-flash`、原厂只登记带日期的 `deepseek-v4.1-flash-1017` 时，若该厂商所有带日期快照给出相同等级，会据此推断，并在报告里标「同系快照推断」。上下文和最大输出不做这种推断。原厂规格是模型本身的能力，**不保证第三方渠道开放同样的上限**。

模型名对不上时，可以在设置页「模型名别名」里每行写一条 `渠道里的名字 = 标准模型名`。别名精确匹配，不嵌套。

具体规则见 [数据来源与取值规则](docs/data-sources.md)。

## 检测报告

设置页的「检测报告」按渠道和模型列出每个字段的值和来源，没填的会写明原因：

| 原因 | 含义 | 可以怎么办 |
|---|---|---|
| 没有原厂记录 | 找不到这个模型 | 配别名，或手填 |
| 原厂记录未给出 | 记录里没有这一项 | 手填 |
| 原厂记录不一致 | 不同原厂记录给出了不同的值 | 手填 |
| 没有第三方数据 | OpenRouter 和 LiteLLM 都没收录 | 配别名，或手填 |
| 只有一家第三方来源 | 凑不够两家 | 手填 |
| 第三方来源不一致 | 数值相差明显且票数相同 | 手填 |
| 公开来源已关闭 | `catalogFallback` 为 `false` | 打开该选项 |

「试查模型名」输入一个名字，就能看到它会解析成什么，以及各第三方来源的取值，不改任何配置。「立即重新检测」会马上跑一轮。这三项都不联系你的渠道，也不显示地址、密钥或请求头。

## 常见问题

**为什么有的值我没改过却变了？** 插件早先用较弱来源写入的值，出现更强来源时会自动升级。你手填或改过的值不会动。在设置里关闭「升级插件写入的值」可禁止升级。

**怎么让它覆盖已有值？** 打开 `overwrite`，或先清空那个字段再保存。

**怎么完全不访问公开来源？** 把 `catalogFallback` 设为 `false`，只用渠道 API。只想不访问 OpenRouter 和 LiteLLM，把 `thirdPartySources` 设为 `false`。

**「获取可用模型」没有反应或报错？** 插件通过包装 DSH 的 `llm.discoverModels` 方法接入，DSH 更新后可能不兼容。把 `discoveryTrigger` 设为 `false` 关掉这一接入，保存和重载时的后台补全不受影响。

## 隐私与网络

- **渠道请求**：向你配置的渠道发 `GET {baseURL}/models`（Anthropic 为 `/v1/models`）。API key 通过 DSH 的凭据服务即时取用，请求拒绝重定向。
- **公开来源**：models.dev 目录、`openrouter.ai/api/v1/models`、GitHub 上 LiteLLM 的 `model_prices_and_context_window.json`。请求不带任何凭据和用户数据，响应有大小上限。
- **更新检查**：默认关闭。开启后只访问本项目的 GitHub Releases。
- **本地文件**，都在 `$DSH_HOME` 下，不含密钥、渠道地址和请求头：
  - `cache/model-capability-detector/` 里是公开来源缓存和来源回执。回执用来判断某个值是不是插件写的，其中路由名和模型名已做哈希。
  - `model-capability-detector/settings.json` 保存设置页的取值。
- **日志**默认全部关闭。开启后，URL 里的账号、查询参数和常见凭据格式都会被脱敏。路由名和模型名仍可能暴露你的部署，分享日志前请先检查。

## 更新

设置页的「检查更新」会读取本项目 GitHub Releases 的最新稳定版。有新版本时，确认后由 DSH 插件管理器完成安装，兼容性检查、脚本授权和是否需要重启都由它决定。Agent 另有只读工具 `model_capability_detector_updates`，只能查询，不能安装。

版本变化见 [更新记录](CHANGELOG.md)。

## 文档

- [设计与架构](docs/architecture.md)
- [数据来源与取值规则](docs/data-sources.md)
- [开发与发布](docs/development.md)

## 许可证

[MIT](LICENSE)
