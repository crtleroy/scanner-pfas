// Publie l'appli sur GitHub Pages (branche gh-pages du dépôt crtleroy/scanner-pfas).
// Usage : npm run deploy
import { execSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DEPOT = 'https://github.com/crtleroy/scanner-pfas.git'
const dist = join(process.cwd(), 'dist')
const sh = (cmd, cwd = process.cwd()) => execSync(cmd, { cwd, stdio: 'inherit' })

sh('npm run test')
sh('npm run build')
writeFileSync(join(dist, '.nojekyll'), '') // GitHub Pages sert les fichiers tels quels
rmSync(join(dist, '.git'), { recursive: true, force: true })
sh('git init -q -b gh-pages', dist)
sh('git add -A', dist)
sh(`git commit -q -m "Publication du ${new Date().toISOString().slice(0, 16).replace('T', ' ')}"`, dist)
sh(`git push -f ${DEPOT} gh-pages`, dist)
console.log('\nPublié : https://crtleroy.github.io/scanner-pfas/ (en ligne d’ici une à deux minutes)')
