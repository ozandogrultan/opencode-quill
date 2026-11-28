type PerPrompt = { metrics: string[]; alternatives?: boolean; prose: number[][] }

const REPORTED: [string, string, boolean][] = [
  ["wrongShown", "wrong shown", false],
  ["prefixSaved", "chars saved, prefix", true],
  ["nextSaved", "chars saved, next-word", true],
  ["nextWrong", "next-word wrong", false],
  ["endWrong", "complete-word wrong", false],
  ["netSaved", "net saved, alternatives", true],
]

function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pairedBootstrap(differences: number[], resamples = 2000, seed = 1) {
  const random = generator(seed)
  const n = differences.length
  const totals: number[] = []
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += differences[Math.floor(random() * n)]
    totals.push(sum)
  }
  totals.sort((a, b) => a - b)
  const total = differences.reduce((sum, value) => sum + value, 0)
  const low = totals[Math.floor(0.025 * (resamples - 1))]
  const high = totals[Math.ceil(0.975 * (resamples - 1))]
  return { total, low, high, excludesZero: low > 0 || high < 0 }
}

export function bootstrapReport(before: PerPrompt, after: PerPrompt, resamples = 2000, seed = 1): string {
  if (before.prose.length !== after.prose.length) throw new Error("per-prompt files cover different numbers of prompts")
  if (!before.prose.length) throw new Error("per-prompt files are empty")
  const lines = [`paired bootstrap: ${before.prose.length} prompts, ${resamples} resamples, seed ${seed}; difference = after - before, summed over prompts`]
  for (const [key, label, higherIsBetter] of REPORTED) {
    const column = before.metrics.indexOf(key)
    const other = after.metrics.indexOf(key)
    if (column < 0 || other < 0 || (key === "netSaved" && !(before.alternatives && after.alternatives))) continue
    const { total, low, high, excludesZero } = pairedBootstrap(before.prose.map((row, i) => after.prose[i][other] - row[column]), resamples, seed)
    const verdict = !excludesZero ? "CI includes 0" : (total > 0) === higherIsBetter ? "better, CI excludes 0" : "worse, CI excludes 0"
    lines.push(`  ${label.padEnd(26)}${String(total).padStart(7)}  95% CI [${low}, ${high}]  ${verdict}`)
  }
  return lines.join("\n")
}
