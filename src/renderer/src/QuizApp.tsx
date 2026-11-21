import { useEffect, useRef, useState } from 'react'
import type { QuizItem, Rating } from '../../shared/types'

function dueText(it: QuizItem): string {
  if (it.isNew) return '新题'
  if (it.status === '已逾期') return `已逾期 ${Math.max(1, Math.floor(it.daysOverdue))} 天`
  if (it.status === '今日到期') return '今日到期'
  return ''
}

export default function QuizApp(): JSX.Element {
  const [items, setItems] = useState<QuizItem[] | null>(null)
  const [idx, setIdx] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [canSnooze, setCanSnooze] = useState(true)
  const lock = useRef(false)
  const revealedRef = useRef(false)
  const idxRef = useRef(0)
  const itemsRef = useRef<QuizItem[] | null>(null)
  const canSnoozeRef = useRef(true)

  revealedRef.current = revealed
  idxRef.current = idx
  itemsRef.current = items
  canSnoozeRef.current = canSnooze

  useEffect(() => {
    void window.tixing.getBatch().then((r) => {
      if (r.ok) setItems(r.data)
    })
    void window.tixing.snoozeState().then((r) => {
      if (r.ok) setCanSnooze(r.data.allowed) // 当日第 4 次起置灰
    })
  }, [])

  useEffect(() => {
    window.focus()
  }, [idx])

  async function rate(rating: Rating): Promise<void> {
    const list = itemsRef.current
    const i = idxRef.current
    const cur = list?.[i]
    if (!cur || lock.current) return
    lock.current = true
    try {
      await window.tixing.rate(cur.id, rating)
      if (list && i + 1 < list.length) {
        setIdx(i + 1)
        setRevealed(false)
      } else {
        await window.tixing.done()
      }
    } finally {
      lock.current = false
    }
  }

  /** v1.1.1 稍后：关窗 + 10 分钟后重弹，写一条 rating = −1 的日志 */
  async function snooze(): Promise<void> {
    if (lock.current || !canSnoozeRef.current) return
    const cur = itemsRef.current?.[idxRef.current]
    if (!cur) return
    lock.current = true
    try {
      const r = await window.tixing.snooze(cur.id)
      if (!r.ok) setCanSnooze(false)
      // 成功时主进程会关掉本窗口
    } finally {
      lock.current = false
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // 中文输入法激活时 keydown 会被 composition 吞掉/标记，必须跳过
      if (e.isComposing) return
      const list = itemsRef.current
      const cur = list?.[idxRef.current]
      if (!cur) return

      if (e.code === 'Escape') {
        e.preventDefault()
        void window.tixing.skip(cur.id)
        return
      }
      if (e.code === 'KeyS') {
        if (canSnoozeRef.current) {
          e.preventDefault()
          void snooze()
        }
        return
      }
      if (!revealedRef.current) {
        if (e.code === 'Space' || e.code === 'Enter') {
          e.preventDefault()
          setRevealed(true)
        }
        return
      }
      if (e.code === 'Digit1' || e.code === 'Numpad1') {
        e.preventDefault()
        void rate(1)
      } else if (e.code === 'Digit2' || e.code === 'Numpad2') {
        e.preventDefault()
        void rate(2)
      } else if (e.code === 'Digit3' || e.code === 'Numpad3') {
        e.preventDefault()
        void rate(3)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!items) return <div className="quiz center muted">准备中…</div>
  if (items.length === 0) return <div className="quiz center muted">这一批没有题目</div>

  const it = items[idx]

  return (
    <div className="quiz">
      <div className="quiz-head">
        <span>
          题醒 · 本次 {idx + 1}/{items.length}
        </span>
        <div className="grow" />
        <span className="quiz-due">{dueText(it)}</span>
        <span
          className={'snooze-hint' + (canSnooze ? '' : ' off')}
          title={canSnooze ? '推迟 10 分钟后再弹' : '今日稍后次数已用完'}
          onClick={() => void snooze()}
        >
          稍后(S)
        </span>
        <span className="esc-hint">esc</span>
      </div>

      {!revealed ? (
        <div className="quiz-body">
          <pre className="q-text">{it.content}</pre>
          <button className="reveal" onClick={() => setRevealed(true)}>
            显示答案 · 空格
          </button>
        </div>
      ) : (
        <div className="quiz-body">
          <pre className="q-text small">{it.content}</pre>
          <div className="answer-box">
            <div className="label">答案</div>
            <pre className="a-text">{it.answer || '（无答案）'}</pre>
            {it.analysis && (
              <>
                <div className="label">解析</div>
                <pre className="a-text">{it.analysis}</pre>
              </>
            )}
          </div>
          <div className="q-actions">
            <button className="rate r1" onClick={() => void rate(1)}>
              不会 1
            </button>
            <button className="rate r2" onClick={() => void rate(2)}>
              模糊 2
            </button>
            <button className="rate r3" onClick={() => void rate(3)}>
              答对 3
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
