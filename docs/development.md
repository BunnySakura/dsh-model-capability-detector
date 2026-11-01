# 开发与发布

本文面向维护者。设计见 [设计与架构](architecture.md)，取值规则见 [数据来源与取值规则](data-sources.md)。

## 环境

- Node.js 20.3.0 或更高（用到 `AbortSignal.any`）。
- 无运行时依赖，也无构建步骤，仓库根目录就是可安装的包。
- 对 `@deepseek-ai/cordis`、`@deepseek-ai/dsh` 只声明 peer 依赖，版本范围见 `package.json`。

## 测试

```sh
node scripts/run-tests.mjs
```

`pnpm test` 或 `npm test` 调用同一个入口。入口自己列出 `test/*.test.mjs`，不依赖 shell 展开通配符，也不依赖各 Node 版本对 `node --test` 目录参数的不同处理，所以 Windows 和 Node 20 到 24 行为一致。测试用合成数据和假的 `fetch`，不读取真实渠道，也不需要任何密钥。

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

`scripts/live-probe.mjs` 不属于自动测试，是一个只读脚本：向一个公开的 OpenAI 兼容地址请求模型列表并打印解析结果，用来肉眼核对解析器。运行 `node scripts/live-probe.mjs [baseURL]`，不读取任何凭据。它放在 `scripts/` 而不是 `test/`，避免被测试入口当成测试执行。`scripts/` 不随包发布。

离线测试不等于界面验收。改动设置页、`llm.discoverModels` 包装或插件管理器调用时，要在真实的 DSH 里检查一遍。

### 尚待在真实 DSH 里验证

- 设置页里通过 `remote.pluginManager` 取得插件管理器；取不到时页面会提示手动安装目标，但这个取法没有在真实 DSH 里验证过。
- `installBundle` 的返回结构按文档类型编写，实际的「需要重启」「需要批准脚本」提示没有真实验证过。
- 「获取可用模型」的包装依赖 DSH 的 `llm.discoverModels` 与 `llm.listConfigurableProviders`，DSH 升级后需要重新验证。

## 打包

```sh
pnpm pack
```

`package.json` 的 `files` 决定包内容：应只含入口、`client.js`、`lib/`、`data/`、`locale/`、`cordis.patch.yml`、图标、文档和 LICENSE，不应含测试、脚本、缓存、日志或本机路径。不必真的打包，用干跑检查清单：

```sh
npm pack --dry-run --json | node scripts/check-pack.mjs
```

`*.tgz` 已被 `.gitignore` 忽略，不要提交。

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
2. 跑完整测试和 `node scripts/privacy-scan.mjs`，用 `npm pack --dry-run --json | node scripts/check-pack.mjs` 检查包清单。
3. 提交，再按上节写附注标签。
4. 先推送提交，等 CI 通过。再推送标签，建 Release，说明框留空。压缩包不是必需的：安装目标直接指向 git 标签，不读取 Release 附件。

## 公开仓库的隐私检查

代码会公开在 GitHub，提交前确认：

- 没有 API key、令牌、Cookie、`.env` 内容。
- 没有本机绝对路径、用户名、profile 名称、渠道地址。测试用的地址只用 `example.test` 之类的保留域名。
- 日志、缓存、压缩包没有被提交。`.gitignore` 已忽略 `*.log`、`*.jsonl`、`.env*`、`logs/`、`cache/`、`*.tgz`。
- 文档与代码注释里没有对话过程、个人备注。

用脚本扫描：

```sh
node scripts/privacy-scan.mjs
```

脚本读取包目录下的文本文件，查本机用户路径、`.dsh` 的 profile 与运行时路径、API key、Bearer 令牌、GitHub 令牌、云访问密钥、私钥块、`.env` 式赋值和个人邮箱。`example.test` 这类保留域名和 `<name>` 这类占位写法不算。命中时只打印文件、行号和类别，不打印匹配到的内容；有命中则退出码为 1。

测试里故意写的假密钥，在同一行加注释 `privacy-scan: allow` 放行；真实内容不要用这个标记。脚本不检查 Git 历史，历史由 CI 里的 gitleaks 扫描。第一次推送前，在本地对完整历史也跑一次。

## CI

`.github/workflows/ci.yml` 在推送到 `main` 和每个 Pull Request 上运行：

- 测试矩阵：Ubuntu 与 Windows，Node 20、22、24。
- 隐私扫描 `scripts/privacy-scan.mjs`。
- 打包清单检查：`npm pack --dry-run --json | node scripts/check-pack.mjs`。缺入口文件，或含测试、脚本、日志、`.env`，都会失败。
- gitleaks 扫描完整历史。

工作流只申请 `contents: read`。

工作流里把 gitleaks 固定在 8.30.1（`GITLEAKS_VERSION`）。`gitleaks-action@v2` 不指定版本时装 8.24.3，该版本不应用 `.gitleaks.toml` 里的放行，会把假密钥报成泄露（用 8.24.3 在本地复现过：只扫最后一个提交也会在 `test/diagnostics.test.mjs` 报 1 处）。升级这个版本号前，先用新版本在本地对历史和工作区各扫一遍。

gitleaks 的配置是仓库根目录的 `.gitleaks.toml`：保留全部默认规则，只对 `generic-api-key` 放行 `test/diagnostics.test.mjs` 里那个脱敏测试用的假密钥（按精确值匹配）。换一个值，或在别处出现同类密钥，仍会被报出。要放行新的假数据，先确认它确实是假的，再在配置里加一条精确值，不要放行整个目录。

本地复现 CI 的扫描：下载 gitleaks 官方发布版并核对 SHA-256 后，在仓库里运行 `gitleaks git . --redact`（历史）和 `gitleaks dir . --redact`（工作区），退出码 0 为通过。`--redact` 让输出里的密钥值打码。

## 本地开发安装

不要用 profile 的 `link:` 依赖安装正在开发的插件，再通过设置页或插件市场更新它。`link:` 在 `node_modules` 里是指向工作目录的 Junction。Windows 上插件管理器（pnpm）替换这个目录时报 `EPERM`；失败之后，开发目录的 `.git` 里曾三次少了 `HEAD`、`config`、`index`，工作区文件没有受损，`objects` 和 `refs` 也在。

原因是推断，没有复现：pnpm 的 `renameOverwrite` 在重命名遇到 `EPERM` 时，会对目标路径执行 `rimraf` 并忽略它的错误，然后重试约 60 秒。目标是 Junction 时，`rimraf` 可能沿链接删开发目录，在 Git 的只读对象文件处停下，缺失的文件正好是目录顺序里排在 `objects` 之前的那几个。在隔离目录里用同一版 pnpm 做过替换 `link:`、移除依赖、残留 Junction 后重装三种复现，pnpm 都报「已是最新」，没有走到替换步骤。

做法：

- 测试安装流程时，用开发目录的副本，或先摘掉 Junction：`cmd /c rmdir <node_modules 里的路径>`。不要对 Junction 做递归删除。
- 插件检测到自己位于开发检出目录时不提供更新（见[架构](architecture.md)）。更新开发副本，直接在工作目录里用 git。
- 如果 `git` 报「不是 Git 仓库」，先看 `.git` 里是否少了 `HEAD`、`config`、`index`。已推送的内容都在 GitHub 上，不需要事先备份：补回这三个文件（`HEAD` 写 `ref: refs/heads/main`，`config` 配好 `origin`），再 `git reset` 重建索引，或者直接重新克隆。要留意的只有尚未推送的提交和标签，先确认 `git log origin/main..HEAD` 还能看到它们。

## 排错与经验

- **CI 里的工具版本以 CI 实际安装的为准。** GitHub Action 常带着自己的默认版本：`gitleaks-action@v2` 默认装 8.24.3，它不应用 `.gitleaks.toml` 里的放行，本地用更新的版本验证会得出相反结论。在工作流里固定版本，推送前用同一版本、同一条命令在本地复现。
- **用退出码判断扫描是否通过，不要匹配输出文字。** gitleaks 的「no leaks found」也包含「leaks found」，按文字匹配会把通过当成失败。
- **检测类工具要正反都验证。** 干净的输入不报，有问题的输入必须报；放行规则要再试一个不同的值，确认它仍被报出，没有放过头。
- **测试里的假密钥会触发扫描器。** 优先不写成像密钥的字面量；必须写时，在放行配置里按精确值放行，不放行整个目录或文件。
- **URL 里的用户信息会被邮箱规则误报。** `https://user:pass@host` 里的 `pass@host` 形似邮箱，邮箱规则要排除前面带 `:` 或 `/` 的情况。
- **先推送提交，CI 通过后再推送标签和建 Release。** 为修 CI 而移动已推送的标签，会让装过旧标签的人拿到不同的内容。
- **破坏性实验放在临时目录里，并隔离环境。** 把 `LOCALAPPDATA`、`APPDATA`、`XDG_*`、`PNPM_HOME` 和 pnpm 的 `--store-dir` 指到临时目录，只对当前进程设置；清理前先摘掉其中的 Junction，再删除目录，并检查路径确实在临时目录下。
- **实验没走到被测的步骤，就不能当作「没问题」。** pnpm 报「已是最新」时，要先让它真的执行替换，再下结论。

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
