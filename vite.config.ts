import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'

// L'appli est publiée sur https://crtleroy.github.io/scanner-pfas/
export default defineConfig({
  base: '/scanner-pfas/',
  // Date de construction, affichée dans l'appli pour savoir quelle version tourne sur le téléphone
  define: {
    __VERSION__: JSON.stringify(
      new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    ),
  },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
      manifest: {
        name: 'Scanner PFAS',
        short_name: 'Scanner PFAS',
        description: 'Repère les PFAS dans la composition des produits à partir du code-barres ou de la liste des ingrédients.',
        lang: 'fr',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f5f6f7',
        theme_color: '#1f2933',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}', 'data/pfas.json', 'data/explications.json'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // Listes de référence lourdes : chargées à la demande, puis gardées
            urlPattern: ({ url }) => url.pathname.includes('/data/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'listes' },
          },
          {
            // Moteur et langues de Tesseract (OCR), servis par jsDelivr
            urlPattern: ({ url }) => url.hostname === 'cdn.jsdelivr.net',
            handler: 'CacheFirst',
            options: { cacheName: 'ocr', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
  server: { host: true, port: 5173 },
})
