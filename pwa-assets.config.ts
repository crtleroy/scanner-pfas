import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: '#1f2933' } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: '#1f2933' } },
  },
  images: ['public/icon.svg'],
})
