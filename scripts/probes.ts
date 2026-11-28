import frequencies from "subtlex-word-frequencies"
import { completionQuery } from "../src/prose"
import { PersonalModel, WordPredictor } from "../src/predictor"

const PREFIX = "please "
const WORDS = 80
const LETTERS = "abcdefghijklmnopqrstuvwxyz"

type Edit = (word: string, index: number) => string | undefined
type Outcome = { replaced: number; appended: number; total: number }

const prior = [...frequencies].sort((a, b) => b.count - a.count)
const known = new Set(prior.map(({ word }) => word))

const pool = prior.map(({ word }) => word).filter((word) => /^[a-z]{6,9}$/.test(word)).slice(800, 800 + WORDS * 4)
  .filter((_, index) => index % 4 === 0)

const kinds: Record<string, Edit> = {
  swap: (word, index) => {
    const at = 1 + (index % (word.length - 2))
    return word[at] === word[at + 1] ? undefined : word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2)
  },
  missing: (word, index) => {
    const at = index % word.length
    return word.slice(0, at) + word.slice(at + 1)
  },
  doubled: (word, index) => {
    const at = 1 + (index % (word.length - 1))
    return word.slice(0, at) + word[at] + word.slice(at)
  },
  extra: (word, index) => {
    const at = 1 + (index % (word.length - 1))
    const letter = LETTERS[(index * 7 + 3) % 26]
    return letter === word[at] ? undefined : word.slice(0, at) + letter + word.slice(at)
  },
  wrong: (word, index) => {
    const at = 1 + (index % (word.length - 1))
    const letter = LETTERS[(index * 11 + 5) % 26]
    return letter === word[at] ? undefined : word.slice(0, at) + letter + word.slice(at + 1)
  },
}

function inserted(predictor: WordPredictor, typed: string, summoned = false) {
  const text = PREFIX + typed
  const top = predictor.candidates(completionQuery(text, text.length)!, 1, summoned)[0]
  return top && text.slice(0, text.length - (top.replace ?? 0)) + top.suffix
}

function typoProbes(predictor: WordPredictor): Record<string, Outcome> {
  const result: Record<string, Outcome> = {}
  for (const [kind, edit] of Object.entries(kinds)) {
    const outcome = { replaced: 0, appended: 0, total: 0 }
    pool.forEach((word, index) => {
      const typed = edit(word, index)
      if (!typed || typed === word || known.has(typed)) return
      outcome.total++
      const text = PREFIX + typed
      const top = predictor.candidates(completionQuery(text, text.length)!, 1)[0]
      if (!top || inserted(predictor, typed) !== PREFIX + word) return
      if (top.replace) outcome.replaced++
      else outcome.appended++
    })
    result[kind] = outcome
  }
  return result
}

const CONTRACTIONS: [string, string, string][] = [
  ["cant", "can't", "we"], ["wont", "won't", "they"], ["dont", "don't", "please"], ["didnt", "didn't", "then"],
  ["isnt", "isn't", "this"], ["couldnt", "couldn't", "it"], ["youre", "you're", "and"], ["im", "i'm", "so"],
]

function learn(texts: string[]): PersonalModel {
  const model = new PersonalModel()
  model.observe(texts.map((text, index) => ({ id: String(index), text })))
  return model
}

function apostropheProbes() {
  const count = (predictor: WordPredictor) => CONTRACTIONS.filter(([typed, word, before]) => {
    const text = `${before} ${typed}`
    const top = predictor.candidates(completionQuery(text, text.length)!, 1)[0]
    return top?.replace && text.slice(0, text.length - top.replace) + top.suffix === `${before} ${word}`
  }).length
  const cold = new WordPredictor(frequencies)
  const learned = new WordPredictor(frequencies)
  learned.setPersonal(learn(CONTRACTIONS.flatMap(([, word, before]) => Array<string>(3).fill(`${before} ${word}`))).snapshot())
  return { total: CONTRACTIONS.length, cold: count(cold), learned: count(learned) }
}

const TECHNICAL = ["subagent", "openchamber", "kubectl", "terraform"]

function technicalProbes() {
  const swapped = (word: string) => word.slice(0, 3) + word[4] + word[3] + word.slice(5)
  const count = (predictor: WordPredictor) => TECHNICAL.filter((word) => inserted(predictor, swapped(word)) === PREFIX + word).length
  const cold = new WordPredictor(frequencies)
  const learned = new WordPredictor(frequencies)
  learned.setPersonal(learn(TECHNICAL.flatMap((word) => Array<string>(3).fill(`${PREFIX}${word}`))).snapshot())
  return { total: TECHNICAL.length, cold: count(cold), learned: count(learned) }
}

export function runProbes() {
  return {
    typos: typoProbes(new WordPredictor(frequencies)),
    apostrophes: apostropheProbes(),
    technicalTranspositions: technicalProbes(),
  }
}

export function printProbes(result: ReturnType<typeof runProbes>) {
  console.log("synthetic probes: injected typos on frequent prior words, shipped prior, no personal model; scored on the inserted text")
  for (const [kind, o] of Object.entries(result.typos)) {
    console.log(`  ${kind.padEnd(10)}${o.replaced + o.appended} of ${o.total} recovered (${o.replaced} replaced, ${o.appended} appended)`)
  }
  const a = result.apostrophes
  console.log(`  missing apostrophe, cold / learned  ${a.cold} / ${a.learned} of ${a.total}`)
  const t = result.technicalTranspositions
  console.log(`  technical swaps, cold / learned     ${t.cold} / ${t.learned} of ${t.total}`)
}
