window.__ModuleLoader__.load({
  id: 'dsh-model-capability-detector',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'modelCapabilityDetectorUpdates'
    const dictionaries = {
      en: {
        title: 'Plugin updates', check: 'Check for updates', checking: 'Checking…', current: 'Current version', latest: 'Latest stable version',
        unchecked: 'No update check yet.', checked: 'Update check complete.', 'no-release': 'No published stable release was found.',
        'rate-limited': 'GitHub request limit reached. Try again later.', unavailable: 'Could not check GitHub. Your installed version is unchanged.',
        cancelled: 'Update check cancelled.', update: 'Review update', confirm: 'Confirm update', cancel: 'Cancel', working: 'Updating…',
        confirmText: 'DSH will attempt to install the release below. All sessions in this profile may be affected. No install scripts are authorized by this action.',
        result: 'Management result', applied: 'The new version was applied.', 'restart-required': 'Restart DSH to load the new version.',
        failed: 'The update did not complete. Check DSH Plugin Manager before retrying.', overridden: 'A higher configuration layer overrides this change.',
        notes: 'Release notes', release: 'Open GitHub release', rollback: 'Previous version', target: 'Installation target',
        compatibility: 'DSH checks version compatibility during installation. A refusal keeps the existing version when package recovery succeeds.',
        refused: 'If DSH refuses replacement as already installed, use its uninstall/reinstall flow after preserving your configuration overrides.',
        scripts: 'Installation scripts need separate approval in DSH Plugin Manager.', background: 'Automatic startup checks are off unless enabled in plugin configuration.',
        recovery: 'After reconnecting, inspect the version shown by DSH Plugin Manager to confirm the outcome.',
      },
      zh: {
        title: '插件更新', check: '检查更新', checking: '检查中…', current: '当前版本', latest: '最新稳定版本',
        unchecked: '尚未检查更新。', checked: '更新检查完成。', 'no-release': '尚未找到已发布的稳定版本。',
        'rate-limited': '已达到 GitHub 请求限制，请稍后重试。', unavailable: '暂时无法检查 GitHub，当前安装版本保持不变。',
        cancelled: '更新检查已取消。', update: '查看并更新', confirm: '确认更新', cancel: '取消', working: '正在更新…',
        confirmText: 'DSH 将尝试安装下方版本，可能影响当前 profile 的所有会话。本操作不会授权执行安装脚本。',
        result: '管理结果', applied: '新版本已生效。', 'restart-required': '请重启 DSH 加载新版本。',
        failed: '更新未完成，请先在 DSH 插件管理器核对状态再重试。', overridden: '更高优先级的配置覆盖了本次变更。',
        notes: '更新说明', release: '打开 GitHub 发布页', rollback: '更新前版本', target: '安装目标',
        compatibility: 'DSH 会在安装过程中检查版本兼容性；拒绝后如果包恢复成功，原版本继续保留。',
        refused: '如果 DSH 以“已安装”拒绝替换，请保留配置覆盖项后使用它的卸载、重新安装流程。',
        scripts: '安装脚本必须在 DSH 插件管理器中另行授权。', background: '启动自动检查默认关闭，可在插件配置中开启。',
        recovery: '重新连接后，请以 DSH 插件管理器显示的版本核对更新结果。',
      },
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        const t = ctx.locale.bind(NS)
        const endpoint = new URL('api/model-capability-detector/updates', document.baseURI).toString()
        let alive = true
        ctx.effect(() => () => { alive = false })
        const request = async (input) => {
          const response = await fetch(endpoint, { method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: input ? { 'content-type': 'application/json' } : undefined, body: input ? JSON.stringify(input) : undefined })
          if (!response.ok) throw new Error('request failed')
          return response.json()
        }
        function UpdateTab({ install }) {
          const [state, setState] = React.useState({ status: 'unchecked' })
          const [busy, setBusy] = React.useState(false)
          const [confirming, setConfirming] = React.useState(false)
          const mounted = React.useRef(true)
          React.useEffect(() => {
            mounted.current = true
            request().then((value) => { if (mounted.current) setState(value) }).catch(() => { if (mounted.current) setState({ status: 'unavailable' }) })
            return () => { mounted.current = false }
          }, [])
          const perform = async () => {
            setBusy(true)
            try {
              const value = await request({ action: 'check', refresh: true })
              if (alive && mounted.current) { setState(value); setConfirming(false) }
            } catch {
              if (alive && mounted.current) setState({ ...state, status: 'unavailable' })
            } finally { if (alive && mounted.current) setBusy(false) }
          }
          const buttonStyle = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '7px 12px', cursor: busy ? 'wait' : 'pointer' }
          const p = (text) => h('p', { style: { margin: '8px 0', overflowWrap: 'anywhere' } }, text)
          return h('section', { 'aria-label': t('title'), style: { maxWidth: 760, color: 'var(--dsw-alias-label-primary)', fontSize: 14 } },
            h('h2', { style: { fontSize: 18, margin: '0 0 12px' } }, t('title')),
            p(`${t('current')}: ${state.currentVersion ?? '—'}`),
            h('p', { role: 'status', 'aria-live': 'polite' }, t(state.status)),
            state.version ? p(`${t('latest')}: ${state.version}`) : null,
            h('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: perform }, t(busy ? 'checking' : 'check')),
            state.status === 'checked' && state.available && !confirming ? h('button', { type: 'button', style: { ...buttonStyle, marginLeft: 8 }, disabled: busy, onClick: () => setConfirming(true) }, t('update')) : null,
            state.releaseUrl ? p(h('a', { href: state.releaseUrl, target: '_blank', rel: 'noreferrer noopener', style: { color: 'var(--dsw-alias-brand-primary)' } }, t('release'))) : null,
            state.notes ? h('details', {}, h('summary', {}, t('notes')), h('pre', { style: { whiteSpace: 'pre-wrap', font: 'inherit', maxHeight: 240, overflow: 'auto' } }, state.notes)) : null,
            confirming ? h('div', { role: 'group', 'aria-label': t('confirm'), style: { background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 8, padding: 16, marginTop: 12 } },
              p(t('confirmText')), p(`${state.currentVersion} → ${state.version}`), p(t('target') + ': ' + state.installTarget), p(t('compatibility')), p(t('refused')), p(`${t('rollback')}: ${state.currentVersion}`),
              h('button', { type: 'button', style: buttonStyle, onClick: () => { setConfirming(false); install({ spec: state.installTarget, title: 'Model Capability Detector', version: state.version }) } }, t('confirm')),
              h('button', { type: 'button', style: { ...buttonStyle, marginLeft: 8 }, onClick: () => setConfirming(false) }, t('cancel'))) : null,
            p(t('background')))
        }
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({ name: 'plugins.tab', id: 'model-capability-detector.updates', locale: NS, label: () => t('title'), order: 5 }, UpdateTab))
      },
    }
  },
})
