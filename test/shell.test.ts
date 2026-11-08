import { afterEach, expect, test } from "bun:test"
import { BoxRenderable, RGBA, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ComposerGhost, type Composer } from "../src/ghost"
import { PersonalModel, WordPredictor } from "../src/predictor"
import { completionQuery } from "../src/prose"
import { maskShell, shellGrammar, shellWords } from "../src/shell"
import { parseQuillCommand, resolveOptions } from "../src/options"

const words = (text: string) => shellWords(text).map((word) => word.text)
const query = (text: string) => completionQuery(text, text.length, [], false, shellGrammar)

function trained(commands: string[], times = 3) {
  const model = new PersonalModel(undefined, shellGrammar)
  model.observe(commands.flatMap((text, row) => Array.from({ length: times }, (_, index) => ({ id: `${row}:${index}`, text }))))
  const predictor = new WordPredictor([], shellGrammar)
  predictor.setPersonal(model.snapshot())
  return { model, predictor }
}

test("shell words keep commands, subcommands and flags and drop paths, assignments, quotes and substitutions", () => {
  expect(words("git commit -m 'fix things' --amend")).toEqual(["git", "commit", "-m", "--amend"])
  expect(words("bun run test:unit && rtk gain")).toEqual(["bun", "run", "test:unit", "rtk", "gain"])
  expect(words("cd ~/Documents/x ; ls -la ./src")).toEqual(["cd", "ls", "-la"])
  expect(words("FOO=bar make build $(date) ${HOME} $PATH")).toEqual(["make", "build"])
  expect(words("echo \"unterminated quote")).toEqual(["echo"])
  expect(words("cat a/b | grep -v foo.txt > out.log")).toEqual(["cat", "grep", "-v", "foo.txt", "out.log"])
  expect(maskShell("git status").length).toBe("git status".length)
})

test("commands that look like they carry secrets are never learned or completed", () => {
  for (const command of ["curl -H 'Authorization: x' api", "export API_KEY foo", "gh auth token", "npm login --password hunter2", "echo sk-abc",
    "mysql -uroot -pHunter2 db", "curl -u admin:hunter2 host", "curl --user=admin:hunter2 host", "export AWS_ACCESS_KEY_ID foo",
    "echo sk_live_abc", "git clone ghp_abcdef", "echo github_pat_abc", "echo glpat-abc", "slack xoxb-123", "echo eyJhbGciOiJIUzI1NiJ9",
    "aws AKIAABCDEFGHIJKLMNOP", "curl -b cookie.txt host", "env DB_PWD=x run"]) {
    expect(words(command)).toEqual([])
    expect(query(command + " ")).toBeUndefined()
  }
  expect(words("deploy a1b2c3d4e5f6a7b8c9d0")).toEqual(["deploy"])
  expect(words("cd ~ && pwd")).toEqual(["cd", "pwd"])
  expect(words("find . -print")).toEqual(["find", "-print"])
  expect(words("git push -u origin main")).toEqual(["git", "push", "-u", "origin", "main"])
})

test("shell queries find the flag or word being typed and the next word", () => {
  expect(query("git sta")).toMatchObject({ before: "git ", prefix: "sta", next: false })
  expect(query("git ")).toMatchObject({ prefix: "", next: true })
  expect(query("bun install --fro")).toMatchObject({ prefix: "--fro" })
  expect(query("bun install --")).toMatchObject({ prefix: "--" })
  expect(query("ls | gr")).toMatchObject({ before: "ls | ", prefix: "gr" })
  expect(query("cd ~/Doc")).toBeUndefined()
  expect(query("FOO=ba")).toBeUndefined()
  expect(query("cat a/b")).toBeUndefined()
  expect(query("echo $HO")).toBeUndefined()
  expect(query("echo 'sta")).toBeUndefined()
})

test("completes learned commands, subcommands and flags with their original case", () => {
  const { predictor } = trained(["git status", "git status --short", "bun install --frozen-lockfile", "Makefile build"])
  expect(predictor.candidates(query("git sta")!, 1)[0]).toMatchObject({ suffix: "tus", word: "status" })
  expect(predictor.candidates(query("git ")!, 1)[0]).toMatchObject({ suffix: "status" })
  expect(predictor.candidates(query("bun install --fro")!, 1)[0]).toMatchObject({ suffix: "zen-lockfile" })
  expect(predictor.candidates(query("bun install --")!, 1)[0]).toMatchObject({ suffix: "frozen-lockfile" })
  expect(predictor.candidates(query("Make")!, 1)[0]).toMatchObject({ suffix: "file" })
  expect(predictor.candidates(query("make")!, 1)[0]).toBeUndefined()
})

test("shell completion never uppercases, capitalizes or corrects typos", () => {
  const { predictor } = trained(["git status --short", "i install"])
  expect(predictor.candidates(query("i ")!, 1)[0]).toMatchObject({ suffix: "install" })
  expect(predictor.candidates(query("git status --SH")!, 1)[0]).toBeUndefined()
  expect(predictor.candidates(query("git statsu")!, 1)[0]).toBeUndefined()
  expect(predictor.candidates(query("git stat")!, 1)[0]?.suffix).toBe("us")
})

test("shell and prose models keep separate vocabularies and snapshots", () => {
  const { model } = trained(["git status"])
  expect(model.snapshot().words.map(([word]) => word).sort()).toEqual(["git", "status"])
  const prose = new PersonalModel()
  prose.observe([{ id: "x", text: "git status --short" }])
  expect(prose.snapshot().words.map(([word]) => word)).not.toContain("--short")
  const restored = new PersonalModel(model.snapshot())
  expect(restored.words.size).toBe(2)
  expect(new PersonalModel(model.snapshot(), shellGrammar).words.size).toBe(2)
})

test("shell options and commands", () => {
  expect(resolveOptions({}).completeShell).toBe(true)
  expect(resolveOptions({ completeShell: false }).completeShell).toBe(false)
  expect(() => resolveOptions({ completeShell: "no" })).toThrow("Quill completeShell must be a boolean")
  expect(parseQuillCommand("shell on")).toEqual({ type: "shell", value: true })
  expect(parseQuillCommand(" Shell OFF ")).toEqual({ type: "shell", value: false })
  expect(parseQuillCommand("shell")).toEqual({ type: "invalid" })
})

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

async function composer(text: string, shell: boolean) {
  const testing = await createTestRenderer({ width: 60, height: 8 })
  cleanups.push(() => testing.renderer.destroy())
  const parent = new BoxRenderable(testing.renderer, { id: "composer", width: 60, height: 4, paddingLeft: 2, paddingTop: 1 })
  const editor = new TextareaRenderable(testing.renderer, { id: "input", width: "100%", height: 2, wrapMode: "word" })
  parent.add(editor)
  testing.renderer.root.add(parent)
  editor.setText(text)
  editor.gotoBufferEnd()
  editor.focus()
  const view: Composer = { editor, normal: true, focused: editor, mode: "base", shell, selected: false, enabled: true }
  const prose = new WordPredictor([{ word: "stable", count: 10 }])
  const { predictor } = trained(["git status"])
  const ghost = new ComposerGhost(editor, prose, () => view, () => RGBA.fromHex("#888888"), testing.renderer, false, predictor)
  cleanups.push(() => ghost.dispose())
  await testing.renderOnce()
  return { ...testing, editor, ghost, view }
}

test("the composer ghost uses the shell model in shell mode and accepts into the command", async () => {
  const fixture = await composer("git sta", true)
  expect(fixture.captureCharFrame()).toContain("git status")
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("git status")
})

test("the prose model is used outside shell mode and the shell model is never mixed in", async () => {
  const fixture = await composer("git sta", false)
  expect(fixture.captureCharFrame()).toContain("git stable")
  expect(fixture.captureCharFrame()).not.toContain("status")
})

test("switching mode invalidates a visible suggestion", async () => {
  const fixture = await composer("git sta", true)
  expect(fixture.ghost.visible()).toBe(true)
  fixture.view.shell = false
  expect(fixture.ghost.visible()).toBe(false)
  await fixture.renderOnce()
  expect(fixture.captureCharFrame()).toContain("git stable")
})
