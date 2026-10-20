import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { registerSW } from 'virtual:pwa-register'

// A new version of the app installs in the background; on an iPhone the open app would keep running the old
// code until it is fully closed. Look for a new version whenever the app comes to the front (and hourly),
// and switch to it at once (autoUpdate reloads the page when the new version takes over).
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return
    const check = () => { if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {}) }
    document.addEventListener('visibilitychange', check)
    setInterval(check, 60 * 60 * 1000)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
