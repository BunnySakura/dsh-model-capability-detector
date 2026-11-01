window.__ModuleLoader__.load({
  id: 'dsh-model-capability-detector',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'modelCapabilityDetectorSettings'
    const PACKAGE = 'dsh-model-capability-detector'
    const SETTINGS_URL = 'api/model-capability-detector/settings'
    const UPDATES_URL = 'api/model-capability-detector/updates'
    const DETECTOR_URL = 'api/model-capability-detector/detector'
    const FIELD_NAMES = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']
    const REASONS = ['no-original-record', 'not-disclosed-by-original', 'original-records-disagree', 'no-third-party-data', 'single-third-party-source', 'third-party-conflict', 'catalog-disabled', 'field-disabled', 'withheld', 'unknown', 'ambiguous']
    const TIERS = ['api', 'official', 'third-party', 'hint', 'legacy', 'manual']
    const WRITE_HEADERS = { 'content-type': 'application/json', 'x-model-capability-detector': '1' }
    // The Host composes this target; the page still refuses anything else.
    const INSTALL_SPEC = /^git\+https:\/\/github\.com\/BunnySakura\/dsh-model-capability-detector\.git#v?\d+\.\d+\.\d+$/
    const FIELD_GROUPS = [
      { id: 'detection', fields: ['enabled', 'settingsNs', 'discoveryTrigger', 'timeoutMs', 'debounceMs', 'startupDelayMs', 'maxResponseBytes'] },
      { id: 'fallback', fields: ['catalogFallback', 'catalogUrl', 'catalogTimeoutMs', 'catalogMaxBytes', 'catalogTtlMs', 'catalogNumbers', 'catalogNumericStrategy', 'thirdPartySources', 'openrouterUrl', 'litellmUrl', 'upgradeWritten', 'modelAliases', 'overwrite', 'dryRun'] },
      { id: 'diagnostics', fields: ['logging', 'logFile'] },
    ]
    const LABELS = {
      en: {
        title: 'Model Capability Detector', summary: 'Configure channel detection, original-spec fallbacks, logs and updates.', on: 'On', off: 'Off',
        detection: 'Detection', fallback: 'Capability sources', diagnostics: 'Diagnostics', updates: 'Online updates',
        save: 'Save settings', saving: 'Saving…', saved: 'Settings saved and applied.', saveFailed: 'Settings were not saved.', conflict: 'Settings changed elsewhere. The latest values were loaded; review and save again.',
        discard: 'Discard changes', readOnly: 'No DSH home directory is available, so settings are read-only.', loading: 'Loading settings…', loadFailed: 'Could not read settings from the Host.',
        overridden: 'Set here', reset: 'Reset', invalid: 'Enter a valid value within the allowed range.', refused: 'The Host refused a value: ',
        resetHint: 'Reset returns a field to the plugin configuration value, or the built-in default.',
        check: 'Check for updates', checking: 'Checking…', unchecked: 'Not checked yet.', checked: 'Check complete.', 'no-release': 'No stable release is available.', 'rate-limited': 'GitHub rate limit reached; try again later.', unavailable: 'Could not check GitHub. Detection remains unaffected.', cancelled: 'Check cancelled.',
        latest: 'Latest stable version', current: 'Installed version', release: 'Release notes', update: 'Update this plugin', confirm: 'Confirm update', cancel: 'Cancel',
        updateWarning: 'DSH will install this tagged version for this profile. The plugin manager controls compatibility, install scripts and the final result.',
        installing: 'Installing…', installApplied: 'Updated. Reload this page if the version shown here does not change.', installRestart: 'Installed. Restart DSH to finish loading the new version.',
        installFailed: 'The plugin manager did not install the update: ', installBuilds: 'The update needs install-script approval. Approve it from Plugins, then try again.',
        linkedNotice: 'This copy runs from a linked development folder. Updating through the plugin manager would replace that folder and can delete files in it, so the update button is hidden. Update it with git (pull the tag) instead.',
        installUnknown: 'The result is unknown. Open Plugins to check the installed version.', installNoManager: 'The plugin manager is unavailable here. Install the target below from Plugins → Add plugin.', installRefused: 'This update target was refused because it is not the fixed project repository.',
        enabledLabel: 'Enable capability detection', enabledHint: 'Turn the background detection and Models-page enrichment on or off.',
        settingsNsLabel: 'Model settings namespace', settingsNsHint: 'Settings namespace containing provider profiles.',
        discoveryTriggerLabel: 'Enrich model discovery', discoveryTriggerHint: 'Add API and original-spec metadata to the Models-page draft.',
        timeoutMsLabel: 'Channel request timeout (ms)', timeoutMsHint: 'Maximum time for one channel model-list request.',
        debounceMsLabel: 'Save debounce (ms)', debounceMsHint: 'Coalesce rapid provider-settings changes.',
        startupDelayMsLabel: 'Startup delay (ms)', startupDelayMsHint: 'Wait after startup before scanning saved providers. Applies at the next start.',
        maxResponseBytesLabel: 'Maximum channel response bytes', maxResponseBytesHint: 'Cancel model-list responses larger than this limit.',
        catalogFallbackLabel: 'Use public and verified sources', catalogFallbackHint: 'Use original-provider records when the channel API omits fields.',
        catalogUrlLabel: 'Catalog URL', catalogUrlHint: 'Public structured mirror (http or https, no credentials). Pinned official records work offline.',
        catalogTimeoutMsLabel: 'Catalog timeout (ms)', catalogTimeoutMsHint: 'Maximum time for the public catalog request.',
        catalogMaxBytesLabel: 'Maximum catalog bytes', catalogMaxBytesHint: 'Bound memory use while reading the catalog.',
        catalogTtlMsLabel: 'Catalog cache lifetime (ms)', catalogTtlMsHint: 'How long a successful catalog snapshot is reused.',
        catalogNumbersLabel: 'Fill numeric limits', catalogNumbersHint: 'Allow context-window and output-token values from accepted original sources.',
        catalogNumericStrategyLabel: 'Numeric source policy', catalogNumericStrategyHint: 'Official ignores reseller limits; legacy modes aggregate catalog publishers.',
        overwriteLabel: 'Overwrite existing values', overwriteHint: 'Replace configured model fields with newly detected values.',
        dryRunLabel: 'Preview without saving', dryRunHint: 'Calculate changes but do not write provider settings.',
        loggingLabel: 'Enable Host logs', loggingHint: 'Write sanitized diagnostic messages to the DSH logger.',
        logFileLabel: 'Diagnostic log file', logFileHint: 'Optional path inside DSH home (for example logs/detector.log). A non-empty path also enables Host logging.',
        updateCheckOnStartupLabel: 'Check for updates at startup', updateCheckOnStartupHint: 'Check the latest stable version shortly after startup. Off by default.',
        thirdPartySourcesLabel: 'Use third-party sources', thirdPartySourcesHint: 'When original records have no value, use OpenRouter, LiteLLM and models.dev, but only values at least two of them agree on.',
        openrouterUrlLabel: 'OpenRouter model list URL', openrouterUrlHint: 'Public model list (http or https, no credentials). Point it at a mirror if the default is unreachable.',
        litellmUrlLabel: 'LiteLLM model table URL', litellmUrlHint: 'Public model_prices_and_context_window.json (http or https, no credentials). Point it at a mirror if the default is unreachable.',
        upgradeWrittenLabel: 'Upgrade values this plugin wrote', upgradeWrittenHint: 'Replace a value the plugin filled from a weaker source once a stronger one appears. Values you typed are never changed.',
        modelAliasesLabel: 'Model name aliases', modelAliasesHint: 'One per line: channel name = standard model name (for example my-gateway-gpt = gpt-4o). Used when looking up original and third-party records.',
        report: 'Detection report', reportLoad: 'Show report', reportLoading: 'Loading…', reportEmpty: 'No providers with models are configured.', reportFailed: 'Could not build the report.', reportNote: 'Built from your saved providers and the public sources. No channel is contacted and no address or key is shown.',
        rescan: 'Detect again now', rescanning: 'Detecting…', rescanDone: 'Detection finished. Show the report again to see the result.', rescanFailed: 'Detection did not run (the plugin may be disabled).',
        lookup: 'Look up a model name', lookupPlaceholder: 'Model name as the channel lists it', lookupRun: 'Look up', lookupFailed: 'Look-up failed.', matched: 'Matched', unmatched: 'No original record', aliased: 'via alias', votes: 'Third-party sources',
        fieldcontextWindow: 'Context window', fieldmaxTokens: 'Max output', fieldinput: 'Input', fieldreasoningEfforts: 'Reasoning', stateEmpty: 'Empty',
        tierapi: 'Channel API', tierofficial: 'Original provider', tiersibling: 'Same-line snapshots', 'tierthird-party': 'Third-party consensus', tierhint: 'API hint', tierlegacy: 'Legacy catalog', tiermanual: 'Set by you',
        'reasonno-original-record': 'No original-provider record', 'reasonnot-disclosed-by-original': 'Original record does not state it', 'reasonoriginal-records-disagree': 'Original records disagree',
        'reasonno-third-party-data': 'No third-party data', 'reasonsingle-third-party-source': 'Only one third-party source', 'reasonthird-party-conflict': 'Third-party sources disagree',
        'reasoncatalog-disabled': 'Public sources are off', 'reasonfield-disabled': 'This field is not filled from sources', reasonwithheld: 'Withheld: sources disagree', reasonunknown: 'Model not found', reasonambiguous: 'Name matches several models',        strategyOfficial: 'Original-provider specifications (recommended)', strategyMinimum: 'Legacy: minimum across matching publishers', strategyConsensus: 'Legacy: accept numbers only when publishers agree',
      },
      zh: {
        title: '模型能力检测器', summary: '集中配置渠道检测、原厂规格兜底、日志和更新。', on: '开启', off: '关闭',
        detection: '检测设置', fallback: '能力来源', diagnostics: '诊断日志', updates: '在线更新',
        save: '保存设置', saving: '保存中…', saved: '设置已保存并生效。', saveFailed: '设置未保存。', conflict: '设置已在别处被修改，已载入最新值。请检查后重新保存。',
        discard: '放弃更改', readOnly: '找不到 DSH 主目录，设置只读。', loading: '正在读取设置…', loadFailed: '无法从 Host 读取设置。',
        overridden: '已在此设置', reset: '重置', invalid: '请输入范围内的有效值。', refused: 'Host 拒绝了以下取值：',
        resetHint: '重置会让字段回到插件配置值，没有则回到内置默认值。',
        check: '检查更新', checking: '检查中…', unchecked: '尚未检查。', checked: '检查完成。', 'no-release': '暂无稳定版发布。', 'rate-limited': 'GitHub 请求达到限流，请稍后重试。', unavailable: '无法检查 GitHub，不影响能力检测。', cancelled: '检查已取消。',
        latest: '最新稳定版本', current: '当前安装版本', release: '更新说明', update: '更新此插件', confirm: '确认更新', cancel: '取消',
        updateWarning: 'DSH 将为此 profile 安装该固定版本。兼容性、安装脚本和最终结果均由插件管理器控制。',
        installing: '安装中…', installApplied: '已更新。若此处版本号没有变化，请刷新页面。', installRestart: '已安装。请重启 DSH 以完成新版本加载。',
        installFailed: '插件管理器未能安装更新：', installBuilds: '该更新需要批准安装脚本。请在“插件”页批准后重试。',
        linkedNotice: '当前运行的是链接到开发目录的副本。通过插件管理器更新会替换该目录，并可能删除其中的文件，因此已隐藏更新按钮。请用 git 拉取对应标签来更新。',
        installUnknown: '结果未知。请打开“插件”页确认已安装版本。', installNoManager: '此处无法使用插件管理器。请到“插件 → 添加插件”安装下方目标。', installRefused: '更新目标不是固定的项目仓库，已被拒绝。',
        enabledLabel: '启用能力检测', enabledHint: '开启或关闭后台检测与模型页增强。',
        settingsNsLabel: '模型设置命名空间', settingsNsHint: '保存渠道配置的设置命名空间。',
        discoveryTriggerLabel: '增强模型发现', discoveryTriggerHint: '将 API 和原厂规格信息补充到模型页草稿。',
        timeoutMsLabel: '渠道请求超时（毫秒）', timeoutMsHint: '单次渠道模型列表请求的最长时间。',
        debounceMsLabel: '保存防抖（毫秒）', debounceMsHint: '合并短时间内连续的渠道设置更改。',
        startupDelayMsLabel: '启动延迟（毫秒）', startupDelayMsHint: '启动后等待多久再扫描已保存渠道，下次启动生效。',
        maxResponseBytesLabel: '渠道响应字节上限', maxResponseBytesHint: '超过限制时取消模型列表响应。',
        catalogFallbackLabel: '使用公开及已核验来源', catalogFallbackHint: '渠道 API 未披露字段时使用原厂记录。',
        catalogUrlLabel: '目录 URL', catalogUrlHint: '公开结构化镜像（http 或 https，不含凭据）。固定核验的原厂规格可离线使用。',
        catalogTimeoutMsLabel: '目录请求超时（毫秒）', catalogTimeoutMsHint: '公开目录请求的最长时间。',
        catalogMaxBytesLabel: '目录字节上限', catalogMaxBytesHint: '限制读取目录时的内存占用。',
        catalogTtlMsLabel: '目录缓存时长（毫秒）', catalogTtlMsHint: '成功读取的目录快照复用时间。',
        catalogNumbersLabel: '填写数值上限', catalogNumbersHint: '允许从可信原厂来源补充上下文和输出 token 上限。',
        catalogNumericStrategyLabel: '数值来源策略', catalogNumericStrategyHint: '原厂模式不采纳转售商限制；旧模式聚合目录发布者。',
        overwriteLabel: '覆盖已有值', overwriteHint: '使用新检测结果替换已配置的模型字段。',
        dryRunLabel: '仅预览不保存', dryRunHint: '计算改动但不写入渠道配置。',
        loggingLabel: '启用 Host 日志', loggingHint: '向 DSH logger 输出已脱敏诊断信息。',
        logFileLabel: '诊断日志文件', logFileHint: '可选，DSH 主目录内的路径（如 logs/detector.log）。非空时也会启用 Host 日志。',
        updateCheckOnStartupLabel: '启动时检查更新', updateCheckOnStartupHint: '启动后不久检查最新稳定版，默认关闭。',
        thirdPartySourcesLabel: '使用第三方来源', thirdPartySourcesHint: '原厂记录没有值时，参考 OpenRouter、LiteLLM 和 models.dev，且只采用至少两家一致的值。',
        openrouterUrlLabel: 'OpenRouter 模型列表 URL', openrouterUrlHint: '公开模型列表（http 或 https，不含凭据）。默认地址访问不了时，改成镜像地址。',
        litellmUrlLabel: 'LiteLLM 模型表 URL', litellmUrlHint: '公开的 model_prices_and_context_window.json（http 或 https，不含凭据）。默认地址访问不了时，改成镜像地址。',
        upgradeWrittenLabel: '升级插件写入的值', upgradeWrittenHint: '插件曾用较弱来源填写的值，出现更强来源时自动替换。你手填的值永不改动。',
        modelAliasesLabel: '模型名别名', modelAliasesHint: '每行一条：渠道里的名字 = 标准模型名（例如 my-gateway-gpt = gpt-4o）。查询原厂和第三方记录时使用。',
        report: '检测报告', reportLoad: '查看报告', reportLoading: '加载中…', reportEmpty: '没有配置带模型的渠道。', reportFailed: '无法生成报告。', reportNote: '依据已保存的渠道和公开来源生成，不会联系渠道，也不显示地址或密钥。',
        rescan: '立即重新检测', rescanning: '检测中…', rescanDone: '检测完成。再次点击“查看报告”可看到结果。', rescanFailed: '检测没有运行（插件可能已关闭）。',
        lookup: '试查模型名', lookupPlaceholder: '渠道里列出的模型名', lookupRun: '查询', lookupFailed: '查询失败。', matched: '已匹配', unmatched: '没有原厂记录', aliased: '经别名', votes: '第三方来源',
        fieldcontextWindow: '上下文窗口', fieldmaxTokens: '最大输出', fieldinput: '输入', fieldreasoningEfforts: '推理', stateEmpty: '空',
        tierapi: '渠道 API', tierofficial: '原厂', tiersibling: '同系快照推断', 'tierthird-party': '第三方一致', tierhint: 'API 参考值', tierlegacy: '旧版目录', tiermanual: '你手动设置',
        'reasonno-original-record': '没有原厂记录', 'reasonnot-disclosed-by-original': '原厂记录未给出', 'reasonoriginal-records-disagree': '原厂记录不一致',
        'reasonno-third-party-data': '没有第三方数据', 'reasonsingle-third-party-source': '只有一家第三方来源', 'reasonthird-party-conflict': '第三方来源不一致',
        'reasoncatalog-disabled': '公开来源已关闭', 'reasonfield-disabled': '此字段不从来源填写', reasonwithheld: '来源不一致，未填', reasonunknown: '没找到该模型', reasonambiguous: '名称对应多个模型',        strategyOfficial: '原厂规格（推荐）', strategyMinimum: '旧版：匹配发布者中取最小值', strategyConsensus: '旧版：发布者数值一致时才填写',
      },
    }
    for (const dictionary of Object.values(LABELS)) {
      for (const [key, value] of Object.entries(dictionary)) {
        if (typeof value !== 'string') throw new TypeError(`Locale entry ${key} must be a string`)
      }
    }
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)
    const inputStyle = { width: '100%', boxSizing: 'border-box', font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '8px 10px' }
    const primaryButton = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '7px 12px', cursor: 'pointer' }
    const secondaryButton = { ...primaryButton, background: 'transparent' }
    const smallButton = { ...secondaryButton, padding: '3px 7px', fontSize: 12 }

    /** Accept both a plain result and the `{ ok, value, error }` Remote envelope. */
    const unwrap = (raw) => {
      if (raw !== null && typeof raw === 'object' && typeof raw.ok === 'boolean') {
        if (raw.ok) return { value: raw.value }
        return { error: raw.error?.message ?? raw.error?.code ?? 'error' }
      }
      return { value: raw }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, LABELS))
        const t = ctx.locale.bind(NS)
        const url = (path) => new URL(path, document.baseURI).toString()
        let alive = true
        ctx.effect(() => () => { alive = false })
        const request = async (path, input) => {
          const response = await fetch(url(path), {
            method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: input ? WRITE_HEADERS : undefined, body: input ? JSON.stringify(input) : undefined,
          })
          const body = await response.json().catch(() => ({}))
          return { status: response.status, body }
        }
        const pluginManager = () => {
          try { return ctx.get?.('remote.pluginManager') ?? ctx.remote?.pluginManager } catch { return undefined }
        }

        function SettingsPage() {
          const [state, setState] = React.useState({ phase: 'loading' })
          const [draft, setDraft] = React.useState({})
          const [resets, setResets] = React.useState({})
          const [busy, setBusy] = React.useState(false)
          const [message, setMessage] = React.useState('')
          const [updateState, setUpdateState] = React.useState({ status: 'unchecked' })
          const [confirming, setConfirming] = React.useState(false)
          const [checking, setChecking] = React.useState(false)
          const [installing, setInstalling] = React.useState(false)
          const [installMessage, setInstallMessage] = React.useState('')
          const [aliasText, setAliasText] = React.useState(null)
          const [report, setReport] = React.useState(null)
          const [reportBusy, setReportBusy] = React.useState(false)
          const [rescanState, setRescanState] = React.useState('')
          const [lookupName, setLookupName] = React.useState('')
          const [lookupResult, setLookupResult] = React.useState(null)
          const mounted = React.useRef(true)

          const load = async () => {
            try {
              const { status, body } = await request(SETTINGS_URL)
              if (!alive || !mounted.current) return
              setState(status === 200 && body.ok ? { phase: 'ready', ...body } : { phase: 'failed' })
            } catch { if (alive && mounted.current) setState({ phase: 'failed' }) }
          }
          React.useEffect(() => {
            mounted.current = true
            void load()
            request(UPDATES_URL).then(({ body }) => { if (mounted.current) setUpdateState(body) }).catch(() => { if (mounted.current) setUpdateState({ status: 'unavailable' }) })
            return () => { mounted.current = false }
          }, [])

          const ready = state.phase === 'ready'
          const editing = ready && state.writable === true
          const effective = ready ? state.effective : {}
          const shown = { ...effective, ...draft }
          const overrides = ready ? state.overrides : {}
          const touched = [...new Set([...Object.keys(draft), ...Object.keys(resets)])]
          const changed = touched.length > 0

          const edit = (key, value) => {
            setDraft((previous) => ({ ...previous, [key]: value }))
            setResets((previous) => { const next = { ...previous }; delete next[key]; return next })
            setMessage('')
          }
          const reset = (key) => {
            setDraft((previous) => { const next = { ...previous }; delete next[key]; return next })
            setResets((previous) => ({ ...previous, [key]: true }))
            if (key === 'modelAliases') setAliasText(null)
            setMessage('')
          }
          const discard = () => { setDraft({}); setResets({}); setAliasText(null); setMessage('') }
          const valid = (key, value) => {
            const meta = state.fields?.[key]
            if (meta?.type === 'integer') return Number.isSafeInteger(value) && value >= meta.min && value <= meta.max
            if (meta?.type === 'string') return typeof value === 'string' && value.trim().length > 0
            return true
          }
          const save = async () => {
            if (!changed || !editing || busy) return
            for (const key of Object.keys(draft)) if (!valid(key, draft[key])) { setMessage('invalid'); return }
            setBusy(true)
            let outcome
            try { outcome = await request(SETTINGS_URL, { revision: state.revision, set: draft, unset: Object.keys(resets) }) } catch { outcome = { status: 0, body: {} } }
            if (!alive || !mounted.current) return
            setBusy(false)
            if (outcome.status === 200 && outcome.body.ok) {
              setState({ phase: 'ready', ...outcome.body }); setDraft({}); setResets({}); setAliasText(null); setMessage('saved'); return
            }
            if (outcome.status === 409 && outcome.body.revision) {
              setState({ phase: 'ready', ...outcome.body }); setDraft({}); setResets({}); setAliasText(null); setMessage('conflict'); return
            }
            setMessage(outcome.status === 400 ? 'refused' : 'saveFailed')
            if (outcome.body.errors) setMessage(`refused:${outcome.body.errors.join(', ')}`)
          }
          const check = async () => {
            setChecking(true)
            try {
              const { body } = await request(UPDATES_URL, { action: 'check', refresh: true })
              if (alive && mounted.current) { setUpdateState(body); setConfirming(false); setInstallMessage('') }
            } catch { if (alive && mounted.current) setUpdateState({ ...updateState, status: 'unavailable' }) }
            finally { if (alive && mounted.current) setChecking(false) }
          }
          const finishInstall = (key, detail) => { if (alive && mounted.current) { setInstalling(false); setInstallMessage(detail ? `${key}:${detail}` : key) } }
          const installUpdate = async () => {
            setConfirming(false)
            if (updateState.linked === true) { setInstallMessage('linkedNotice'); return }
            const spec = updateState.installTarget
            if (typeof spec !== 'string' || !INSTALL_SPEC.test(spec)) { setInstallMessage('installRefused'); return }
            const manager = pluginManager()
            if (typeof manager?.installBundle !== 'function') { setInstallMessage('installNoManager'); return }
            setInstalling(true); setInstallMessage('')
            const requestId = `model-capability-detector-${Date.now().toString(36)}`
            let result
            try { result = unwrap(await manager.installBundle(spec, { enabled: true, requestId })) } catch { finishInstall('installUnknown'); return }
            if (result.error !== undefined) { finishInstall('installFailed', result.error); return }
            const outcome = result.value ?? {}
            if (Array.isArray(outcome.pendingBuilds) && outcome.pendingBuilds.length > 0) { finishInstall('installBuilds'); return }
            if (outcome.application === 'applied') finishInstall('installApplied')
            else if (outcome.application === 'restart-required') finishInstall('installRestart')
            else if (outcome.error?.code === 'already-installed') finishInstall('installApplied')
            else finishInstall('installFailed', outcome.error?.diagnostic ?? outcome.error?.code ?? outcome.application ?? 'unknown')
          }
          const loadReport = async () => {
            setReportBusy(true)
            try {
              const { body } = await request(DETECTOR_URL)
              if (alive && mounted.current) setReport(body.ok ? body : { failed: true })
            } catch { if (alive && mounted.current) setReport({ failed: true }) }
            finally { if (alive && mounted.current) setReportBusy(false) }
          }
          const rescan = async () => {
            setRescanState('rescanning')
            try {
              const { body } = await request(DETECTOR_URL, { action: 'rescan' })
              if (alive && mounted.current) setRescanState(body.ok ? 'rescanDone' : 'rescanFailed')
            } catch { if (alive && mounted.current) setRescanState('rescanFailed') }
          }
          const runLookup = async () => {
            if (!lookupName.trim()) return
            try {
              const { body } = await request(DETECTOR_URL, { action: 'lookup', model: lookupName })
              if (alive && mounted.current) setLookupResult(body.ok ? body : { failed: true })
            } catch { if (alive && mounted.current) setLookupResult({ failed: true }) }
          }
          const aliasLines = (aliases) => Object.entries(aliases ?? {}).map(([from, to]) => `${from} = ${to}`).join('\n')
          const parseAliases = (text) => {
            const result = {}
            for (const line of text.split(/\r?\n/)) {
              const at = line.indexOf('=')
              if (at < 0) continue
              const from = line.slice(0, at).trim(); const to = line.slice(at + 1).trim()
              if (from && to) result[from] = to
            }
            return result
          }
          const word = (key, fallback) => { const text = t(key); return text === key ? fallback ?? key : text }
          const cell = (info) => {
            if (info.state === 'empty') return `${t('stateEmpty')} · ${word(`reason${info.reason}`, info.reason ?? '')}`
            const value = Array.isArray(info.value) ? info.value.join('+') : typeof info.value === 'object' && info.value !== null ? Object.keys(info.value).join('/') : info.value === false ? t('off') : String(info.value)
            const tier = info.tier ? word(`tier${info.tier}`, info.tier) : ''
            return `${value}${tier ? ` · ${tier}` : ''}${info.match === 'family' || info.match === 'sibling' ? ' ≈' : ''}`
          }
          const describe = (code) => {
            const [key, detail] = [code.split(':')[0], code.includes(':') ? code.slice(code.indexOf(':') + 1) : '']
            return detail ? `${t(key === 'refused' ? 'refused' : key)}${detail}` : t(key)
          }

          const fieldFrame = (key, control) => {
            const marked = own(overrides, key) || own(resets, key)
            return h('div', { key, style: { display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(220px, 1.4fr) auto', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              h('div', {}, h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 } }, t(`${key}Label`)), h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 3 } }, t(`${key}Hint`))),
              control,
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                own(overrides, key) && !own(resets, key) ? t('overridden') : '',
                marked ? h('button', { type: 'button', disabled: !editing || busy || own(resets, key), onClick: () => reset(key), style: smallButton }, t('reset')) : null))
          }
          const textControl = (key, type, meta) => fieldFrame(key, h('input', {
            type, 'data-config-key': key, value: shown[key] ?? '', min: meta?.min, max: meta?.max, step: type === 'number' ? '1' : undefined,
            disabled: !editing || busy, style: inputStyle, 'aria-label': t(`${key}Label`),
            onChange: (event) => edit(key, type === 'number' ? (event.currentTarget.value === '' ? '' : event.currentTarget.valueAsNumber) : event.currentTarget.value),
          }))
          const toggleControl = (key) => fieldFrame(key, h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, justifySelf: 'start' } },
            h('input', { type: 'checkbox', 'data-config-key': key, 'aria-label': t(`${key}Label`), checked: shown[key] === true, disabled: !editing || busy, onChange: (event) => edit(key, event.currentTarget.checked), style: { width: 18, height: 18, accentColor: 'var(--dsw-alias-brand-primary)' } }),
            t(shown[key] === true ? 'on' : 'off')))
          const selectControl = (key, meta) => fieldFrame(key, h('select', { 'data-config-key': key, 'aria-label': t(`${key}Label`), value: shown[key] ?? '', disabled: !editing || busy, onChange: (event) => edit(key, event.currentTarget.value), style: inputStyle },
            ...meta.values.map((id) => h('option', { value: id, key: id }, t(`strategy${id[0].toUpperCase()}${id.slice(1)}`)))))
          const control = (key) => {
            const meta = state.fields?.[key]
            if (meta?.type === 'boolean') return toggleControl(key)
            if (meta?.type === 'enum') return selectControl(key, meta)
            if (meta?.type === 'aliases') return fieldFrame(key, h('textarea', { 'data-config-key': key, rows: 4, value: aliasText ?? aliasLines(shown[key]), disabled: !editing || busy, style: { ...inputStyle, fontFamily: 'monospace' }, 'aria-label': t(`${key}Label`), onChange: (event) => { setAliasText(event.currentTarget.value); edit(key, parseAliases(event.currentTarget.value)) } }))
            if (meta?.type === 'integer') return textControl(key, 'number', meta)
            return textControl(key, meta?.type === 'url' ? 'url' : 'text', meta)
          }

          return h('section', { 'aria-label': t('title'), style: { maxWidth: 820, color: 'var(--dsw-alias-label-primary)', fontSize: 14 } },
            state.phase === 'loading' ? h('p', { role: 'status' }, t('loading')) : null,
            state.phase === 'failed' ? h('p', { role: 'alert' }, t('loadFailed')) : null,
            ready && !state.writable ? h('p', { role: 'status' }, t('readOnly')) : null,
            ready ? h('p', { style: { margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('resetHint')) : null,
            ...(ready ? FIELD_GROUPS.map((group) => h('section', { key: group.id, style: { marginTop: 20 } },
              h('h4', { style: { margin: '0 0 4px', paddingBottom: 8, borderBottom: '1px solid var(--dsw-alias-border-l2)', fontSize: 14 } }, t(group.id)),
              ...group.fields.map(control))) : []),
            h('section', { style: { marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
              h('h4', { style: { margin: '0 0 8px', fontSize: 14 } }, t('report')),
              h('p', { style: { margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('reportNote')),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
                h('button', { type: 'button', disabled: reportBusy, onClick: loadReport, style: secondaryButton }, t(reportBusy ? 'reportLoading' : 'reportLoad')),
                h('button', { type: 'button', disabled: rescanState === 'rescanning', onClick: rescan, style: secondaryButton }, t(rescanState === 'rescanning' ? 'rescanning' : 'rescan'))),
              rescanState && rescanState !== 'rescanning' ? h('p', { role: 'status' }, t(rescanState)) : null,
              report?.failed ? h('p', { role: 'alert' }, t('reportFailed')) : null,
              report && !report.failed && report.routes.every((route) => route.models.length === 0) ? h('p', {}, t('reportEmpty')) : null,
              ...(report && !report.failed ? report.routes.map((route) => h('div', { key: route.route, style: { marginTop: 8 } },
                h('div', { style: { fontWeight: 500 } }, route.route),
                ...route.models.map((model) => h('div', { key: model.id, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                  h('div', {}, model.id, model.matched === true || typeof model.matched === 'string' ? ` · ${t('matched')}` : model.matched === false ? ` · ${t('unmatched')}` : ''),
                  ...FIELD_NAMES.map((field) => h('div', { key: field, style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, `${t(`field${field}`)}: ${cell(model.fields[field])}`)))))) : []),
              h('div', { style: { marginTop: 12 } },
                h('div', { style: { fontWeight: 500, marginBottom: 6 } }, t('lookup')),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('input', { type: 'text', value: lookupName, placeholder: t('lookupPlaceholder'), 'aria-label': t('lookup'), style: inputStyle, onChange: (event) => setLookupName(event.currentTarget.value) }),
                  h('button', { type: 'button', onClick: runLookup, style: secondaryButton }, t('lookupRun'))),
                lookupResult?.failed ? h('p', { role: 'alert' }, t('lookupFailed')) : null,
                lookupResult && !lookupResult.failed ? h('div', { style: { marginTop: 8 } },
                  h('div', {}, `${lookupResult.model} · ${lookupResult.status === 'resolved' ? t('matched') : word(`reason${lookupResult.status}`, lookupResult.status)}${lookupResult.aliased ? ` · ${t('aliased')}` : ''}`),
                  ...FIELD_NAMES.map((field) => h('div', { key: field, style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, `${t(`field${field}`)}: ${cell(lookupResult.fields[field])}`)),
                  Object.keys(lookupResult.votes ?? {}).length > 0 ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, `${t('votes')}: ${Object.entries(lookupResult.votes).map(([name, vote]) => `${name} ${vote.context ?? '-'}/${vote.output ?? '-'}`).join(' · ')}`) : null) : null)),
            h('section', { style: { marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
              h('h4', { style: { margin: '0 0 8px', fontSize: 14 } }, t('updates')),
              ready ? control('updateCheckOnStartup') : null,
              h('p', { role: 'status', 'aria-live': 'polite', style: { color: 'var(--dsw-alias-label-secondary)' } }, t(updateState.status ?? 'unchecked')),
              updateState.currentVersion ? h('p', {}, `${t('current')}: ${updateState.currentVersion}`) : null,
              updateState.version ? h('p', {}, `${t('latest')}: ${updateState.version}`) : null,
              updateState.releaseUrl ? h('p', {}, h('a', { href: updateState.releaseUrl, target: '_blank', rel: 'noreferrer noopener', style: { color: 'var(--dsw-alias-brand-primary)' } }, t('release'))) : null,
              updateState.notes ? h('details', {}, h('summary', {}, t('release')), h('pre', { style: { whiteSpace: 'pre-wrap', font: 'inherit', maxHeight: 240, overflow: 'auto' } }, updateState.notes)) : null,
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { type: 'button', disabled: checking || installing, onClick: check, style: secondaryButton }, t(checking ? 'checking' : 'check')),
                updateState.available && !confirming && updateState.linked !== true ? h('button', { type: 'button', disabled: installing, onClick: () => setConfirming(true), style: primaryButton }, t(installing ? 'installing' : 'update')) : null),
              updateState.linked === true ? h('p', { role: 'status' }, t('linkedNotice')) : null,
              confirming && updateState.linked !== true ? h('div', { role: 'group', 'aria-label': t('confirm'), style: { marginTop: 12, padding: 12, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8 } },
                h('p', {}, t('updateWarning')),
                h('code', { style: { display: 'block', overflowWrap: 'anywhere' } }, updateState.installTarget),
                h('button', { type: 'button', onClick: installUpdate, style: primaryButton }, t('confirm')),
                h('button', { type: 'button', onClick: () => setConfirming(false), style: { ...secondaryButton, marginLeft: 8 } }, t('cancel'))) : null,
              installMessage ? h('p', { role: 'status', 'aria-live': 'polite' }, describe(installMessage)) : null,
              installMessage === 'installNoManager' && updateState.installTarget ? h('code', { style: { display: 'block', overflowWrap: 'anywhere' } }, updateState.installTarget) : null),
            message ? h('p', { role: message === 'saved' ? 'status' : 'alert' }, describe(message)) : null,
            ready ? h('div', { style: { display: 'flex', gap: 8, marginTop: 18 } },
              h('button', { type: 'button', disabled: !editing || busy || !changed, onClick: save, style: primaryButton }, t(busy ? 'saving' : 'save')),
              changed ? h('button', { type: 'button', disabled: busy, onClick: discard, style: secondaryButton }, t('discard')) : null) : null)
        }

        // The detector's own configuration lives on its bundle page, like every
        // plugin's. Nothing is added to the global Plugins tabs.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: PACKAGE, locale: NS,
        }, (props) => (props?.view === 'summary' ? h('span', {}, t('summary')) : h(SettingsPage, {}))))
      },
    }
  },
})
