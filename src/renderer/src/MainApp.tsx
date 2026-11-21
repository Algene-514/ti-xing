import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FilterKey, QuestionInput, QuestionView, Settings, StatusSnapshot } from '../../shared/types'
import { fmtDueLabel } from '../../shared/derive'

type Mode = 'view' | 'edit' | 'new'

const EMPTY_FORM: QuestionInput = { content: '', answer: '', analysis: '' }

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'overdue', label: '已逾期' }
]

function msgOf(err: string): string {
  return err === 'DUPLICATE' ? '已有完全相同的题目' : err
}

export default function MainApp(): JSX.Element {
  const [rows, setRows] = useState<QuestionView[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('view')
  const [form, setForm] = useState<QuestionInput>(EMPTY_FORM)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [snap, setSnap] = useState<StatusSnapshot | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dndOpen, setDndOpen] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId])

  const refresh = useCallback(async () => {
    const [listRes, statusRes, settingsRes] = await Promise.all([
      window.tixing.list(filter, query),
      window.tixing.status(),
      window.tixing.getSettings()
    ])
    if (listRes.ok) setRows(listRes.data)
    if (statusRes.ok) setSnap(statusRes.data)
    if (settingsRes.ok) setSettings(settingsRes.data)
  }, [filter, query])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const t = setInterval(() => {
      void refresh()
    }, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (dirRef.current) {
      dirRef.current.setAttribute('webkitdirectory', '')
      dirRef.current.setAttribute('directory', '')
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  async function patch(p: Partial<Settings>): Promise<void> {
    const r = await window.tixing.setSettings(p)
    if (r.ok) setSettings(r.data)
    else setToast(r.error)
  }

  function startNew(): void {
    setMode('new')
    setSelectedId(null)
    setForm(EMPTY_FORM)
  }

  function startEdit(): void {
    if (!selected) return
    setMode('edit')
    setForm({ content: selected.content, answer: selected.answer, analysis: selected.analysis ?? '' })
  }

  async function save(): Promise<void> {
    if (!form.content.trim()) {
      setToast('题目不能为空')
      return
    }
    if (mode === 'edit' && selectedId != null) {
      const r = await window.tixing.update(selectedId, form)
      if (!r.ok) {
        setToast(msgOf(r.error))
        return
      }
      setMode('view')
      await refresh()
      setToast('已保存')
      return
    }
    const r = await window.tixing.create(form)
    if (!r.ok) {
      setToast(msgOf(r.error))
      return
    }
    setSelectedId(r.data)
    setMode('view')
    await refresh()
    setToast('已新建')
  }

  async function removeSelected(): Promise<void> {
    if (!selected) return
    const ok = window.confirm(`删除「${selected.content.slice(0, 20)}」？\n该题的所有复习记录会一并删除。`)
    if (!ok) return
    const r = await window.tixing.remove(selected.id)
    if (!r.ok) {
      setToast(r.error)
      return
    }
    setSelectedId(null)
    setMode('view')
    await refresh()
    setToast('已删除')
  }

  async function startNow(): Promise<void> {
    const r = await window.tixing.startQuizNow()
    if (!r.ok) {
      setToast('操作失败')
      return
    }
    if (!r.data.ok) {
      setToast(r.data.reason === 'capped' ? '今日已达上限，明日继续' : '暂无到期题目')
      return
    }
    setToast(`弹窗已打开（${r.data.count} 题）`)
  }

  async function handleFiles(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return
    const files = Array.from(list).filter((f) => /\.(md|markdown|txt)$/i.test(f.name))
    if (files.length === 0) {
      setToast('没有找到 .md 文件')
      return
    }
    setBusy(true)
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
      const r = await window.tixing.importFiles(payload)
      if (!r.ok) {
        setToast(`导入失败：${msgOf(r.error)}`)
        return
      }
      setToast(`导入完成：新增 ${r.data.inserted} 道 · 重复跳过 ${r.data.skipped} 道 · 失败 ${r.data.failed} 个`)
      await refresh()
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
      if (dirRef.current) dirRef.current.value = ''
    }
  }

  const emptyHint =
    snap?.total === 0 ? '题库还是空的，点「+ 新建题目」录一道' : query ? '没有匹配的题目' : '这个筛选下没有题目'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">题醒</div>

        <label className="ctl">
          <input
            type="checkbox"
            checked={settings?.enabled ?? true}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          锁屏复习
        </label>

        <label className="ctl">
          间隔
          <select
            value={String(settings?.intervalMin ?? 90)}
            onChange={(e) => void patch({ intervalMin: Number(e.target.value) })}
          >
            <option value="60">60</option>
            <option value="90">90</option>
            <option value="120">120</option>
          </select>
          分钟
        </label>

        <label className="ctl">
          每次
          <select
            value={String(settings?.batchSize ?? 5)}
            onChange={(e) => void patch({ batchSize: Number(e.target.value) })}
          >
            <option value="3">3</option>
            <option value="5">5</option>
            <option value="10">10</option>
          </select>
          题
        </label>

        <label className="ctl" title="仅对之后的复习生效，不回溯重算已排好的到期日">
          保持率
          <select
            value={String(settings?.retention ?? 0.85)}
            onChange={(e) => void patch({ retention: Number(e.target.value) })}
          >
            <option value="0.9">90%</option>
            <option value="0.85">85%</option>
            <option value="0.8">80%</option>
          </select>
        </label>

        <div className="grow" />

        <div className="dnd-wrap">
          <button
            className={'ghost dnd-btn' + (settings?.dndEnabled ? ' on' : '')}
            title="免打扰时段"
            onClick={() => setDndOpen((v) => !v)}
          >
            ⏰
          </button>
          {dndOpen && settings && (
            <div className="dnd-pop">
              <label className="dnd-row">
                <input
                  type="checkbox"
                  checked={settings.dndEnabled}
                  onChange={(e) => void patch({ dndEnabled: e.target.checked })}
                />
                免打扰时段
              </label>
              <div className="dnd-times">
                <input
                  type="time"
                  value={settings.dndStart}
                  disabled={!settings.dndEnabled}
                  onChange={(e) => void patch({ dndStart: e.target.value })}
                />
                <span>–</span>
                <input
                  type="time"
                  value={settings.dndEnd}
                  disabled={!settings.dndEnabled}
                  onChange={(e) => void patch({ dndEnd: e.target.value })}
                />
              </div>
              <div className="dnd-hint">区间内不自动弹窗；手动「立即复习」不受影响</div>
            </div>
          )}
        </div>

        <div className="stat">
          {snap
            ? snap.dnd
              ? `免打扰中 · ${snap.dndResumeText} 恢复 · 待复习 ${snap.pending}`
              : `下次弹窗 ${snap.nextFireInMin} 分 · 待复习 ${snap.pending}`
            : ''}
        </div>
        <button className="primary" onClick={() => void startNow()}>
          立即复习
        </button>
      </header>

      <div className="layout">
        <aside className="list-pane">
          <input
            className="search"
            placeholder="搜索题目 / 答案"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="chips">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={'chip' + (filter === f.key ? ' active' : '')}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="rows">
            {rows.length === 0 && <div className="empty small-pad">{emptyHint}</div>}
            {rows.map((r) => (
              <button
                key={r.id}
                className={'row' + (r.id === selectedId ? ' active' : '')}
                onClick={() => {
                  setSelectedId(r.id)
                  setMode('view')
                }}
              >
                <div className="row-main">
                  <span className={'due ' + dueClass(r)}>{fmtDueLabel(r)}</span>
                  <span className="row-title">{r.content.slice(0, 30)}</span>
                </div>
                <div className="row-sub">
                  复习 {r.n} 次
                  {r.r != null && ` · S=${r.s.toFixed(1)} 天 · R=${r.r.toFixed(2)}`}
                </div>
              </button>
            ))}
          </div>

          <div className="list-actions">
            <button className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
              导入 .md 文件
            </button>
            <button className="ghost" onClick={() => dirRef.current?.click()} disabled={busy}>
              导入文件夹
            </button>
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt" multiple hidden onChange={(e) => void handleFiles(e.target.files)} />
            <input ref={dirRef} type="file" hidden onChange={(e) => void handleFiles(e.target.files)} />
          </div>
        </aside>

        <section className="detail">
          {mode === 'view' && selected && (
            <>
              <div className="detail-head">
                <span className={'due ' + dueClass(selected)}>{fmtDueLabel(selected)}</span>
                <div className="grow" />
                <button className="ghost" onClick={startEdit}>
                  编辑
                </button>
                <button className="ghost danger" onClick={() => void removeSelected()}>
                  删除
                </button>
              </div>
              <h3>题目</h3>
              <pre className="block">{selected.content}</pre>
              <h3>答案</h3>
              <pre className="block">{selected.answer || '（空）'}</pre>
              <h3>解析</h3>
              <pre className="block">{selected.analysis || '（无）'}</pre>
            </>
          )}

          {mode === 'view' && !selected && (
            <div className="empty">
              {snap?.total ? '选中左侧题目查看，或' : '题库还是空的，'}
              <button className="primary" onClick={startNew}>
                + 新建题目
              </button>
            </div>
          )}

          {(mode === 'edit' || mode === 'new') && (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <h3>题目</h3>
              <textarea
                autoFocus
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="题干，支持多行"
              />
              <h3>答案</h3>
              <textarea
                value={form.answer}
                onChange={(e) => setForm({ ...form, answer: e.target.value })}
                placeholder="可为空"
              />
              <h3>解析</h3>
              <textarea
                value={form.analysis}
                onChange={(e) => setForm({ ...form, analysis: e.target.value })}
                placeholder="可为空"
              />
              <div className="actions">
                <button className="primary" type="submit">
                  保存
                </button>
                <button className="ghost" type="button" onClick={() => setMode('view')}>
                  取消
                </button>
              </div>
            </form>
          )}
        </section>
      </div>

      <footer className="statusbar">
        <span>题库 {snap?.total ?? 0} 题</span>
        <span>待复习 {snap?.pending ?? 0} 题</span>
        <div className="grow" />
        <span>{snap?.dnd ? `免打扰中 · ${snap.dndResumeText} 恢复` : settings?.enabled ? '' : '定时弹窗已暂停'}</span>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function dueClass(v: QuestionView): string {
  if (v.status === '已逾期') return 'c-bad'
  if (v.status === '今日到期') return 'c-warn'
  if (v.status === '新题') return 'c-new'
  return 'c-muted'
}
