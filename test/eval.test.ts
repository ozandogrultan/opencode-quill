import { test, expect } from "bun:test"
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
      expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual({ prose: [{ id: "p", text: "synthetic prompt" }], shell: [] })
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
  expect(result).toMatchObject({ endPositions: 2, endShown: 1, endHarmless: 0, endWrong: 1 })
  expect(metrics("deploy locally", "deploy locally")).toMatchObject({ endShown: 0, endHarmless: 0, endWrong: 0 })
})
