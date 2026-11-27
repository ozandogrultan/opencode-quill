import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import frequencies from "subtlex-word-frequencies"
import { completionQuery, proseGrammar, type Grammar } from "../src/prose"
import { PersonalModel, WordPredictor } from "../src/predictor"
import { shellGrammar } from "../src/shell"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const split = value("--split") ?? "test"
if (split !== "val" && split !== "test") throw new Error("--split must be val or test")
const dbPath = value("--db") ?? join(homedir(), ".local/share/opencode/opencode.db")

type Prompt = { id: string; text: string }

function load(type: "user" | "shell"): Prompt[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    const field = type === "user" ? "$.text" : "$.command"
    return db.query(
      "SELECT m.id AS id, json_extract(m.data, ?) AS text FROM session_message m JOIN session_v2 s ON s.id = m.session_id " +
      "WHERE m.type = ? AND s.parent_id IS NULL ORDER BY m.time_created, m.id",
    ).all(field, type).filter((row: any) => typeof row.text === "string" && row.text.trim() && row.text.length <= 4000 && row.text.split("\n").length <= 12) as Prompt[]
  } finally {
    db.close()
  }
}

function partition(prompts: Prompt[]) {
  const trainEnd = Math.floor(prompts.length * 0.64)
  const valEnd = Math.floor(prompts.length * 0.8)
  return split === "val"
    ? { train: prompts.slice(0, trainEnd), test: prompts.slice(trainEnd, valEnd) }
    : { train: prompts.slice(0, valEnd), test: prompts.slice(valEnd) }
}

function evaluate(grammar: Grammar, prompts: Prompt[], examples: boolean) {
  const { train, test } = partition(prompts)
  const model = new PersonalModel(undefined, grammar)
  model.observe(train)
  const snapshot = model.snapshot()
  const predictor = new WordPredictor(grammar.prose ? frequencies : [], grammar, 0)
  predictor.setPersonal(snapshot)
  const bigrams = new Map<string, number>(snapshot.bigrams)
  const wrongByPrefix: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4+": 0 }
  const m = {
    train: train.length, test: test.length, words: 0, wordChars: 0,
    positions: 0, shown: 0, wrongShown: 0, wrongByPrefix,
    wordsTop1: 0, wordsTop5: 0, prefixSaved: 0,
    nextPositions: 0, nextShown: 0, nextTop1: 0, nextWrong: 0, nextSaved: 0, bigramMissed: 0, bigramKnown: 0,
  }
  const missed = new Map<string, number>()
  for (const prompt of test) {
    for (const sequence of grammar.sequences(prompt.text)) {
      for (let index = 0; index < sequence.length; index++) {
        const { text: word, start } = sequence[index]
        const length = [...word].length
        m.words++
        m.wordChars += length
        if (index > 0) {
          const query = completionQuery(prompt.text.slice(0, start), start, [], true, grammar)
          if (query?.next) {
            m.nextPositions++
            const candidates = predictor.candidates(query)
            if (candidates.length) {
              m.nextShown++
              if (candidates[0].word === word) {
                m.nextTop1++
                m.nextSaved += Math.max(0, length - 1)
              } else m.nextWrong++
            }
            if ((bigrams.get(`${sequence[index - 1].text}\0${word}`) ?? 0) >= 2) {
              m.bigramKnown++
              if (!candidates.some((candidate) => candidate.word === word)) m.bigramMissed++
            }
          }
        }
        let first = -1
        let top5 = false
        for (let k = 1; k < length; k++) {
          const typed = prompt.text.slice(start, start + k)
          const query = completionQuery(prompt.text.slice(0, start) + typed, start + k, [], true, grammar)
          if (!query || query.next) continue
          m.positions++
          const candidates = predictor.candidates(query)
          if (!candidates.length) continue
          m.shown++
          if (candidates[0].word === word && candidates[0].replace === undefined) {
            if (first < 0) first = k
          } else {
            m.wrongShown++
            wrongByPrefix[k >= 4 ? "4+" : String(k)]++
          }
          if (candidates.some((candidate) => candidate.word === word)) top5 = true
        }
        if (first > 0) {
          m.wordsTop1++
          m.prefixSaved += Math.max(0, length - first - 1)
        } else if (examples && length >= 3) missed.set(word, (missed.get(word) ?? 0) + 1)
        if (top5) m.wordsTop5++
      }
    }
  }
  return { ...m, missedWords: examples ? [...missed].sort((a, b) => b[1] - a[1]).slice(0, 15) : undefined }
}

const examples = flag("--examples")
const result = {
  split,
  prose: evaluate(proseGrammar, load("user"), examples),
  shell: evaluate(shellGrammar, load("shell"), examples),
}

if (flag("--json")) {
  console.log(JSON.stringify(result))
} else {
  console.log(`split: ${split} (train on the oldest ${split === "val" ? 64 : 80}%, report on the next ${split === "val" ? 16 : 20}%)`)
  console.log("chars saved: prefix = word length - prefix typed - 1 at the first prefix whose top-1 is right; next-word = word length - 1 when top-1 is right")
  for (const name of ["prose", "shell"] as const) {
    const m = result[name]
    console.log(`\n${name}: train ${m.train}, test ${m.test} prompts, ${m.words} words`)
    if (!m.words) continue
    const rows: [string, string | number][] = [
      ["prefix positions", m.positions],
      ["shown", m.shown],
      ["wrong shown", m.wrongShown],
      ["wrong at prefix 1/2/3/4+", Object.values(m.wrongByPrefix).join(" / ")],
      ["words completed by top-1", `${m.wordsTop1} of ${m.words}`],
      ["words within top-5", `${m.wordsTop5} of ${m.words}`],
      ["chars saved, prefix", m.prefixSaved],
      ["chars saved, next-word", m.nextSaved],
      ["next-word shown / top-1 / wrong", `${m.nextShown} / ${m.nextTop1} / ${m.nextWrong}`],
      ["bigram known but not shown", `${m.bigramMissed} of ${m.bigramKnown}`],
    ]
    for (const [label, count] of rows) console.log(`  ${label.padEnd(34)}${count}`)
    if (m.missedWords) console.log(`  top missed words: ${m.missedWords.map(([word, count]) => `${word}:${count}`).join(" ")}`)
  }
}
