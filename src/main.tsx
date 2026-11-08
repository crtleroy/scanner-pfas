import { render } from 'preact'
import { registerSW } from 'virtual:pwa-register'
import { App } from './app.tsx'
import './styles.css'

registerSW({ immediate: true })

// Quand une nouvelle version vient d'être installée, on recharge la page pour l'afficher tout de suite
// (sinon l'ancienne version reste affichée jusqu'à la prochaine ouverture).
if ('serviceWorker' in navigator) {
  const dejaControlee = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (dejaControlee) location.reload()
  })
}
render(<App />, document.getElementById('app')!)
