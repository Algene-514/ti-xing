import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  FilterKey,
  QuestionInput,
  QuestionView,
  Settings,
  StatusSnapshot,
  TagInfo
} from '../../shared/types'
import { TAG_MAX_LEN } from '../../shared/types'
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

/** v1.2 标签输入：中文/英文逗号分隔，trim 后去空 */
function parseTagText(text: string): string[] {
  return text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 超过 TAG_MAX_LEN 个字符的标签截断（UI 层负责提示） */
function clipTag(tag: string): string {
  const chars = Array.from(tag)
  return chars.length > TAG_MAX_LEN ? chars.slice(0, TAG_MAX_LEN).join('') : tag
}

export default function MainApp(): JSX.Element {
  const [rows, setRows] = useState<QuestionView[]>([])
  /** 搜索框里的原始输入（未防抖） */
  const [queryInput, setQueryInput] = useState('')
  /** 防抖 200ms 后真正用于查询的串 */
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  /** v1.2 单选标签筛选；null = 不筛 */
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [tags, setTags] = useState<TagInfo[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>('view')
  const [form, setForm] = useState<QuestionInput>(EMPTY_FORM)
  /** 编辑表单里的标签文本（逗号分隔） */
  const [tagText, setTagText] = useState('')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [snap, setSnap] = useState<StatusSnapshot | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dndOpen, setDndOpen] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId])

  // v1.2 §3.2：200ms 防抖，避免每次按键都查库
  useEffect(() => {
    const t = setTimeout(() => setQuery(queryInput.trim()), 200)
    return () => clearTimeout(t)
  }, [queryInput])

  const refresh = useCallback(async () => {
    const [listRes, statusRes, settingsRes, tagsRes] = await Promise.all([
      window.tixing.list(filter, query, tagFilter),
      window.tixing.status(),
      window.tixing.getSettings(),
      window.tixing.tags()
    ])
    if (listRes.ok) setRows(listRes.data)
    if (statusRes.ok) setSnap(statusRes.data)
    if (settingsRes.ok) setSettings(settingsRes.data)
    if (tagsRes.ok) setTags(tagsRes.data)
  }, [filter, query, tagFilter])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const t = setInterval(() => {
      void refresh()
    }, 15_000)
    return () => clearInterval(t)
  }, [refresh])

  // 正在筛的标签被删光（只剩 0 道题）时自动退出筛选，否则会永远筛不到
  useEffect(() => {
    if (tagFilter && tags.length > 0 && !tags.some((t) => t.name === tagFilter)) {
      setTagFilter(null)
    }
  }, [tagFilter, tags])

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

  // v1.2 §3.3 快捷键：只在主窗口生效（复习弹窗是独立窗口，天然收不到），不注册全局快捷键
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.isComposing) return // 中文输入法组合中不处理
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.code === 'KeyF') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (mod && e.code === 'KeyN') {
        e.preventDefault()
        if (mode === 'view') startNew() // 编辑态不覆盖正在编辑的内容
        return
      }
      // Esc 只在焦点位于搜索框时清空搜索；在题目/答案/解析框内不响应
      if (e.code === 'Escape' && e.target === searchRef.current) {
        e.preventDefault()
        setQueryInput('')
        setQuery('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode])

  async function patch(p: Partial<Settings>): Promise<void> {
    const r = await window.tixing.setSettings(p)
    if (r.ok) setSettings(r.data)
    else setToast(r.error)
  }

  function startNew(): void {
    setMode('new')
    setSelectedId(null)
    setForm(EMPTY_FORM)
    setTagText('')
  }

  function startEdit(): void {
    if (!selected) return
    setMode('edit')
    setForm({ content: selected.content, answer: selected.answer, analysis: selected.analysis ?? '' })
    setTagText(selected.tags.join(', '))
  }

  function cancelForm(): void {
    setMode('view')
  }

  async function save(): Promise<void> {
    if (!form.content.trim()) {
      setToast('题目不能为空')
      return
    }
    const rawTags = parseTagText(tagText)
    const truncated = rawTags.some((t) => Array.from(t).length > TAG_MAX_LEN)
    const tagsToSave = rawTags.map(clipTag)
    const payload: QuestionInput = { ...form, tags: tagsToSave }

    if (mode === 'edit' && selectedId != null) {
      const r = await window.tixing.update(selectedId, payload)
      if (!r.ok) {
        setToast(msgOf(r.error))
        return
      }
      setMode('view')
      await refresh()
      setToast(truncated ? '已保存（超长标签名已截断为 12 字）' : '已保存')
      return
    }
    const r = await window.tixing.create(payload)
    if (!r.ok) {
      setToast(msgOf(r.error))
      return
    }
    setSelectedId(r.data)
    setMode('view')
    await refresh()
    setToast(truncated ? '已新建（超长标签名已截断为 12 字）' : '已新建')
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
            ref={searchRef}
            className="search"
            placeholder="搜索题目 / 答案 / 解析 / 标签"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
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

          {tags.length > 0 && (
            <select
              className="tag-filter"
              value={tagFilter ?? ''}
              onChange={(e) => setTagFilter(e.target.value || null)}
              title="按标签筛选（单选）"
            >
              <option value="">全部标签</option>
              {tags.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}（{t.count}）
                </option>
              ))}
            </select>
          )}

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
                {r.tags.length > 0 && (
                  <div className="row-tags">
                    {r.tags.slice(0, 3).map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                    {r.tags.length > 3 && <span className="tag tag-more">+{r.tags.length - 3}</span>}
                  </div>
                )}
              </button>
            ))}
          </div>

          <div className="list-actions">
            <button
              className="ghost"
              onClick={startNew}
              disabled={mode !== 'view' || busy}
              title={mode !== 'view' ? '先保存或取消当前编辑' : '新建题目（Ctrl+N）'}
            >
              + 新建
            </button>
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
              {selected.tags.length > 0 && (
                <>
                  <h3>标签</h3>
                  <div className="row-tags">
                    {selected.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                </>
              )}
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
              <h3>标签</h3>
              <input
                className="tag-input"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                placeholder="逗号分隔，如：高数, 极限（每个不超过 12 字）"
              />
              <div className="actions">
                <button className="primary" type="submit">
                  保存
                </button>
                <button className="ghost" type="button" onClick={cancelForm}>
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
