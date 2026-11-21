import type {
  FilterKey,
  ImportFile,
  ImportResult,
  LaunchResult,
  QuestionInput,
  QuestionView,
  QuizItem,
  Rating,
  Settings,
  SnoozeState,
  StatusSnapshot
} from './types'

export interface Ok<T> {
  ok: true
  data: T
}
export interface Err {
  ok: false
  error: string
}
export type Res<T> = Ok<T> | Err

/** preload 通过 contextBridge 暴露为 window.tixing */
export interface TixingApi {
  list(filter: FilterKey, q: string): Promise<Res<QuestionView[]>>
  get(id: number): Promise<Res<QuestionView | null>>
  create(input: QuestionInput): Promise<Res<number>>
  update(id: number, input: QuestionInput): Promise<Res<null>>
  remove(id: number): Promise<Res<null>>
  importFiles(files: ImportFile[]): Promise<Res<ImportResult>>
  getSettings(): Promise<Res<Settings>>
  setSettings(patch: Partial<Settings>): Promise<Res<Settings>>
  status(): Promise<Res<StatusSnapshot>>
  startQuizNow(): Promise<Res<LaunchResult>>
  getBatch(): Promise<Res<QuizItem[]>>
  rate(id: number, rating: Rating): Promise<Res<null>>
  done(): Promise<Res<null>>
  skip(id: number): Promise<Res<null>>
  /** v1.1.1 稍后 10 分钟（弹窗内 S）；id = 当前题（写 rating = −1 日志） */
  snooze(id: number): Promise<Res<null>>
  snoozeState(): Promise<Res<SnoozeState>>
  /** v1.1.0 提示条被点击 / 按 Esc 顺延 */
  prenudgeSkip(): Promise<void>
  backup(): Promise<Res<string | null>>
  restore(): Promise<Res<boolean>>
  quit(): Promise<void>
}
