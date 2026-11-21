import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import MainApp from './MainApp'
import QuizApp from './QuizApp'
import './styles.css'

const isQuiz = new URLSearchParams(location.search).has('quiz')
const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载点')

createRoot(root).render(<StrictMode>{isQuiz ? <QuizApp /> : <MainApp />}</StrictMode>)
