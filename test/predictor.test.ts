import { expect, spyOn, test } from "bun:test"
import frequencies from "subtlex-word-frequencies"
import { emptySnapshot, PersonalModel, trim, WordPredictor } from "../src/predictor"
import { completionQuery, proseGrammar } from "../src/prose"

test("trim evicts the oldest entry among equal counts and keeps the row order", () => {
  const map = new Map([["old", 1], ["mid", 1], ["hot", 3], ["new", 1]])
  expect(trim(map, 3)).toEqual([["hot", 3], ["mid", 1], ["new", 1]])
  expect(trim(map, 10)).toEqual([["hot", 3], ["old", 1], ["mid", 1], ["new", 1]])
  expect(trim(new Map(trim(map, 3)), 3)).toEqual(trim(map, 3))
})

test("a repeated singleton moves to the newest position and survives trimming", () => {
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "alpha beta gamma" }, { id: "2", text: "delta epsilon zeta" }, { id: "3", text: "alpha beta" }])
  expect(model.bigrams.get("alpha\0beta")).toBe(2)
  expect(trim(model.bigrams, 2).map(([key]) => key)).toEqual(["alpha\0beta", "epsilon\0zeta"])
})

test("saturated context maps keep learning new phrases", () => {
  const model = new PersonalModel({
    ...emptySnapshot(),
    trigrams: Array.from({ length: 30_000 }, (_, index): [string, number] => [`a${String(index).replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)))}\0b\0c`, 1]),
  })
  model.observe([{ id: "1", text: "please review carefully" }, { id: "2", text: "please review carefully" }])
  const snapshot = model.snapshot()
  expect(snapshot.trigrams).toHaveLength(30_000)
  expect(snapshot.trigrams[0]).toEqual(["please\0review\0carefully", 2])
  expect(snapshot.trigrams.some(([key]) => key === "a0\0b\0c")).toBe(false)
})

function complete(predictor: WordPredictor, text: string) {
  return predictor.candidates(completionQuery(text, text.length)!, 1)[0]
}

test("minimum word length filters whole words, not their remaining letters", () => {
  const predictor = new WordPredictor([
    { word: "text", count: 6 },
    { word: "tests", count: 4 },
  ], proseGrammar, 5)

  expect(complete(predictor, "te")).toMatchObject({ word: "tests", suffix: "sts" })
  expect(predictor.candidates(completionQuery("te", 2)!).map(({ word }) => word)).toEqual(["tests"])
  expect(complete(predictor, "test")).toMatchObject({ word: "tests", suffix: "s" })
  expect(complete(predictor, "tex")).toBeUndefined()

  expect(complete(predictor, "text please tex")).toBeUndefined()
  expect(complete(predictor, "quill please quil")).toMatchObject({ word: "quill", suffix: "l" })
})

test("hiding a short word does not make an unlikely longer word worth suggesting", () => {
  const predictor = new WordPredictor([
    { word: "text", count: 99 },
    { word: "tests", count: 1 },
  ], proseGrammar, 5)

  expect(complete(predictor, "te")).toBeUndefined()
})

test("minimum word length does not force a longer word when the typed word is already correct", () => {
  const predictor = new WordPredictor([
    { word: "the", count: 1000 },
    { word: "there", count: 1 },
  ], proseGrammar, 5)

  expect(complete(predictor, "the")).toBeUndefined()
})

test("minimum word length applies to next words and corrections without discarding short context words", () => {
  const model = new PersonalModel()
  model.observe([
    { id: "1", text: "please run tests" }, { id: "2", text: "please run tests" },
    { id: "3", text: "please write text" }, { id: "4", text: "please write text" },
  ])
  const predictor = new WordPredictor([{ word: "run", count: 1 }, { word: "tests", count: 1 }, { word: "text", count: 1 }], proseGrammar, 5)
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please run ")).toMatchObject({ word: "tests" })
  expect(complete(predictor, "please rnu ")).toMatchObject({ word: "tests" })
  expect(complete(predictor, "please write ")).toBeUndefined()
  expect(complete(predictor, "please run tsets")).toMatchObject({ word: "tests", replace: 5 })
  expect(complete(predictor, "please write txet")).toBeUndefined()
})

test("minimum word length counts Unicode code points rather than UTF-16 code units", () => {
  for (const length of [4, 5]) {
    const word = "𐐨".repeat(length)
    const predictor = new WordPredictor([{ word, count: 1 }], proseGrammar, 5)
    const prediction = complete(predictor, "𐐨𐐨")
    if (length < 5) expect(prediction).toBeUndefined()
    else expect(prediction).toMatchObject({ word, suffix: "𐐨".repeat(3) })
  }
})

test("ranked candidates are bounded, confident, and keep the original best completion", () => {
  const predictor = new WordPredictor([{ word: "complete", count: 6 }, { word: "compare", count: 4 }, { word: "company", count: 0.1 }])
  const query = completionQuery("please comp", 11)!
  const best = predictor.candidates(query, 1)[0]!
  const ranked = predictor.candidates(query)
  expect(ranked[0]).toEqual(best)
  expect(ranked.map(({ word }) => word)).toEqual(["complete", "compare"])
  expect(predictor.candidates(query, 1)).toEqual([best!])
  expect(predictor.candidates(query, 0)).toEqual([])
  expect(ranked.every(({ confidence }) => confidence >= 0.3)).toBe(true)
  const many = new WordPredictor(Array.from({ length: 20 }, (_, index) => ({ word: `word${String.fromCharCode(97 + index)}`, count: 1 })))
  expect(many.candidates(completionQuery("wo", 2)!, 100)).toEqual([])
  for (const text of ["the", "json", "fucn", "please "]) {
    const query = completionQuery(text, text.length)!
    const best = predictor.candidates(query, 1)[0]
    expect(predictor.candidates(query).slice(0, 1)).toEqual(best ? [best] : [])
  }
})

test("repeated JSON save and restore preserves dedupe, casing and ranked predictions", () => {
  let model = new PersonalModel()
  const predictor = new WordPredictor([])
  const prompts = [{ id: "session:a", text: "ask Ozan today" }, { id: "session:b", text: "ask Ozan today" }]
  model.observe(prompts)
  predictor.setPersonal(model.snapshot())
  const query = completionQuery("ask oz", 6)!
  const expected = predictor.candidates(query, 1)[0]
  const snapshot = model.snapshot()
  for (let round = 0; round < 5; round++) {
    model = new PersonalModel(JSON.parse(JSON.stringify(model.snapshot())))
    expect(model.observe(prompts)).toBe(false)
    expect(model.snapshot()).toEqual(snapshot)
    predictor.setPersonal(model.snapshot())
    expect(predictor.candidates(query, 1)[0]).toEqual(expected)
    expect(predictor.candidates(completionQuery("ask Ozan ", 9)!, 1)[0]).toMatchObject({ word: "today" })
  }
  expect(expected).toMatchObject({ suffix: "Ozan", replace: 2 })
})

test("cold-start completion uses the licensed vocabulary without history", () => {
  const predictor = new WordPredictor(frequencies)
  expect(complete(predictor, "pleas")?.suffix).toBe("e")
  expect(complete(predictor, "PLEAS")?.suffix).toBe("E")
  expect(complete(predictor, "Pleas")?.suffix).toBe("e")
  expect(complete(predictor, "the")).toBeUndefined()
  expect(complete(predictor, "please ")).toBeUndefined()
  expect(complete(predictor, "p")).toBeUndefined()
})

test("hides a learned fragment behind a longer learned word used at least as often", () => {
  const model = new PersonalModel()
  const predictor = new WordPredictor([])
  const prompts = (text: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${text}${index}`, text }))
  model.observe([...prompts("fix addr", 3), ...prompts("it was addressed", 4)])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "add")?.word).toBe("addressed")
  model.observe(prompts("see addr again", 5))
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "add")?.word).toBe("addr")
})

test("completes learned words with their usual mid-sentence casing", () => {
  const model = new PersonalModel()
  const predictor = new WordPredictor([])
  model.observe([
    { id: "1", text: "ask Ozan today" }, { id: "2", text: "ping Ozan now" },
    { id: "3", text: "Please ship it" }, { id: "4", text: "Please ship it" }, { id: "5", text: "please ship it" },
  ])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "ask Oz")).toMatchObject({ suffix: "an", word: "ozan" })
  expect(complete(predictor, "ask oz")).toMatchObject({ suffix: "Ozan", replace: 2 })
  expect(complete(predictor, "ask OZ")?.suffix).toBe("AN")
  expect(complete(predictor, "pl")?.suffix).toBe("ease")
})

test("halves learned counts once the model exceeds its size budget", () => {
  const model = new PersonalModel()
  const text = Array.from({ length: 10 }, () => Array(130).fill("go").join(" ")).join("\n")
  model.observe(Array.from({ length: 80 }, (_, index) => ({ id: String(index), text })))
  expect(model.words.get("go")).toBe(52_000)
  expect(model.bigrams.get("go\0go")).toBe(51_600)
  model.observe([{ id: "rare", text: "solo word" }])
  expect(model.words.get("solo")).toBe(1)
})

test("trigram context disambiguates completions and predicts following words", () => {
  const model = new PersonalModel()
  model.observe([
    { id: "1", text: "please run tests" }, { id: "2", text: "please run tests" },
    { id: "3", text: "please write text" }, { id: "4", text: "please write text" },
  ])
  const predictor = new WordPredictor([{ word: "tests", count: 1 }, { word: "text", count: 1 }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please run te")?.suffix).toBe("sts")
  expect(complete(predictor, "please write te")?.suffix).toBe("xt")
  expect(complete(predictor, "please run ")?.suffix).toBe("tests")
  expect(complete(predictor, "please write ")?.suffix).toBe("text")
})

test("learns new prose vocabulary only after repeated use", () => {
  const model = new PersonalModel()
  const predictor = new WordPredictor([])
  model.observe([{ id: "1", text: "please revise quillish" }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "quill")).toBeUndefined()
  model.observe([{ id: "2", text: "please revise quillish" }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "quill")?.suffix).toBe("ish")
  expect(complete(predictor, "please revise q")?.suffix).toBe("uillish")
})

test("learns and completes slash-joined tokens when typing the slash or second segment", () => {
  const model = new PersonalModel()
  const predictor = new WordPredictor(frequencies)
  expect(complete(predictor, "edit src/compo")).toBeUndefined()
  expect(complete(predictor, "machine/")).toBeUndefined()
  expect(complete(predictor, "machine/work please machine/")).toBeUndefined()
  model.observe([{ id: "0", text: "rebase machine/work onto origin/main." }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "machine/")).toBeUndefined()
  expect(complete(predictor, "machine/work please machine/")).toBeUndefined()
  model.observe([
    { id: "1", text: "rebase machine/work onto origin/main." },
    { id: "2", text: "rebase machine/work onto origin/main." },
  ])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "machine/")).toMatchObject({ suffix: "work", word: "machine/work" })
  expect(complete(predictor, "rebase machine/")).toMatchObject({ suffix: "work", word: "machine/work" })
  expect(complete(predictor, "rebase machine/w")).toMatchObject({ suffix: "ork", word: "machine/work" })
  expect(complete(predictor, "origin/")).toMatchObject({ suffix: "main", word: "origin/main" })
  expect(complete(predictor, "rebase ")?.suffix).toBe("machine/work")
  expect(complete(predictor, "the virtual machine")).toBeUndefined()
  expect(complete(predictor, "edit src/compo")).toBeUndefined()
})

test("preserves baseline vocabulary typo corrections and personal completion weight as the model grows", () => {
  const model = new PersonalModel({
    ...emptySnapshot(),
    words: [["alpha", 11_000], ["findings", 40], ["find", 15], ["subagents", 50], ["bash", 35]],
    bigrams: [["make\0sure", 25], ["make\0it", 10], ["make\0the", 10], ["now\0make", 1], ["current\0directory", 11], ["current\0session", 10], ["current\0file", 8]],
    trigrams: [["now\0make\0it", 1], ["the\0current\0directory", 11], ["the\0current\0session", 10], ["the\0current\0file", 8]],
  })
  const predictor = new WordPredictor(frequencies)
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "becua")).toMatchObject({ suffix: "because", word: "because", replace: 5 })
  expect(complete(predictor, "pleae")).toMatchObject({ suffix: "please", word: "please", replace: 5 })
  expect(complete(predictor, "find")).toMatchObject({ suffix: "ings", word: "findings" })
  expect(complete(predictor, "su")).toMatchObject({ suffix: "bagents", word: "subagents" })
  expect(complete(predictor, "ba")).toMatchObject({ suffix: "sh", word: "bash" })
  expect(complete(predictor, "make ")).toMatchObject({ suffix: "sure", word: "sure" })
  expect(complete(predictor, "now make ")).toMatchObject({ suffix: "sure", word: "sure" })
  expect(complete(predictor, "the current ")).toMatchObject({ suffix: "directory", word: "directory" })
})

test("prompt-local vocabulary is usable without being persisted", () => {
  const predictor = new WordPredictor([])
  expect(complete(predictor, "quillish please revise qui")?.suffix).toBe("llish")
})

test("keeps complete words as candidates instead of forcing a longer word", () => {
  const predictor = new WordPredictor([{ word: "the", count: 1000 }, { word: "there", count: 1 }])
  expect(complete(predictor, "the")).toBeUndefined()
  expect(complete(predictor, "ther")?.suffix).toBe("e")
})

test("deduplicates submitted messages across persistent model restores", () => {
  const prompts = [{ id: "session:1", text: "please run tests" }]
  const model = new PersonalModel()
  expect(model.observe(prompts)).toBe(true)
  const snapshot = model.snapshot()
  const restored = new PersonalModel(JSON.parse(JSON.stringify(snapshot)))
  expect(restored.observe(prompts)).toBe(false)
  expect(restored.snapshot()).toEqual(snapshot)
  expect(restored.words.get("tests")).toBe(1)
})

test("retains every processed ID beyond eight thousand across repeated JSON restores", () => {
  const prompts = Array.from({ length: 8001 }, (_, index) => ({ id: `session:${index}`, text: "please complete" }))
  prompts.push({ id: "session:paste", text: "hidden ".repeat(1000) }, { id: "session:lines", text: "hidden\n".repeat(13) })
  let model = new PersonalModel()
  expect(model.observe(prompts)).toBe(true)
  expect(model.seen.size).toBe(8003)
  const snapshot = model.snapshot()
  expect(snapshot.seen).toHaveLength(8003)
  for (let iteration = 0; iteration < 3; iteration++) {
    model = new PersonalModel(JSON.parse(JSON.stringify(model.snapshot())))
    expect(model.seen.size).toBe(8003)
    expect(model.observe(prompts)).toBe(false)
    expect(model.snapshot()).toEqual(snapshot)
    expect(model.words.get("please")).toBe(8001)
    expect(model.words.has("hidden")).toBe(false)
  }
  expect(model.observe([{ id: "session:new", text: "please complete" }])).toBe(true)
  expect(model.words.get("please")).toBe(8002)
  expect(model.snapshot().seen).toHaveLength(8004)
})

test("version one snapshots retain their existing counts and IDs without optional metadata", () => {
  const model = new PersonalModel({ version: 1, words: [["please", 9000]], bigrams: [], trigrams: [], seen: ["session:retained"] })
  expect(model.observe([{ id: "session:retained", text: "please" }])).toBe(false)
  expect(model.words.get("please")).toBe(9000)
  expect(model.observe([{ id: "session:new", text: "please" }])).toBe(true)
  expect(model.words.get("please")).toBe(9001)
  expect(model.snapshot().seen).toEqual(["session:retained", "session:new"])
})

test("ignores code, paths, assistant-free fixtures, and oversized pastes", () => {
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "please run `secretCode` src/private.ts tests" }, { id: "2", text: "secret ".repeat(1000) }])
  expect([...model.words.keys()]).toEqual(["please", "run", "tests"])
  expect(model.bigrams.has("run\0tests")).toBe(false)
  expect(model.words.has("secret")).toBe(false)
  expect(model.snapshot().seen).toEqual(["1", "2"])
})

test("handles normalized Unicode without replacing the typed prefix", () => {
  const predictor = new WordPredictor([{ word: "réviser", count: 10 }, { word: "請修正", count: 10 }])
  expect(complete(predictor, "re\u0301")?.suffix).toBe("viser")
  expect(complete(predictor, "請修")?.suffix).toBe("正")
})

test("bounded multilingual queries preserve script and normalization across JSON restores", () => {
  const samples = [["réviser", "re\u0301"], ["請修正", "請修"], ["приветствие", "прив"], ["مرحبا", "مر"], ["κόσμος", "κό"]]
  const model = new PersonalModel()
  const prompts = samples.map(([word], index) => ({ id: String(index), text: `${word} ${word}` }))
  model.observe(prompts)
  const snapshot = JSON.parse(JSON.stringify(model.snapshot()))
  const predictor = new WordPredictor([])
  predictor.setPersonal(snapshot)
  for (const [word, prefix] of samples) {
    const prediction = complete(predictor, prefix)!
    expect(prediction.replace).toBeUndefined()
    expect((prefix + prediction.suffix).normalize("NFC")).toBe(word)
    expect(predictor.candidates(completionQuery(prefix, prefix.length)!).length).toBeLessThanOrEqual(5)
  }
  expect(new PersonalModel(snapshot).observe(prompts)).toBe(false)
})

test("paste boundaries bound learning without changing dedupe or admitting oversized text", () => {
  const model = new PersonalModel()
  const atLimit = "alpha ".repeat(666) + "beta"
  expect(atLimit.length).toBe(4000)
  model.observe([
    { id: "at-limit", text: atLimit },
    { id: "over-limit", text: atLimit + " " },
    { id: "twelve-lines", text: Array(12).fill("gamma").join("\n") },
    { id: "thirteen-lines", text: Array(13).fill("delta").join("\n") },
  ])
  expect(model.words.get("alpha")).toBe(666)
  expect(model.words.get("beta")).toBe(1)
  expect(model.words.get("gamma")).toBe(12)
  expect(model.words.has("delta")).toBe(false)
  expect(model.snapshot().seen).toHaveLength(4)
})

test("a blank snapshot is durable JSON without raw prompt text", () => {
  const model = new PersonalModel(emptySnapshot())
  model.observe([{ id: "1", text: "please run tests" }])
  expect(JSON.stringify(model.snapshot())).not.toContain("please run tests")
})

test("does not inflate next-word confidence when rare learned words are withheld", () => {
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "please choose quillish" }, { id: "2", text: "please choose quillous" }])
  const predictor = new WordPredictor([{ word: "the", count: 1000 }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please choose ")).toBeUndefined()
})

test("corrects current-word typos and mistyped prefixes while preserving casing", () => {
  const predictor = new WordPredictor(frequencies)
  expect(complete(predictor, "teh")).toMatchObject({ suffix: "the", word: "the", replace: 3 })
  expect(complete(predictor, "Teh")).toMatchObject({ suffix: "The", word: "the", replace: 3 })
  expect(complete(predictor, "TEH")).toMatchObject({ suffix: "THE", word: "the", replace: 3 })
  expect(complete(predictor, "pleae")).toMatchObject({ suffix: "please", word: "please", replace: 5 })
  expect(complete(predictor, "lpease")).toMatchObject({ suffix: "please", word: "please", replace: 6 })
  expect(complete(predictor, "becua")).toMatchObject({ suffix: "because", word: "because", replace: 5 })
})

test("prefers confident prefix completions to typo replacements with the bundled vocabulary", () => {
  const predictor = new WordPredictor(frequencies)
  for (const [prefix, word] of [["whate", "whatever"], ["cann", "cannot"], ["wat", "watch"], ["mee", "meet"], ["nad", "nada"]]) {
    expect(complete(predictor, prefix)).toMatchObject({ suffix: word.slice(prefix.length), word })
    expect(complete(predictor, prefix)?.replace).toBeUndefined()
  }
})

test("repairs left-context typos after a single learned occurrence", () => {
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "please run tests" }, { id: "2", text: "please run tests" }])
  const predictor = new WordPredictor(frequencies)
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please rnu ")?.suffix).toBe("tests")
  model.observe([{ id: "3", text: "please rnu tests" }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please rnu ")?.suffix).toBe("tests")
  expect(complete(predictor, "please rnu te")?.suffix).toBe("sts")
})

test("refreshes learned typo candidates when the personal model is cleared", () => {
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "quillish" }, { id: "2", text: "quillish" }])
  const predictor = new WordPredictor([])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "quillsh")).toMatchObject({ word: "quillish", suffix: "quillish", replace: 7 })
  predictor.setPersonal(emptySnapshot())
  expect(complete(predictor, "quillsh")).toBeUndefined()
})

test("does not replace short technical tokens with English near-matches", () => {
  const predictor = new WordPredictor(frequencies)
  for (const token of ["json", "yaml", "bool", "opts", "enum"]) {
    expect(complete(predictor, token)).toBeUndefined()
  }
})

test("abstains on short mistyped prefixes and can correct a learned technical word", () => {
  const predictor = new WordPredictor(frequencies)
  expect(complete(predictor, "fucn")).toBeUndefined()
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "func" }, { id: "2", text: "func" }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "fucn")).toMatchObject({ word: "func", suffix: "func", replace: 4 })
})

test("keeps typo penalties in confidence even with a single candidate", () => {
  const predictor = new WordPredictor([{ word: "please", count: 1 }])
  const prediction = complete(predictor, "pleae")
  expect(prediction).toMatchObject({ word: "please", replace: 5 })
  expect(prediction!.confidence).toBeLessThanOrEqual(0.06)
  const lessLikely = new WordPredictor([{ word: "please", count: 1 }, { word: "unrelated", count: 9999 }])
  expect(complete(lessLikely, "pleae")?.confidence).toBeCloseTo(0.06 / 10000, 10)
  const weak = new WordPredictor([{ word: "please", count: 1 }, { word: "unrelated", count: 1_000_000 }])
  expect(complete(weak, "pleae")).toBeUndefined()
})

test("allows supported partial edits without requiring a monopoly on candidates", () => {
  for (const [prefix, word] of [["outsx", "outside"], ["pleaas", "pleased"]]) {
    const predictor = new WordPredictor([{ word, count: 1 }])
    expect(complete(predictor, prefix)).toMatchObject({ word, suffix: word, replace: prefix.length })
  }
  const predictor = new WordPredictor([{ word: "pleased", count: 1 }, { word: "pleases", count: 1 }])
  expect(complete(predictor, "pleae")).toMatchObject({ word: "pleased", replace: 5 })
  const weak = new WordPredictor([{ word: "outside", count: 1 }, { word: "unrelated", count: 1_000_000 }])
  expect(complete(weak, "outsx")).toBeUndefined()
})

test("does not replace coding vocabulary, plurals, or inflections with nearby stems", () => {
  const predictor = new WordPredictor(frequencies)
  for (const word of [
    "plugin", "refactor", "refactors", "prompts", "predicts", "inserts", "replaces", "rewrites",
    "helpers", "folders", "buffers", "builders", "wrappers", "trackers", "bundler", "handlers",
    "routers", "matchers", "linters", "tester",
  ]) {
    expect(complete(predictor, word)).toBeUndefined()
  }
  for (const [prefix, bad] of [["arent", "aren"], ["doesnt", "doesn"], ["wasnt", "want"]]) {
    expect(complete(predictor, prefix)?.word).not.toBe(bad)
  }
  expect(complete(predictor, "pleaase")).toMatchObject({ word: "please", replace: 7 })
})

test("corrects missing apostrophes in learned contractions", () => {
  for (const [prefix, word] of [["dont", "don't"], ["cant", "can't"], ["wont", "won't"], ["ive", "i've"]]) {
    const model = new PersonalModel()
    model.observe([{ id: "1", text: word }, { id: "2", text: word }])
    const predictor = new WordPredictor([])
    predictor.setPersonal(model.snapshot())
    expect(complete(predictor, prefix)).toMatchObject({ word, suffix: word === "i've" ? "I've" : word, replace: prefix.length })
  }
})

test("capitalizes lowercase first-person contraction prefixes on acceptance", () => {
  for (const [prefix, word] of [["i'v", "i've"], ["i'l", "i'll"]]) {
    const model = new PersonalModel()
    model.observe([{ id: "1", text: word }, { id: "2", text: word }])
    const predictor = new WordPredictor([])
    predictor.setPersonal(model.snapshot())
    expect(complete(predictor, prefix)).toMatchObject({ word, suffix: `I${word.slice(1)}`, replace: prefix.length })
  }
})

test("capitalizes a single lowercase i before a learned contraction", () => {
  for (const word of ["i'm", "i'll", "i've", "i'd"]) {
    const model = new PersonalModel()
    model.observe([{ id: "1", text: `think ${word}` }, { id: "2", text: `think ${word}` }])
    const predictor = new WordPredictor([])
    predictor.setPersonal(model.snapshot())
    expect(complete(predictor, "think i")).toMatchObject({ word, suffix: `I${word.slice(1)}`, replace: 1 })
    expect(predictor.candidates({ before: "think ", prefix: "i", next: false }, 1)[0]).toEqual(complete(predictor, "think i"))
  }
})

test("does not repair technical context words into learned English continuations", () => {
  for (const [token, candidate] of [
    ["dir", "did"], ["res", "yes"], ["env", "end"], ["vim", "him"],
    ["api", "ape"], ["cli", "eli"], ["tui", "tub"], ["url", "curl"],
    ["init", "unit"], ["auth", "ruth"], ["json", "jason"], ["yaml", "yams"],
  ]) {
    const model = new PersonalModel()
    model.observe([{ id: "1", text: `${candidate} tests` }, { id: "2", text: `${candidate} tests` }])
    const predictor = new WordPredictor(frequencies)
    predictor.setPersonal(model.snapshot())
    expect(complete(predictor, `check ${token} `)).toBeUndefined()
  }
})

test("requires repeated continuation evidence before repairing context", () => {
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "please run tests" }])
  const predictor = new WordPredictor(frequencies)
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please rnu te")).toEqual(complete(predictor, "please abcdefghijklmnop te"))
  model.observe([{ id: "2", text: "please run tests" }])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please rnu te")?.suffix).toBe("sts")
  expect(complete(predictor, "please rnu te")).not.toEqual(complete(predictor, "please abcdefghijklmnop te"))
})

test("does not repair context when supported alternatives are ambiguous", () => {
  const model = new PersonalModel()
  model.observe(["abxcde", "abycde", "abzcde"].flatMap((word, index) => [
    { id: `${index}:1`, text: `${word} tests` }, { id: `${index}:2`, text: `${word} tests` },
  ]))
  const predictor = new WordPredictor([])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "check abcde ")).toBeUndefined()
})

test("capitalizes first-person contractions in corrections and next-word predictions", () => {
  for (const word of ["i'm", "i'll", "i've", "i'd"]) {
    const model = new PersonalModel()
    model.observe([{ id: "1", text: `please ${word} go` }, { id: "2", text: `please ${word} go` }])
    const predictor = new WordPredictor([{ word, count: 10 }])
    predictor.setPersonal(model.snapshot())
    expect(complete(predictor, "please ")?.suffix).toBe(`I${word.slice(1)}`)
  }
  const predictor = new WordPredictor([{ word: "i'm", count: 10 }])
  expect(complete(predictor, "i'mm")).toMatchObject({ word: "i'm", suffix: "I'm", replace: 4 })
})

test("predicts next words and disambiguates current words across a typo in left context", () => {
  const model = new PersonalModel()
  model.observe([
    { id: "1", text: "please run tests" }, { id: "2", text: "please run tests" },
    { id: "3", text: "please write text" }, { id: "4", text: "please write text" },
  ])
  const predictor = new WordPredictor([
    { word: "please", count: 100 },
    { word: "run", count: 100 },
    { word: "write", count: 100 },
    { word: "tests", count: 1 },
    { word: "text", count: 1 },
  ])
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "please rnu")).toMatchObject({ suffix: "run", word: "run", replace: 3 })
  expect(complete(predictor, "please rnu ")?.suffix).toBe("tests")
  expect(complete(predictor, "please rnu te")?.suffix).toBe("sts")
  expect(complete(predictor, "please wirte ")?.suffix).toBe("text")
})
test("restores supplementary Unicode contexts and rejects structurally invalid model keys", () => {
  const word = "𐐨".repeat(32)
  const model = new PersonalModel()
  model.observe([{ id: "unicode", text: `${word} ${word} ${word}` }])
  const snapshot = JSON.parse(JSON.stringify(model.snapshot()))
  const restored = new PersonalModel(snapshot)
  expect(restored.snapshot()).toEqual(snapshot)
  expect(restored.bigrams.get(`${word}\0${word}`)).toBe(2)
  expect(restored.trigrams.get(`${word}\0${word}\0${word}`)).toBe(1)
  const invalid = new PersonalModel({ ...snapshot, words: [[word + "𐐨", 1], ["invalid_key", 1]], bigrams: [["one", 1], ["a\0b\0c", 1]], trigrams: [["a\0b", 1], [`a\0b\0${word}𐐨`, 1]] })
  expect(invalid.words.size + invalid.bigrams.size + invalid.trigrams.size).toBe(0)
})

test("completes learned hyphenated words, brand names and filenames from real vocabulary", () => {
  const model = new PersonalModel()
  const texts = ["we need doc-drift checks", "fix doc-drift today", "I use OpenCode a lot", "try OpenCode again", "edit install.sh now", "run install.sh again", "the read-only flag", "make it read-only"]
  model.observe(texts.map((text, index) => ({ id: String(index), text })))
  const predictor = new WordPredictor(frequencies)
  predictor.setPersonal(model.snapshot())
  const complete = (text: string) => predictor.candidates(completionQuery(text, text.length)!, 1)[0]
  expect(complete("fix doc-")).toMatchObject({ suffix: "drift", word: "doc-drift" })
  expect(complete("fix doc")).toMatchObject({ word: "doc-drift" })
  expect(complete("we use Open")).toMatchObject({ suffix: "Code", word: "opencode" })
  expect(complete("please edit insta")).toMatchObject({ suffix: "ll.sh", word: "install.sh" })
  expect(complete("make it read-")).toMatchObject({ suffix: "only" })
})

test("a hyphenated or dotted learned word does not hide its shorter stem", () => {
  const model = new PersonalModel()
  model.observe(Array.from({ length: 4 }, (_, index) => ({ id: `a${index}`, text: "check zzdoc-drift and zzdoc.md" })))
  model.observe(Array.from({ length: 2 }, (_, index) => ({ id: `b${index}`, text: "alpha zzdoc beta" })))
  const predictor = new WordPredictor([])
  predictor.setPersonal(model.snapshot())
  expect(predictor.candidates(completionQuery("alpha ", 6)!, 1)[0]).toMatchObject({ word: "zzdoc" })
})

test("sentence starts are judged on masked text, so a leading slash command does not make a capital mid-sentence", () => {
  const forms = (text: string) => {
    const model = new PersonalModel()
    model.observe(Array.from({ length: 3 }, (_, index) => ({ id: `${text}${index}`, text })))
    return model.snapshot().forms
  }
  expect(forms("/btw Please ship it")).toEqual([])
  expect(forms("`code` Please ship it")).toEqual([])
  expect(forms("ship it Please")).toEqual([["Please", 3]])
  expect(forms("use `code` OpenCode here")).toEqual([["OpenCode", 3]])
  const model = new PersonalModel()
  model.observe(Array.from({ length: 3 }, (_, index) => ({ id: String(index), text: "/btw Please ship it" })))
  const predictor = new WordPredictor(frequencies)
  predictor.setPersonal(model.snapshot())
  expect(predictor.candidates(completionQuery("ship pl", 7)!, 1)[0]).toMatchObject({ suffix: "ease", word: "please" })
})

test("a trigram context whose continuations were each seen once does not discount the bigram", () => {
  const model = new PersonalModel()
  const prompts = (text: string, count: number, key: string) => Array.from({ length: count }, (_, index) => ({ id: `${key}${index}`, text }))
  model.observe([...prompts("my claude foo", 1, "a"), ...prompts("my claude bar", 1, "b"), ...prompts("claude code", 5, "c")])
  const predictor = new WordPredictor([])
  predictor.setPersonal(model.snapshot())
  const withPair = complete(predictor, "my claude ")
  const withoutPair = complete(predictor, "the claude ")
  expect(withoutPair).toMatchObject({ word: "code" })
  expect(withPair).toMatchObject({ word: "code" })
  expect(withPair!.confidence).toBeCloseTo(withoutPair!.confidence, 10)
  model.observe(prompts("my claude code", 2, "d"))
  predictor.setPersonal(model.snapshot())
  expect(complete(predictor, "my claude ")).toMatchObject({ word: "code" })
})

test("next-word queries score only words that follow the context", () => {
  const model = new PersonalModel()
  model.observe([
    ...Array.from({ length: 3 }, (_, index) => ({ id: `a${index}`, text: "please run tests" })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `b${index}`, text: "please run builds" })),
  ])
  const predictor = new WordPredictor(frequencies)
  predictor.setPersonal(model.snapshot())
  const spy = spyOn(predictor as unknown as { score: (word: string, context: readonly string[]) => number }, "score")
  const words = predictor.candidates(completionQuery("please run ", 11)!).map((candidate) => candidate.word)
  expect(words.sort()).toEqual(["builds", "tests"])
  expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
})

test("a continuation seen once after the exact pair keeps its trigram support", () => {
  const model = new PersonalModel()
  const prompts = (text: string, count: number, key: string) => Array.from({ length: count }, (_, index) => ({ id: `${key}${index}`, text }))
  model.observe([
    ...prompts("create a new", 1, "a"), ...prompts("create a file", 1, "b"),
    ...["new", "file", "test", "plan", "draft"].flatMap((word) => prompts(`a ${word}`, 2, word)),
  ])
  const predictor = new WordPredictor([])
  predictor.setPersonal(model.snapshot())
  expect(predictor.candidates(completionQuery("create a ", 9)!).map((candidate) => candidate.word).sort()).toEqual(["file", "new"])
  expect(predictor.candidates(completionQuery("make a ", 7)!)).toEqual([])
})

test("dropping only the learned casing keeps vocabulary and phrases", () => {
  const model = new PersonalModel()
  model.observe(Array.from({ length: 3 }, (_, index) => ({ id: String(index), text: "we like OpenCode a lot" })))
  const snapshot = model.snapshot()
  const predictor = new WordPredictor(frequencies)
  predictor.setPersonal(snapshot)
  expect(complete(predictor, "we like Ope")).toMatchObject({ suffix: "nCode" })
  predictor.setPersonal({ ...snapshot, forms: [] })
  expect(complete(predictor, "we like ope")).toMatchObject({ suffix: "ncode", word: "opencode" })
  expect(predictor.candidates(completionQuery("we like ", 8)!, 1)[0]).toMatchObject({ word: "opencode" })
})

test("replaces the word when its learned casing changes length under lowercasing", () => {
  const predictor = new WordPredictor([{ word: "is", count: 10 }])
  const model = new PersonalModel()
  model.observe(Array.from({ length: 6 }, (_, index) => ({ id: String(index), text: "we love İstanbul today" })))
  predictor.setPersonal(model.snapshot())
  const text = "we love İs"
  expect(predictor.candidates(completionQuery(text, text.length)!, 1)[0]).toMatchObject({ suffix: "İstanbul", replace: 2 })
})

test("shouted length-changing casing replaces the whole word in capitals", () => {
  const predictor = new WordPredictor([{ word: "is", count: 10 }])
  const model = new PersonalModel()
  model.observe(Array.from({ length: 6 }, (_, index) => ({ id: String(index), text: "we love İstanbul today" })))
  predictor.setPersonal(model.snapshot())
  const text = "we love İS"
  expect(predictor.candidates(completionQuery(text, text.length)!, 1)[0]).toMatchObject({ suffix: "İSTANBUL", replace: 2 })
})
