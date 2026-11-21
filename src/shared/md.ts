// 导入语法（README 里同步公开）：
//   # 题目
//   题干……
//   # 答案
//   ……
//   # 解析
//   ……
// 只认行首 1–3 个 # + 关键字，且关键字独占该行；一个文件可含多个「题目」块。

export interface ParsedQuestion {
  content: string
  answer: string
  analysis: string
}

const HEAD = /^#{1,3}\s*(题目|答案|解析)\s*$/

export function parseMarkdown(raw: string): ParsedQuestion[] {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text) return []

  const lines = text.split('\n')
  const hasQuestionHead = lines.some((line) => {
    const m = HEAD.exec(line)
    return !!m && m[1] === '题目'
  })

  // 兜底：找不到任何「题目」行 → 整篇当题目，答案留空（不报错，不打断批量导入）
  if (!hasQuestionHead) {
    return [{ content: text, answer: '', analysis: '' }]
  }

  const out: ParsedQuestion[] = []
  let content: string[] | null = null
  let answer: string[] = []
  let analysis: string[] = []
  let section: 'content' | 'answer' | 'analysis' = 'content'

  const flush = (): void => {
    if (content === null) return
    const c = content.join('\n').trim()
    if (c) {
      out.push({
        content: c,
        answer: answer.join('\n').trim(),
        analysis: analysis.join('\n').trim()
      })
    }
    content = null
    answer = []
    analysis = []
    section = 'content'
  }

  for (const line of lines) {
    const m = HEAD.exec(line)
    if (m) {
      const kind = m[1]
      if (kind === '题目') {
        flush()
        content = []
        answer = []
        analysis = []
        section = 'content'
      } else if (content === null) {
        // 第一个「题目」之前的答案/解析行：丢弃
        continue
      } else {
        section = kind === '答案' ? 'answer' : 'analysis'
      }
      continue
    }
    if (content === null) continue
    if (section === 'content') content.push(line)
    else if (section === 'answer') answer.push(line)
    else analysis.push(line)
  }
  flush()
  return out
}
