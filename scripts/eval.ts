import { Database } from "bun:sqlite"
import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"
import frequencies from "subtlex-word-frequencies"
import { completionQuery, proseGrammar, type Grammar } from "../src/prose"
import { PersonalModel, WordPredictor, type Prediction } from "../src/predictor"
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
const promptsPath = value("--prompts")
const freezePath = value("--freeze")
const measureAlternatives = flag("--alternatives")

type Prompt = { id: string; text: string }
type Corpus = { prose: Prompt[]; shell: Prompt[] }

const usable = (row: any): row is Prompt =>
  typeof row?.id === "string" && typeof row.text === "string" && !!row.text.trim() && row.text.length <= 4000 && row.text.split("\n").length <= 12

function fromDatabase(): Corpus {
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = (type: string, field: string) => db.query(
      "SELECT m.id AS id, json_extract(m.data, ?) AS text FROM session_message m JOIN session_v2 s ON s.id = m.session_id " +
      "WHERE m.type = ? AND s.parent_id IS NULL ORDER BY m.time_created, m.id",
    ).all(field, type) as Prompt[]
    return { prose: rows("user", "$.text"), shell: rows("shell", "$.command") }
  } finally {
    db.close()
  }
}

async function fromFile(path: string): Promise<Corpus> {
  const data = await Bun.file(path).json()
  return Array.isArray(data) ? { prose: data, shell: [] } : { prose: data.prose ?? [], shell: data.shell ?? [] }
}

function freezeParent(path: string): string {
  let parent = isAbsolute(path) ? sep : realpathSync(process.cwd())
  for (const part of path.split(sep)) {
    if (part === "..") parent = dirname(parent)
    else if (part && part !== ".") {
      const child = join(parent, part)
      const entry = lstatSync(child, { throwIfNoEntry: false })
      parent = entry ? realpathSync(child) : child
      if (entry && !(entry.isSymbolicLink() ? statSync(parent) : entry).isDirectory()) throw new Error("--freeze parent must be a directory")
    }
  }
  return parent
}

if (freezePath) {
  const root = dirname(realpathSync(import.meta.dir))
  const outsideRepo = (parent: string) => {
    const path = relative(root, parent)
    if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) throw new Error("--freeze must write outside the repository")
    return parent
  }
  const name = basename(freezePath)
  if (!name || name === "." || name === ".." || freezePath.endsWith(sep)) throw new Error("--freeze requires a file path")
  const parent = outsideRepo(freezeParent(dirname(freezePath)))
  const corpus = fromDatabase()
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const destination = join(outsideRepo(realpathSync(parent)), name)
  writeFileSync(destination, JSON.stringify(corpus), { flag: "wx", mode: 0o600 })
  console.log(`froze ${corpus.prose.length} prompts and ${corpus.shell.length} shell commands to ${freezePath}`)
  process.exit(0)
}

const raw = promptsPath ? await fromFile(promptsPath) : fromDatabase()
const corpus = { prose: raw.prose.filter(usable), shell: raw.shell.filter(usable) }

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
    nextPositions: 0, nextShown: 0, nextTop1: 0, nextWrong: 0, nextSaved: 0,
    bigramKnown: 0, bigramMissed: 0, bigramMissedNoSuggestion: 0, bigramMissedWrongList: 0,
    endPositions: 0, endShown: 0, endHarmless: 0, endWrong: 0,
  }
  const missed = new Map<string, number>()
  const alternatives = { wordsTop3: 0, wordsTop3WithSummon: 0, automaticSaved: 0, cycleSaved: 0, netSaved: 0, cyclePresses: 0, summonPresses: 0, acceptPresses: 0 }
  for (const prompt of test) {
    let cursor = 0
    let query: ReturnType<typeof completionQuery>
    let candidates: Prediction[] = []
    function replayTo(offset: number) {
      while (cursor < offset) {
        const previous = cursor
        cursor += prompt.text.codePointAt(cursor)! > 0xffff ? 2 : 1
        const text = prompt.text.slice(0, cursor)
        const last = candidates[0]
        query = completionQuery(text, cursor, [], true, grammar)
        candidates = query ? predictor.candidates(query) : []
        if (query && !query.next && last && !last.replace) {
          const typed = text.slice(previous)
          if (last.suffix.startsWith(typed) && typed.length < last.suffix.length) {
            const sticky = { ...last, suffix: last.suffix.slice(typed.length) }
            candidates = [sticky, ...candidates.filter((candidate) => candidate.word !== sticky.word)]
          }
        }
      }
      return { query, candidates }
    }
    for (const sequence of grammar.sequences(prompt.text)) {
      for (let index = 0; index < sequence.length; index++) {
        const { text: word, start, end } = sequence[index]
        const chars = [...prompt.text.slice(start, end)]
        const length = chars.length
        const target = prompt.text.slice(0, end)
        const matches = (prediction: Prediction, offset: number) =>
          prompt.text.slice(0, offset - (prediction.replace ?? 0)) + prediction.suffix === target
        let top3 = false
        let top3WithSummon = false
        let automaticSaved = 0
        let cycleSaved = 0
        let best = { saved: 0, cycles: 0, summons: 0 }
        const measure = (position: NonNullable<typeof query>, visible: Prediction[], offset: number, remaining: number) => {
          const summons = visible.length ? 0 : 1
          const choices = visible.length ? visible : predictor.candidates(position, 5, true)
          const rank = choices.findIndex((prediction) => matches(prediction, offset))
          if (rank < 0) return
          top3 ||= !summons && rank < 3
          top3WithSummon ||= rank < 3
          const cycles = Math.min(rank, choices.length - rank)
          const saved = remaining - 1 - cycles - summons
          if (!summons) {
            cycleSaved = Math.max(cycleSaved, saved)
            if (!cycles) automaticSaved = Math.max(automaticSaved, saved)
          }
          if (saved > best.saved || (saved > 0 && saved === best.saved && cycles + summons < best.cycles + best.summons)) {
            best = { saved, cycles, summons }
          }
        }
        m.words++
        m.wordChars += length
        const next = replayTo(start)
        if (index > 0 && next.query?.next) {
          if (measureAlternatives) measure(next.query, next.candidates, start, length)
          m.nextPositions++
          if (next.candidates.length) {
            m.nextShown++
            if (matches(next.candidates[0], start)) {
              m.nextTop1++
              m.nextSaved += Math.max(0, length - 1)
            } else m.nextWrong++
          }
          if ((bigrams.get(`${sequence[index - 1].text}\0${word}`) ?? 0) >= 2) {
            m.bigramKnown++
            if (!next.candidates.some((candidate) => matches(candidate, start))) {
              m.bigramMissed++
              if (next.candidates.length) m.bigramMissedWrongList++
              else m.bigramMissedNoSuggestion++
            }
          }
        }
        let first = -1
        let top5 = false
        let offset = start
        for (let k = 1; k < length; k++) {
          offset += chars[k - 1].length
          const { query, candidates } = replayTo(offset)
          if (!query || query.next) continue
          if (measureAlternatives) measure(query, candidates, offset, length - k)
          m.positions++
          if (!candidates.length) continue
          m.shown++
          if (matches(candidates[0], offset)) {
            if (first < 0) first = k
          } else {
            m.wrongShown++
            wrongByPrefix[k >= 4 ? "4+" : String(k)]++
          }
          if (candidates.slice(0, 5).some((candidate) => matches(candidate, offset))) top5 = true
        }
        const { query: ending, candidates: endCandidates } = replayTo(end)
        if (ending && !ending.next) {
          m.endPositions++
          if (endCandidates.length) {
            m.endShown++
            if (matches(endCandidates[0], end)) m.endHarmless++
            else m.endWrong++
          }
        }
        if (first > 0) {
          m.wordsTop1++
          m.prefixSaved += Math.max(0, length - first - 1)
        } else if (examples && length >= 3) missed.set(word, (missed.get(word) ?? 0) + 1)
        if (top5) m.wordsTop5++
        if (measureAlternatives) {
          alternatives.wordsTop3 += Number(top3)
          alternatives.wordsTop3WithSummon += Number(top3WithSummon)
          alternatives.automaticSaved += automaticSaved
          alternatives.cycleSaved += cycleSaved
          alternatives.netSaved += best.saved
          alternatives.cyclePresses += best.cycles
          alternatives.summonPresses += best.summons
          alternatives.acceptPresses += Number(best.saved > 0)
        }
      }
    }
  }
  return { ...m, alternatives: measureAlternatives ? alternatives : undefined, missedWords: examples ? [...missed].sort((a, b) => b[1] - a[1]).slice(0, 15) : undefined }
}

const examples = flag("--examples")
const result = {
  split,
  source: promptsPath ?? dbPath,
  prose: evaluate(proseGrammar, corpus.prose, examples),
  shell: evaluate(shellGrammar, corpus.shell, examples),
}

if (flag("--json")) {
  console.log(JSON.stringify(result))
} else {
  console.log(`source: ${result.source}`)
  console.log(`split: ${split} (train on the oldest ${split === "val" ? 64 : 80}%, report on the next ${split === "val" ? 16 : 20}%)`)
  console.log("complete-word positions: wrong = accepting the top suggestion changes the typed word (longer-word offer, apostrophe or typo replacement); harmless = accepting leaves the typed text unchanged")
  console.log("chars saved (code points): prefix = word length - prefix typed - 1 at the first prefix whose top-1 is right; next-word = word length - 1 when top-1 is right")
  if (measureAlternatives) console.log("alternatives: best available action per word, assuming the list fits and the intended candidate is known")
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
      ["complete-word positions", m.endPositions],
      ["  shown / harmless / wrong", `${m.endShown} / ${m.endHarmless} / ${m.endWrong}`],
      ["known bigram missing target", `${m.bigramMissed} of ${m.bigramKnown}`],
      ["  no suggestion / wrong list", `${m.bigramMissedNoSuggestion} / ${m.bigramMissedWrongList}`],
    ]
    for (const [label, count] of rows) console.log(`  ${label.padEnd(34)}${count}`)
    if (m.alternatives) {
      const a = m.alternatives
      console.log(`  top-3 words, visible / summoned  ${a.wordsTop3} / ${a.wordsTop3WithSummon} of ${m.words} (summoned includes visible)`)
      console.log(`  net saved, automatic / cycle / summon  ${a.automaticSaved} / ${a.cycleSaved} / ${a.netSaved}`)
      console.log(`  presses, accept / cycle / summon  ${a.acceptPresses} / ${a.cyclePresses} / ${a.summonPresses}`)
    }
    if (m.missedWords) console.log(`  top missed words: ${m.missedWords.map(([word, count]) => `${word}:${count}`).join(" ")}`)
  }
}
