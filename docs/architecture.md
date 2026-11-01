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
| `lib/official.js` | 原厂记录：内置核验记录与 models.dev 原厂镜像 |
| `lib/sources.js` | OpenRouter 与 LiteLLM 的下载、索引、缓存和投票 |
| `lib/tiers.js` | 把原厂记录与第三方来源合成一次解析，并定义来源等级 |
| `lib/names.js` | 模型名归一化与别名 |
| `lib/provenance.js` | 来源回执：记录插件写过哪些值、来自哪一档 |
| `lib/discovery.js` | 对 `llm.discoverModels` 的可卸载包装与短期内存缓存 |
| `lib/diagnostics.js` | 脱敏与 JSONL 诊断日志 |
| `lib/http.js` | 按字节限制读取 JSON 响应 |
| `lib/fsutil.js` | 先写临时文件再重命名的原子写入，缓存、回执和设置共用 |
| `lib/update-host.js` | Host 路由与只读 Agent 工具 |
| `lib/updates.js` | GitHub Releases 检查 |

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
| `/updates` | GET | 读取更新状态（缓存 24 小时） |
| `/updates` | POST | `{ action: "check", refresh }`，检查最新稳定版 |
| `/settings` | GET | 返回生效值、默认层、已保存覆盖项、字段范围、revision |
| `/settings` | POST | `{ revision, set, unset }`，原子保存一组变更 |
| `/detector` | GET | 检测报告 |
| `/detector` | POST | `{ action: "lookup", model }` 试查；`{ action: "rescan" }` 重新检测 |

所有 POST 要求 `content-type: application/json`、自定义请求头 `x-model-capability-detector: 1`，请求体不超过 16 KiB。自定义头会触发浏览器的跨域预检，外部页面因此无法直接写入。状态码：缺少请求头 403、类型不对 415、过大 413、JSON 无效 400；设置保存的冲突 409、校验失败 400、只读 403、写盘失败 500。

报告与试查只读已保存的 profile 和公开来源，不联系渠道，返回内容里没有地址、密钥或请求头。

只读 Agent 工具 `model_capability_detector_updates` 与 `/updates` 共用同一份检查，只能查询。

## 浏览器端

`client.js` 把设置页注册到 `plugins.bundle.config` 槽位，键为包名，所以只出现在本插件自己的详情页。

- 界面的字段范围来自 `/settings` 返回的 `fields`，不在前端重复定义。
- 保存把改动字段放进 `set`，重置字段放进 `unset`。冲突时载入最新值并提示。
- 更新通过 `remote.pluginManager.installBundle(spec, { enabled: true, requestId })` 交给 DSH 插件管理器。页面只接受 `git+https://github.com/BunnySakura/dsh-model-capability-detector.git#<稳定版标签>` 形式的目标，Host 生成时也按同一规则校验。

## 来源回执

每次写入成功后，`provenance.json` 记录字段、值、来源种类和时间，键是路由、模型、字段三元组的 SHA-256，因此不含渠道地址、密钥或明文路由名。最多保留最近 5000 条。

回执是升级的依据：只有当前值与回执里的值相同，才认定它是插件写的；用户改过或手填的值没有匹配的回执，永远不会被升级。

## 安全边界

- 渠道请求拒绝重定向，避免自定义认证头被转发；响应按实际字节限制，超限即取消。
- 渠道凭据通过 DSH 凭据服务即时取用。草稿只在端点和协议与已保存渠道一致时才复用其凭据和请求头；换地址后需提供新凭据，显式输入的密钥优先。
- 请求头或密钥无效时抛出固定消息，不引用原值。
- 公开来源只用固定的 URL（models.dev 地址可配置，但只接受不含凭据的 http(s)），请求不带凭据，响应有字节上限。
- 日志与诊断在写入边界统一脱敏，不输出原始错误对象、请求头或响应体。
- 更新目标由代码拼接，只指向本项目仓库的稳定版标签，不接受外部传入的地址。
