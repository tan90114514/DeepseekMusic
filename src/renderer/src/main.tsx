import ReactDOM from 'react-dom/client'
import App from './App'
import LyricsOverlay from './LyricsOverlay'
import { applyTheme, readThemeConfig, watchTheme } from './theme'
import './styles.css'

const lyricsMode = window.location.hash === '#lyrics'
if (lyricsMode) {
  document.documentElement.classList.add('lyrics-mode')
  document.body.classList.add('lyrics-mode')
}

applyTheme(readThemeConfig(), false)
if (lyricsMode) {
  watchTheme((theme) => applyTheme(theme, false))
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  lyricsMode ? <LyricsOverlay /> : <App />
)
