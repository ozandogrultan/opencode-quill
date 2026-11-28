import { test, expect } from "bun:test"
import { bootstrapReport, pairedBootstrap, type PerPrompt } from "../scripts/bootstrap"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

function run(...args: string[]) {
  return Bun.spawnSync([process.execPath, join(root, "scripts/eval.ts"), ...args], { cwd: root })
}

function withTemp<T>(check: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "quill-eval-"))
  try {
    return check(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("freezes synthetic history only in new owner-only files outside the real repository", () => {
  withTemp((directory) => {
    const inside = mkdtempSync(join(root, "..quill-eval-"))
    try {
      const dbPath = join(directory, "history.db")
      const db = new Database(dbPath)
      try {
        db.exec(`
          CREATE TABLE session_v2 (id, parent_id);
          CREATE TABLE session_message (id, session_id, type, time_created, data);
          INSERT INTO session_v2 VALUES ('s', NULL);
          INSERT INTO session_message VALUES ('p', 's', 'user', 1, '{"text":"synthetic prompt"}');
        `)
      } finally {
        db.close()
      }
      const freeze = (path: string) => run("--db", dbPath, "--freeze", path)

      const destination = join(directory, "benchmarks", "history.json")
      expect(freeze(destination).exitCode).toBe(0)
      expect(statSync(destination).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ prose: [{ id: "p", text: "synthetic prompt", session: "s", time: 1 }], shell: [] })
      writeFileSync(destination, "existing benchmark")
      expect(freeze(destination).exitCode).not.toBe(0)
      expect(readFileSync(destination, "utf8")).toBe("existing benchmark")

      symlinkSync(destination, join(directory, "file-link"))
      expect(freeze(join(directory, "file-link")).exitCode).not.toBe(0)
      expect(readFileSync(destination, "utf8")).toBe("existing benchmark")

      expect(freeze(join(inside, "direct.json")).stderr.toString()).toContain("outside the repository")
      symlinkSync(inside, join(directory, "in"))
      expect(freeze(join(directory, "in", "nested", "linked.json")).stderr.toString()).toContain("outside the repository")
      expect(existsSync(join(inside, "nested"))).toBe(false)
      expect(freeze(`${directory}/in/../linked.json`).stderr.toString()).toContain("outside the repository")

      symlinkSync(directory, join(inside, "out"))
      expect(freeze(join(inside, "out", "outbound.json")).exitCode).toBe(0)
      expect(existsSync(join(directory, "outbound.json"))).toBe(true)
    } finally {
      rmSync(inside, { recursive: true, force: true })
    }
  })
})

function metrics(training: string | string[], ...targets: string[]) {
  const train = typeof training === "string" ? Array<string>(targets.length * 4).fill(training) : training
  const prompts = [...train, ...targets].map((text, id) => ({ id: String(id), text }))
  return withTemp((directory) => {
    const path = join(directory, "prompts.json")
    writeFileSync(path, JSON.stringify(prompts))
    const execution = run("--prompts", path, "--json")
    expect(execution.stderr.toString()).toBe("")
    expect(execution.exitCode).toBe(0)
    return JSON.parse(execution.stdout.toString()).prose
  })
}

test("scores case and apostrophes as typed and carries next-word ghost text into the prefix", () => {
  expect(metrics("say I’m", "say I'm", "say I’m", "say i'm")).toMatchObject({
    nextShown: 3,
    nextTop1: 1,
    nextWrong: 2,
    nextSaved: 2,
    bigramMissed: 2,
    bigramMissedNoSuggestion: 0,
    bigramMissedWrongList: 2,
    wordsTop1: 4,
    wordsTop5: 4,
    prefixSaved: 1,
    wrongByPrefix: { "1": 2, "2": 2 },
  })
})

test("counts known-bigram misses when no automatic candidate is shown", () => {
  const training = ["tests", "builds", "checks", "scripts"].flatMap((word) => [`run ${word}`, `run ${word}`])
  expect(metrics(training, "run tests", "hello")).toMatchObject({
    nextPositions: 1,
    nextShown: 0,
    bigramKnown: 1,
    bigramMissed: 1,
    bigramMissedNoSuggestion: 1,
    bigramMissedWrongList: 0,
  })
})

test("uses raw code-point lengths and complete UTF-16 prefixes", () => {
  expect(metrics("try 𐐨aaa", "try 𐐨aaa")).toMatchObject({ positions: 5, prefixSaved: 2, nextSaved: 3 })
  const decomposed = "type cafe\u0301like"
  expect(metrics(decomposed, decomposed)).toMatchObject({ positions: 11, wordChars: 13, prefixSaved: 4, nextWrong: 1 })
  expect(metrics("say İnan", "İnan")).toMatchObject({
    positions: 3, wordChars: 4, wrongShown: 0, wordsTop1: 1, wordsTop5: 1, prefixSaved: 2,
  })
})

test("alternative replay charges for cycling and accepting", () => {
  withTemp((directory) => {
    const path = join(directory, "prompts.json")
    const prompts = ["run testing", "run testing", "run tracking", "run tracking", "run tracking"]
    writeFileSync(path, JSON.stringify(prompts.map((text, id) => ({ text, id: String(id) }))))
    const execution = run("--prompts", path, "--alternatives", "--json")
    expect(execution.exitCode).toBe(0)
    expect(JSON.parse(execution.stdout.toString()).prose.alternatives).toEqual({
      wordsTop3: 2, wordsTop3WithSummon: 2, automaticSaved: 5, cycleSaved: 6,
      netSaved: 6, cyclePresses: 1, summonPresses: 0, acceptPresses: 1,
    })
  })
})

test("scores the complete-word position separately from prefix positions", () => {
  const result = metrics("deploy locally", "deploy local")
  expect(result).toMatchObject({ endPositions: 2, endShown: 1, endHarmless: 0, endWrong: 1, endWrongKinds: { longer: 1, apostrophe: 0, replacement: 0 }, endReplaceChanging: 0 })
  expect(metrics("deploy locally", "deploy locally")).toMatchObject({ endShown: 0, endHarmless: 0, endWrong: 0 })
})

test("classifies a restored apostrophe at a completed word as a prefix-changing replacement", () => {
  const result = metrics("we can't", "we cant")
  expect(result).toMatchObject({ endShown: 1, endWrong: 1, endWrongKinds: { longer: 0, apostrophe: 1, replacement: 0 }, endReplaceChanging: 1 })
})

test("prints replacement counters only on request", () => {
  withTemp((directory) => {
    const path = join(directory, "prompts.json")
    writeFileSync(path, JSON.stringify(["we can't", "we can't", "we can't", "we cant"].map((text, id) => ({ id: String(id), text }))))
    expect(run("--prompts", path).stdout.toString()).not.toContain("wrong replacements")
    expect(run("--prompts", path, "--replacements").stdout.toString()).toMatch(/wrong replacements at word end\s+1 changing the prefix/)
  })
})

test("probes use only synthetic text and need no history", () => {
  const execution = run("--probes", "--json", "--db", "/nonexistent/history.db")
  expect(execution.stderr.toString()).toBe("")
  expect(execution.exitCode).toBe(0)
  const probes = JSON.parse(execution.stdout.toString())
  expect(Object.keys(probes.typos)).toEqual(["swap", "missing", "doubled", "extra", "wrong"])
  for (const outcome of Object.values<any>(probes.typos)) {
    expect(outcome.total).toBeGreaterThan(50)
    expect(outcome.replaced + outcome.appended).toBeLessThanOrEqual(outcome.total)
  }
  expect(probes.typos.swap.replaced).toBeGreaterThan(probes.typos.extra.replaced)
  expect(probes.apostrophes).toEqual({ total: 8, cold: 0, learned: 7 })
  expect(probes.technicalTranspositions).toEqual({ total: 4, cold: 0, learned: 4 })
  expect(run("--probes", "--db", "/nonexistent/history.db").stdout.toString()).toContain("missing apostrophe, cold / learned  0 / 7 of 8")
})

test("frozen prompts keep session and time and load without them", () => {
  withTemp((directory) => {
    const frozen = join(directory, "frozen.json")
    writeFileSync(frozen, JSON.stringify({ prose: [1, 2, 3, 4, 5].map((time) => ({ id: String(time), text: "run tests", session: "s", time })), shell: [] }))
    const timed = run("--prompts", frozen, "--json")
    expect(timed.exitCode).toBe(0)
    expect(JSON.parse(timed.stdout.toString()).prose).toMatchObject({ train: 4, test: 1 })
    const legacy = join(directory, "legacy.json")
    writeFileSync(legacy, JSON.stringify([1, 2, 3, 4, 5].map((id) => ({ id: String(id), text: "run tests" }))))
    const old = run("--prompts", legacy, "--json")
    expect(old.exitCode).toBe(0)
    expect(JSON.parse(old.stdout.toString()).prose).toMatchObject({ train: 4, test: 1 })
  })
})

test("online replay learns each test prompt after scoring it", () => {
  const prompts = [...Array<string>(12).fill("filler words here"), ...Array<string>(4).fill("zebra crossing ahead")]
  const replay = (...extra: string[]) => withTemp((directory) => {
    const path = join(directory, "prompts.json")
    writeFileSync(path, JSON.stringify(prompts.map((text, id) => ({ id: String(id), text }))))
    const execution = run("--prompts", path, "--json", ...extra)
    expect(execution.exitCode).toBe(0)
    return JSON.parse(execution.stdout.toString()).prose
  })
  const offline = replay()
  const online = replay("--online")
  expect(offline.test).toBe(4)
expect(online.rows[0]).toEqual(offline.rows[0])
  expect(online.prefixSaved).toBeGreaterThan(offline.prefixSaved)
  expect(online.nextSaved).toBeGreaterThan(offline.nextSaved)
  expect(online.wrongShown).toBeLessThan(offline.wrongShown)
})

test("per-prompt output holds numbers only and stays outside the repository", () => {
  withTemp((directory) => {
    const path = join(directory, "prompts.json")
    writeFileSync(path, JSON.stringify(["secretword alpha", "secretword alpha", "secretword alpha", "secretword alpha", "secretword alpha"].map((text, id) => ({ id: String(id), text }))))
    const output = join(directory, "nested", "per.json")
    expect(run("--prompts", path, "--per-prompt", output, "--alternatives").exitCode).toBe(0)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    const contents = readFileSync(output, "utf8")
    expect(contents).not.toContain("secretword")
    const parsed = JSON.parse(contents)
    expect(parsed.prose).toHaveLength(1)
    expect(parsed.prose.flat().every((count: unknown) => typeof count === "number")).toBe(true)
    expect(run("--prompts", path, "--per-prompt", join(root, "per.json")).stderr.toString()).toContain("outside the repository")
    expect(existsSync(join(root, "per.json"))).toBe(false)
  })
})

test("paired bootstrap excludes zero for a clear shift and includes it for none", () => {
  const noise = Array.from({ length: 200 }, (_, index) => (index % 3) - 1)
  const shifted = pairedBootstrap(noise.map((value) => value + 2))
  expect(shifted.excludesZero).toBe(true)
  expect(shifted.low).toBeGreaterThan(0)
  const flat = pairedBootstrap(noise)
  expect(flat.excludesZero).toBe(false)
  expect(pairedBootstrap(noise)).toEqual(flat)
})

test("paired bootstrap rejects files that are not comparable and reports skipped alternatives", () => {
  const file = (over: Partial<PerPrompt> = {}): PerPrompt => ({
    metrics: ["prefixSaved", "words"], split: "val", online: false, alternatives: false,
    prose: [[1, 3], [2, 4], [0, 5]], ...over,
  })
  expect(bootstrapReport(file(), file())).toContain("chars saved, prefix")
  expect(bootstrapReport(file(), file({ prose: [[2, 3], [3, 4], [1, 5]] }), 50)).toContain("better")
  expect(() => bootstrapReport(file(), file({ prose: [[1, 3]] }))).toThrow("different numbers")
  expect(() => bootstrapReport(file(), file({ split: "test" }))).toThrow("different splits")
  expect(() => bootstrapReport(file(), file({ online: true }))).toThrow("--online")
  expect(() => bootstrapReport(file(), file({ prose: [[1, 3], [2, 5], [0, 5]] }))).toThrow("different prompts")
  expect(() => bootstrapReport(file(), file({ metrics: ["prefixSaved", "wordsTop1"] }))).toThrow("words column")
  expect(bootstrapReport(file({ alternatives: true }), file())).toContain("net saved, alternatives skipped")
})

test("frozen prompts are sorted by time only when every prompt has one", () => {
  const rows = [{ id: "a", text: "unique zebra crossing" }, ...["b", "c", "d", "e"].map((id) => ({ id, text: "run tests" }))]
  const testWords = (times: (number | undefined)[]) => withTemp((directory) => {
    const path = join(directory, "frozen.json")
    writeFileSync(path, JSON.stringify({ prose: rows.map((row, i) => ({ ...row, time: times[i] })), shell: [] }))
    const execution = run("--prompts", path, "--json")
    expect(execution.exitCode).toBe(0)
    return JSON.parse(execution.stdout.toString()).prose.words
  })
  expect(testWords([5, 1, 2, 3, 4])).toBe(3)
  expect(testWords([1, 2, 3, 4, 5])).toBe(2)
  expect(testWords([1, 1, 1, 1, 1])).toBe(2)
  expect(testWords([5, 1, 2, 3, undefined])).toBe(2)
})

test("json output records the replay mode", () => {
  withTemp((directory) => {
    const path = join(directory, "prompts.json")
    writeFileSync(path, JSON.stringify([1, 2, 3, 4, 5].map((id) => ({ id: String(id), text: "run tests" }))))
    const json = (...extra: string[]) => JSON.parse(run("--prompts", path, "--json", ...extra).stdout.toString())
    expect(json()).toMatchObject({ online: false, alternatives: false })
    expect(json("--online", "--alternatives")).toMatchObject({ online: true, alternatives: true })
  })
})
