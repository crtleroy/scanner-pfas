// Codes-barres : clé de contrôle et normalisation au format des bases Open Facts (13 chiffres).

function cleGtin(chiffres: string): number {
  let somme = 0
  for (let i = chiffres.length - 1, poids = 3; i >= 0; i--, poids = poids === 3 ? 1 : 3) {
    somme += Number(chiffres[i]) * poids
  }
  return (10 - (somme % 10)) % 10
}

export function cleValide(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false
  return cleGtin(code.slice(0, -1)) === Number(code[code.length - 1])
}

/** Développe un UPC-E (8 chiffres) en UPC-A (12 chiffres). */
export function upcEversA(e: string): string | null {
  if (!/^[01]\d{7}$/.test(e)) return null
  const [ns, d1, d2, d3, d4, d5, d6, cle] = e.split('')
  let corps: string
  if ('012'.includes(d6)) corps = `${d1}${d2}${d6}0000${d3}${d4}${d5}`
  else if (d6 === '3') corps = `${d1}${d2}${d3}00000${d4}${d5}`
  else if (d6 === '4') corps = `${d1}${d2}${d3}${d4}00000${d5}`
  else corps = `${d1}${d2}${d3}${d4}${d5}0000${d6}`
  return `${ns}${corps}${cle}`
}

/**
 * Renvoie le code à interroger (EAN-13, ou EAN-8), ou null si la clé de contrôle est fausse.
 * `format` vient du lecteur de code-barres quand il est connu.
 */
export function normaliserCode(brut: string, format?: string): string | null {
  let code = brut.replace(/\D/g, '')
  if (format === 'upc_e' || (code.length === 8 && format === undefined && !cleValide(code) && upcEversA(code))) {
    const a = upcEversA(code)
    if (!a) return null
    code = a
  }
  if (!cleValide(code)) return null
  if (code.length === 12) return `0${code}`
  if (code.length === 14 && code.startsWith('0')) return code.slice(1)
  return code
}
