import { leftContext, proseGrammar, proseWords, type CompletionQuery, type Grammar } from "./prose"

export type Frequency = { word: string; count: number }
export type Snapshot = {
  version: 1
  words: [string, number][]
  bigrams: [string, number][]
  trigrams: [string, number][]
  forms?: [string, number][]
  seen: string[]
  clearedAt?: number
}
export type Prompt = { id: string; text: string }
export type Prediction = { suffix: string; word: string; confidence: number; replace?: number }

const DISCOUNT = 0.5
const MIN_TYPO_SCORE = 0.000001
const PRIOR_LIMIT = 20_000
const WORD_LIMIT = 8000
const CONTEXT_LIMIT = 30_000
const DECAY_TOTAL = 100_000

export function emptySnapshot(): Snapshot {
  return { version: 1, words: [], bigrams: [], trigrams: [], forms: [], seen: [] }
}

function sentenceStart(text: string, start: number): boolean {
  let index = start - 1
  while (index >= 0 && /[ \t"“‘(\[*>#-]/.test(text[index])) index--
  return index < 0 || /[\n.!?:]/.test(text[index])
}

function restore(rows: [string, number][], limit: number, grammar: Grammar, parts = 1, forms = false): Map<string, number> {
  return new Map(rows.slice(0, limit).filter(([key, count]) => {
    if (typeof key !== "string" || key.length > parts * 64 + parts - 1 || !Number.isFinite(count) || count <= 0) return false
    const words = key.split("\0")
    return words.length === parts && words.every((word) => grammar.isWord(word) && (forms
      ? word === word.normalize("NFC").replaceAll("’", "'")
      : word === grammar.normalize(word)))
  }))
}

const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1]

export function trim(map: Map<string, number>, limit: number): [string, number][] {
  return [...map].reverse().sort(byCount).slice(0, limit).reverse().sort(byCount)
}

function increment(map: Map<string, number>, word: string): void {
  const count = map.get(word) ?? 0
  map.delete(word)
  map.set(word, count + 1)
}

export class PersonalModel {
  readonly words: Map<string, number>
  readonly bigrams: Map<string, number>
  readonly trigrams: Map<string, number>
  readonly forms: Map<string, number>
  readonly seen: Set<string>
  readonly clearedAt: number | undefined

  constructor(snapshot: Snapshot = emptySnapshot(), private readonly grammar: Grammar = proseGrammar) {
    this.clearedAt = Number.isFinite(snapshot.clearedAt) ? snapshot.clearedAt : undefined
    this.words = restore(snapshot.words, WORD_LIMIT, grammar)
    this.bigrams = restore(snapshot.bigrams, CONTEXT_LIMIT, grammar, 2)
    this.trigrams = restore(snapshot.trigrams, CONTEXT_LIMIT, grammar, 3)
    this.forms = restore(snapshot.forms ?? [], WORD_LIMIT, grammar, 1, true)
    this.seen = new Set(snapshot.seen)
  }

  observe(prompts: readonly Prompt[]): boolean {
    let changed = false
    for (const prompt of prompts) {
      if (this.seen.has(prompt.id)) continue
      this.seen.add(prompt.id)
      changed = true
      if (prompt.text.length > 4000 || prompt.text.split("\n").length > 12) continue
      const masked = this.grammar.prose ? this.grammar.mask(prompt.text) : prompt.text
      for (const sequence of this.grammar.sequences(prompt.text)) {
        const words = sequence.map((word) => word.text)
        for (let index = 0; index < words.length; index++) {
          const { start, end } = sequence[index]
          increment(this.words, words[index])
          const form = prompt.text.slice(start, end).normalize("NFC").replaceAll("’", "'")
          if (this.grammar.prose && form !== words[index] && !sentenceStart(masked, start)) increment(this.forms, form)
          if (index > 0) increment(this.bigrams, `${words[index - 1]}\0${words[index]}`)
          if (index > 1) increment(this.trigrams, `${words[index - 2]}\0${words[index - 1]}\0${words[index]}`)
        }
      }
    }
    let total = 0
    for (const count of this.words.values()) total += count
    if (total > DECAY_TOTAL) {
      for (const map of [this.words, this.bigrams, this.trigrams, this.forms]) {
        for (const [key, count] of map) {
          if (count > 1) map.set(key, Math.floor(count / 2))
          else map.delete(key)
        }
      }
    }
    return changed
  }

  snapshot(): Snapshot {
    return {
      version: 1,
      words: trim(this.words, WORD_LIMIT),
      bigrams: trim(this.bigrams, CONTEXT_LIMIT),
      trigrams: trim(this.trigrams, CONTEXT_LIMIT),
      forms: trim(this.forms, WORD_LIMIT),
      seen: [...this.seen],
      ...(this.clearedAt === undefined ? {} : { clearedAt: this.clearedAt }),
    }
  }
}

type Totals = { total: number; types: number; max: number }

function totals(counts: Map<string, number>): Map<string, Totals> {
  const result = new Map<string, Totals>()
  for (const [key, count] of counts) {
    const context = key.slice(0, key.lastIndexOf("\0"))
    const entry = result.get(context) ?? { total: 0, types: 0, max: 0 }
    entry.total += count
    entry.types++
    entry.max = Math.max(entry.max, count)
    result.set(context, entry)
  }
  return result
}

function lowerBound(words: readonly string[], prefix: string): number {
  let low = 0
  let high = words.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (words[middle] < prefix) low = middle + 1
    else high = middle
  }
  return low
}

function editKind(source: string, target: string, targetLength = target.length): "transpose" | "insert" | "delete" | "substitute" | undefined {
  const sourceLength = source.length
  if (Math.abs(sourceLength - targetLength) > 1) return
  let i = 0
  while (i < sourceLength && i < targetLength && source.charCodeAt(i) === target.charCodeAt(i)) i++
  if (i === sourceLength && i === targetLength) return
  if (sourceLength === targetLength) {
    if (i + 1 < sourceLength && source.charCodeAt(i) === target.charCodeAt(i + 1) && source.charCodeAt(i + 1) === target.charCodeAt(i)) {
      for (let j = i + 2; j < sourceLength; j++) if (source.charCodeAt(j) !== target.charCodeAt(j)) return
      return "transpose"
    }
    for (let j = i + 1; j < sourceLength; j++) if (source.charCodeAt(j) !== target.charCodeAt(j)) return
    return "substitute"
  }
  if (sourceLength < targetLength) {
    for (let j = i; j < sourceLength; j++) if (source.charCodeAt(j) !== target.charCodeAt(j + 1)) return
    return "insert"
  }
  for (let j = i; j < targetLength; j++) if (source.charCodeAt(j + 1) !== target.charCodeAt(j)) return
  const doubled = (i > 0 && source.charCodeAt(i) === source.charCodeAt(i - 1)) || (i + 1 < sourceLength && source.charCodeAt(i) === source.charCodeAt(i + 1))
  return doubled ? "delete" : undefined
}

function typoWeight(prefix: string, word: string, wholeWord = false): number {
  const prefixLength = prefix.length
  const wordLength = word.length
  if (prefixLength < 3) return 0
  const sameHead = prefix[0] === word[0]
  const swappedHead = prefixLength >= 5 && prefix[0] === word[1] && prefix[1] === word[0]
  if (!sameHead && !swappedHead) return 0
  const full = editKind(prefix, word)
  if (wholeWord && !full) return 0
  if (full === "transpose") return 0.25
  if (full && prefixLength < 5 && !word.includes("'")) return 0
  if (full === "insert" || full === "delete") return 0.06
  if (full === "substitute") return 0.04
  if (prefixLength < 5 || wordLength <= prefixLength) return 0
  const partial = editKind(prefix, word, prefixLength)
  if (partial === "transpose") return 0.06
  if (partial === "substitute") return 0.02
  if (wordLength > prefixLength + 1 && editKind(prefix, word, prefixLength + 1) === "insert") return 0.03
  if (editKind(prefix, word, prefixLength - 1) === "delete") return 0.02
  return 0
}

function typoConfidence(score: number, total: number): number | undefined {
  if (score < MIN_TYPO_SCORE || score / (total || 1) < 0.45) return
  return score
}

function applyCase(source: string, word: string): string {
  if (source.length > 1 && source === source.toUpperCase()) return word.toUpperCase()
  const first = source[0]
  if (first && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return word[0].toUpperCase() + word.slice(1)
  }
  return word === "i" || word.startsWith("i'") ? `I${word.slice(1)}` : word
}

export class WordPredictor {
  private revision = 0

  get modelRevision(): number { return this.revision }

  readonly prior = new Map<string, number>()
  private priorTotal = 0
  private personal = new PersonalModel()
  private personalTotal = 0
  private bigramTotals = new Map<string, Totals>()
  private trigramTotals = new Map<string, Totals>()
  private vocabulary: string[] = []
  private known = new Set<string>()
  private followers = new Map<string, string[]>()
  private forms = new Map<string, string>()

  constructor(prior: readonly Frequency[], readonly grammar: Grammar = proseGrammar) {
    for (const { word, count } of prior) {
      const key = grammar.normalize(word)
      if (!grammar.isWord(key) || !Number.isFinite(count) || count <= 0) continue
      this.prior.set(key, (this.prior.get(key) ?? 0) + count)
      this.priorTotal += count
      if (this.prior.size >= PRIOR_LIMIT) break
    }
    this.setPersonal(emptySnapshot())
  }

  setPersonal(snapshot: Snapshot): void {
    this.revision++
    this.personal = new PersonalModel(snapshot, this.grammar)
    this.personalTotal = [...this.personal.words.values()].reduce((sum, count) => sum + count, 0)
    this.bigramTotals = totals(this.personal.bigrams)
    this.trigramTotals = totals(this.personal.trigrams)
    const counts = this.personal.words
    const learned = [...counts].filter(([, count]) => count >= 2).map(([word]) => word).sort()
    const fragments = new Set<string>()
    for (let index = 0; index < learned.length; index++) {
      const word = learned[index]
      if (this.prior.has(word)) continue
      for (let next = index + 1; next < learned.length && learned[next].startsWith(word); next++) {
        if (!"/-.".includes(learned[next][word.length]) && counts.get(learned[next])! >= counts.get(word)!) {
          fragments.add(word)
          break
        }
      }
    }
    this.vocabulary = [...new Set([...this.prior.keys(), ...learned.filter((word) => !fragments.has(word))])].sort()
    this.known = new Set(this.vocabulary)
    this.followers = new Map()
    for (const map of [this.personal.bigrams, this.personal.trigrams]) {
      for (const [key, count] of map) {
        if (count < 2) continue
        const split = key.lastIndexOf("\0")
        const context = key.slice(0, split)
        const list = this.followers.get(context) ?? []
        list.push(key.slice(split + 1))
        this.followers.set(context, list)
      }
    }
    const forms = new Map<string, [string, number]>()
    for (const [form, count] of this.personal.forms) {
      const word = this.grammar.normalize(form)
      if ((forms.get(word)?.[1] ?? 0) < count) forms.set(word, [form, count])
    }
    this.forms = new Map([...forms].filter(([word, [, count]]) => count * 2 > (counts.get(word) ?? 0)).map(([word, [form]]) => [word, form]))
  }

  private *nearbyWords(prefix: string, wholeWord = false): IterableIterator<string> {
    const heads = [prefix[0]]
    if (prefix.length >= 5 && prefix[0] !== prefix[1]) heads.push(prefix[1] + prefix[0])
    const maxLength = wholeWord || prefix.length < 5 ? prefix.length + 1 : Infinity
    for (const head of heads) {
      for (let index = lowerBound(this.vocabulary, head); index < this.vocabulary.length; index++) {
        const word = this.vocabulary[index]
        if (!word.startsWith(head)) break
        if (!word.includes("/") && word.length >= prefix.length - 1 && word.length <= maxLength) yield word
      }
    }
  }

  private score(word: string, context: readonly string[], typo = false): number {
    const prior = (this.prior.get(word) ?? 0) / (this.priorTotal || 1)
    const personal = (this.personal.words.get(word) ?? 0) / (this.personalTotal || 1)
    const ratio = this.personalTotal / (this.personalTotal + 100)
    const weight = this.priorTotal ? (typo ? Math.min(0.7, ratio) : ratio) : 1
    let score = weight * personal + (1 - weight) * prior
    const previous = context.at(-1)
    const bigram = previous && this.bigramTotals.get(previous)
    if (bigram) {
      const count = this.personal.bigrams.get(`${previous}\0${word}`) ?? 0
      score = Math.max(count - DISCOUNT, 0) / bigram.total + DISCOUNT * bigram.types / bigram.total * score
    }
    const pair = context.length === 2 ? context.join("\0") : undefined
    const trigram = pair && this.trigramTotals.get(pair)
    if (trigram && trigram.total >= 2) {
      const count = this.personal.trigrams.get(`${pair}\0${word}`) ?? 0
      const discounted = Math.max(count - DISCOUNT, 0) / trigram.total + DISCOUNT * trigram.types / trigram.total * score
      score = trigram.max >= 2 ? discounted : Math.max(score, discounted)
    }
    return score
  }

  private resolveContext(raw: readonly string[], local: ReadonlyMap<string, number>): string[] {
    if (!this.grammar.prose) return [...raw]
    const resolved: string[] = []
    for (const word of raw) {
      if (this.prior.has(word) || (this.personal.words.get(word) ?? 0) >= 2 || (local.get(word) ?? 0) >= 2 || word.length < 3) {
        resolved.push(word)
        continue
      }
      let best = word
      let bestScore = 0
      let sum = 0
      for (const candidate of this.nearbyWords(word, true)) {
        if ((this.bigramTotals.get(candidate)?.total ?? 0) < 2) continue
        const weight = typoWeight(word, candidate, true)
        if (!weight) continue
        const score = this.score(candidate, resolved, true) * weight
        sum += score
        if (score > bestScore) {
          best = candidate
          bestScore = score
        }
      }
      resolved.push(typoConfidence(bestScore, sum) === undefined ? word : best)
    }
    return resolved
  }

  candidates(query: CompletionQuery, limit = 5): Prediction[] {
    const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(5, Math.floor(limit))) : 5
    if (!maximum) return []
    const prefix = this.grammar.normalize(query.prefix)
    const words = query.words ?? (this.grammar.prose ? proseWords(query.before) : [])
    const local = new Map<string, number>()
    for (const word of words) increment(local, word.text)
    const context = this.resolveContext(leftContext(query.before, words), local)
    const previous = context.at(-1)
    const pair = context.length === 2 ? context.join("\0") : undefined
    const evidence = this.bigramTotals.get(previous ?? "")?.total ?? 0
    if (query.next && evidence < 2) return []
    if (!query.next && [...prefix].length < 2 && evidence < 2) return []
    const slash = prefix.includes("/")
    const followed = (word: string) => (previous ? this.personal.bigrams.get(`${previous}\0${word}`) ?? 0 : 0) >= 2 ||
      (pair ? this.personal.trigrams.get(`${pair}\0${word}`) ?? 0 : 0) >= 2
    const eligible = (word: string) => !query.next || followed(word)
    const candidates = new Map<string, number>()
    if (query.next) {
      const next = new Set([...this.followers.get(previous ?? "") ?? [], ...(pair && this.followers.get(pair)) || []])
      for (const word of [...next].sort()) if (this.known.has(word) && word.startsWith(prefix)) candidates.set(word, 1)
    } else {
      for (let index = lowerBound(this.vocabulary, prefix); index < this.vocabulary.length; index++) {
        const word = this.vocabulary[index]
        if (!word.startsWith(prefix)) break
        if (slash === word.includes("/")) candidates.set(word, 1)
      }
    }
    for (const word of local.keys()) if (!word.includes("/") && word.startsWith(prefix) && (query.next || !slash) && eligible(word)) candidates.set(word, 1)
    const suggest = (): Prediction[] => {
      const ranked: { word: string; score: number; weight: number }[] = []
      let sum = 0
      for (const [word, weight] of candidates) {
        const base = this.score(word, context, weight < 1) + (query.next ? 0 : 0.003 * Math.min(local.get(word) ?? 0, 3))
        const score = base * weight
        sum += score
        ranked.push({ word, score, weight })
        ranked.sort((a, b) => b.score - a.score)
        if (ranked.length > maximum) ranked.pop()
      }
      const predictions: Prediction[] = []
      for (const { word: best, score: bestScore, weight: bestWeight } of ranked) {
        const confidence = bestWeight < 1 ? typoConfidence(bestScore, sum) : query.next ? bestScore : bestScore / (sum || 1)
        if (!bestScore || best === prefix || confidence === undefined || (bestWeight === 1 && confidence < 0.3)) {
          if (!predictions.length) return []
          continue
        }
        const form = this.forms.get(best) ?? best
        const shouting = this.grammar.prose && query.prefix.length > 1 && query.prefix === query.prefix.toUpperCase()
        if (bestWeight < 1 || (!query.next && best.startsWith("i'") && query.prefix[0] === "i") ||
          (!query.next && ((!shouting && form !== best && !form.startsWith(query.prefix)) || form.length !== best.length))) {
          predictions.push({ suffix: applyCase(query.prefix, form), word: best, confidence, replace: query.prefix.length })
        } else if (query.next) {
          predictions.push({ suffix: this.grammar.prose ? applyCase("", form) : form, word: best, confidence })
        } else {
          const suffix = form.slice(prefix.length)
          predictions.push({ suffix: shouting ? suffix.toUpperCase() : suffix, word: best, confidence })
        }
      }
      return predictions
    }
    const completion = suggest()
    if (completion.length || query.next || prefix.length < 3 || slash || candidates.has(prefix) || !this.grammar.prose) return completion
    for (const word of this.nearbyWords(prefix)) {
      if (candidates.has(word)) continue
      const weight = typoWeight(prefix, word)
      if (weight > 0) candidates.set(word, weight)
    }
    for (const word of local.keys()) {
      if (candidates.has(word) || word.includes("/")) continue
      const weight = typoWeight(prefix, word)
      if (weight > 0) candidates.set(word, weight)
    }
    return suggest()
  }
}
