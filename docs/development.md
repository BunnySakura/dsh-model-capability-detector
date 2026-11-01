# 开发与发布

本文面向维护者。设计见 [设计与架构](architecture.md)，取值规则见 [数据来源与取值规则](data-sources.md)。

## 环境

- Node.js 20.3.0 或更高（用到 `AbortSignal.any`）。
- 无运行时依赖，也无构建步骤，仓库根目录就是可安装的包。
- 对 `@deepseek-ai/cordis`、`@deepseek-ai/dsh` 只声明 peer 依赖，版本范围见 `package.json`。

## 测试

```sh
node --test test/*.test.mjs
```

测试用合成数据和假的 `fetch`，不读取真实渠道，也不需要任何密钥。

| 文件 | 覆盖 |
|---|---|
| `detect.test.mjs` | 渠道模型列表解析、推理等级归一化、含义不明字段 |
| `catalog.test.mjs` | 目录索引、缓存新鲜度、响应字节限制、旧版策略 |
| `official.test.mjs` | 原厂记录、名称匹配、白名单 |
| `tiers.test.mjs` | 名称归一化、第三方一致与容差、合并顺序、升级、缓存与部分失败 |
| `fallback.test.mjs` | 目录兜底的整合行为 |
| `plugin.test.mjs` | 插件整体：触发、写入、卸载取消、实时设置、报告、试查、重新检测、升级 |
| `state.test.mjs` | 来源回执、Host 路由的鉴权头、设置存储与校验 |
| `updates.test.mjs` | 更新检查，以及设置页的保存、更新、别名、报告 |
| `discovery.test.mjs` | `llm.discoverModels` 包装 |
| `diagnostics.test.mjs` | 日志脱敏与轮转 |

`test/live-probe.mjs` 不属于自动测试，是一个只读脚本：向一个公开的 OpenAI 兼容地址请求模型列表并打印解析结果，用来肉眼核对解析器。运行 `node test/live-probe.mjs [baseURL]`，不读取任何凭据。

离线测试不等于界面验收。改动设置页、`llm.discoverModels` 包装或插件管理器调用时，要在真实的 DSH 里检查一遍。

### 尚待在真实 DSH 里验证

- 设置页里通过 `remote.pluginManager` 取得插件管理器；取不到时页面会提示手动安装目标，但这个取法没有在真实 DSH 里验证过。
- `installBundle` 的返回结构按文档类型编写，实际的「需要重启」「需要批准脚本」提示没有真实验证过。
- 「获取可用模型」的包装依赖 DSH 的 `llm.discoverModels` 与 `llm.listConfigurableProviders`，DSH 升级后需要重新验证。

## 打包

```sh
pnpm pack
```

`package.json` 的 `files` 决定包内容，打包后用 `tar -tf` 检查清单：应只含入口、`client.js`、`lib/`、`locale/`、`cordis.patch.yml`、图标、文档和 LICENSE，不应含测试、缓存、日志或本机路径。`*.tgz` 已被 `.gitignore` 忽略，不要提交。

## 提交与标签

提交记录一次改动，标签记录一个版本，两者的日志各写各的内容。

### 提交信息

- 格式 `<类型>: <一句话概述>`，类型取 `feat`、`fix`、`docs`、`test`、`refactor`、`chore`。
- 概述写这次改了什么，用中文。**不写版本号**：不要出现「(1.5.0)」这类标注，版本由标签表达。
- 一句话说不完时，空一行，再用 `- ` 列表逐条写要点。不写对话过程和个人备注。
- 一个提交只做一件事。功能代码、对应测试、`CHANGELOG.md` 条目和架构文档放在同一个提交；只改规范或说明的文档单独提交。
- 只有尚未推送的提交可以随意整理。已被用户安装的版本，其提交和标签不改写。

### 标签注释

- 标签名不带 `v`，例如 `1.5.0`，必须是附注标签，指向版本提交。
- 注释就是该版本的发布说明：第一行是版本号，空一行后写变更，分「新增与变更」「修复」两组，每条以 `- ` 开头，内容与 `CHANGELOG.md` 的该版本条目一致。
- 注释用文件写入，避免命令行转义和编码问题：`git tag -a <版本> -F <说明文件> --cleanup=whitespace`。说明文件用 UTF-8 无 BOM，`--cleanup=whitespace` 保证以 `#` 开头的行不被当作注释删掉。
- Release 的说明框留空即可：GitHub 的 Release 页面会显示这段注释；插件的更新检查在 Release 说明为空时，也读取同名标签的注释并显示在设置页（1.5.0 起；更早的版本只显示 Release 页面链接）。

## 发布规则

- 遵循语义化版本。
- **只给稳定版打标签。** 开发中的改动并入下一个版本，不为中间状态单独发版本或打标签。
- 在 GitHub 上建 Release 时选择已推送的同名标签，并标为正式版：更新检查只接受非草稿、非预发布、符合语义化版本的发布，安装目标由此拼出 `git+https://github.com/BunnySakura/dsh-model-capability-detector.git#<标签>`。
- 标签和提交推送前，先确认它们没有包含密钥或本机路径（见下节）。

发布步骤：

1. 更新 `package.json` 的 `version`，在 `CHANGELOG.md` 写入该版本条目。
2. 跑完整测试，`pnpm pack --dry-run` 检查清单。
3. 提交，再按上节写附注标签。
4. 推送提交和标签，建 Release，说明框留空。压缩包不是必需的：安装目标直接指向 git 标签，不读取 Release 附件。

## 公开仓库的隐私检查

代码会公开在 GitHub，提交前确认：

- 没有 API key、令牌、Cookie、`.env` 内容。
- 没有本机绝对路径、用户名、profile 名称、渠道地址。测试用的地址只用 `example.test` 之类的保留域名。
- 日志、缓存、压缩包没有被提交。`.gitignore` 已忽略 `*.log`、`*.jsonl`、`.env*`、`logs/`、`cache/`、`*.tgz`。
- 文档与代码注释里没有对话过程、个人备注。

简单的扫描示例：

```sh
git grep -nE "C:\\\\Users|\\.dsh/profiles|sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9]{12,}"
```

没有输出才算通过。

## 文档约定

| 位置 | 面向 | 内容 |
|---|---|---|
| `README.md`、`README.en.md` | 用户 | 安装、设置、能力值来源概览、报告、常见问题、隐私与网络 |
| `docs/` | 维护者 | 架构、数据来源规则、开发与发布 |
| `CHANGELOG.md` | 用户与维护者 | 每个已发布版本的变化 |

约定：

- README 不放内部实现、测试方法、验证备注或对话式说明，这些放进 `docs/`。
- 两份 README 结构保持一致，改一份就同步另一份。
- 文档只写当前行为。已移除的功能删除相关描述，不保留「不再…」之类的历史说明；历史放在 CHANGELOG。
- CHANGELOG 只记录已发布的稳定版本。开发中的内容写在 `## [未发布]` 下，发布时改成版本号。
- `docs/` 目前只有中文。
