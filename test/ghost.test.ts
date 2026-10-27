import { afterEach, expect, spyOn, test } from "bun:test"
import { BoxRenderable, InputRenderable, RGBA, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { ComposerGhost, dimGhostColor, eligibleComposer, findComposer, type Composer } from "../src/ghost"
import { PersonalModel, WordPredictor } from "../src/predictor"
import { proseGrammar } from "../src/prose"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

async function setup(text = "please comp", width = 60, completeAtLineEnd = false) {
  const testing = await createTestRenderer({ width, height: 8 })
  cleanups.push(() => testing.renderer.destroy())
  const parent = new BoxRenderable(testing.renderer, { id: "composer", width, height: 4, paddingLeft: 2, paddingTop: 1 })
  const editor = new TextareaRenderable(testing.renderer, { id: "input", width: "100%", height: 2, wrapMode: "word" })
  parent.add(editor)
  testing.renderer.root.add(parent)
  editor.setText(text)
  editor.gotoBufferEnd()
  editor.focus()
  const view: Composer = { editor, normal: true, focused: editor, mode: "base", selected: false, enabled: true }
  const predictor = new WordPredictor([{ word: "complete", count: 10 }, { word: "réviser", count: 10 }])
  const ghost = new ComposerGhost(editor, predictor, () => view, () => RGBA.fromHex("#888888"), testing.renderer, completeAtLineEnd)
  cleanups.push(() => ghost.dispose())
  await testing.renderOnce()
  return { ...testing, editor, ghost, view, predictor }
}

test("paints ghost text at the real cursor without changing the draft", async () => {
  const fixture = await setup()
  expect(fixture.captureCharFrame()).toContain("please complete")
  expect(fixture.editor.plainText).toBe("please comp")
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please complete")
})

test("discovers only an unambiguous live composer with clipboard capability", async () => {
  const fixture = await setup()
  const parent = fixture.editor.parent!
  const footer = new BoxRenderable(fixture.renderer, { id: "footer" })
  const marker = new BoxRenderable(fixture.renderer, { id: "marker" })
  footer.add(marker)
  parent.add(footer)
  const isEditor = (node: import("@opentui/core").Renderable): node is TextareaRenderable => node instanceof TextareaRenderable && !(node instanceof InputRenderable)
  expect(findComposer(marker, isEditor)).toBeUndefined()
  Object.defineProperty(fixture.editor, "getClipboardText", { value: () => "", configurable: true })
  expect(findComposer(marker, isEditor)).toBe(fixture.editor)
  const search = new InputRenderable(fixture.renderer, { id: "search" })
  parent.add(search)
  expect(findComposer(marker, isEditor)).toBe(fixture.editor)
  const other = new TextareaRenderable(fixture.renderer, { id: "other" })
  parent.add(other)
  expect(findComposer(marker, isEditor)).toBeUndefined()
  other.destroy()
  expect(findComposer(marker, isEditor)).toBe(fixture.editor)
  Object.defineProperty(fixture.editor, "getClipboardText", { value: undefined, configurable: true })
  expect(findComposer(marker, isEditor)).toBeUndefined()
  Object.defineProperty(fixture.editor, "getClipboardText", { value: () => "", configurable: true })
  expect(findComposer(marker, isEditor)).toBe(fixture.editor)
  fixture.editor.destroy()
  expect(findComposer(marker, isEditor)).toBeUndefined()
  marker.destroy()
  expect(findComposer(marker, isEditor)).toBeUndefined()
  expect(findComposer(undefined, isEditor)).toBeUndefined()
})

test.each(["please comp", "😊 漢字 comp", "please re\u0301"])("opt-in logical-line-end insertion preserves trailing lines, callbacks and single-step undo: %s", async (line) => {
  const text = `${line}\nkeep this line\n[Image 1]`
  const fixture = await setup(text, 60, true)
  fixture.editor.cursorOffset = fixture.editor.editBuffer.measureText(line)
  const start = fixture.editor.editBuffer.measureText(`${line}\nkeep this line\n`)
  const metadata = { attachment: "synthetic-image" }
  const mark = fixture.editor.extmarks.create({ start, end: start + 9, virtual: true, metadata })
  const original = fixture.editor.extmarks.getAll().map((mark) => ({ ...mark }))
  let changed = 0
  let submitted = 0
  const onContentChange = () => { changed++ }
  const onSubmit = () => { submitted++ }
  fixture.editor.onContentChange = onContentChange
  fixture.editor.onSubmit = onSubmit
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.editor.plainText).toBe(text)
  expect(fixture.ghost.accept()).toBe(true)
  const suffix = line.endsWith("comp") ? "lete" : "viser"
  expect(fixture.editor.plainText).toBe(`${line}${suffix}\nkeep this line\n[Image 1]`)
  expect(fixture.editor.editBuffer.getTextRange(0, fixture.editor.cursorOffset)).toBe(line + suffix)
  await fixture.renderOnce()
  expect(changed).toBeGreaterThan(0)
  expect(submitted).toBe(0)
  expect(fixture.editor.onContentChange).toBe(onContentChange)
  expect(fixture.editor.onSubmit).toBe(onSubmit)
  expect(fixture.editor.extmarks.getMetadataFor(mark)).toEqual(metadata)
  expect(fixture.editor.extmarks.getAll()).toEqual(original.map((mark) => ({ ...mark, start: mark.start + suffix.length, end: mark.end + suffix.length })))
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe(text)
  expect(fixture.editor.extmarks.getAll()).toEqual(original)
  expect(fixture.editor.redo()).toBe(true)
  expect(fixture.editor.plainText).toBe(`${line}${suffix}\nkeep this line\n[Image 1]`)
  expect(fixture.editor.extmarks.getMetadataFor(mark)).toEqual(metadata)
})

test("line-end completion is disabled by default and never appears at a visual wrap or inside code", async () => {
  const fixture = await setup("please comp\nlater")
  fixture.editor.cursorOffset = 11
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  const enabled = await setup("please comp later words", 17, true)
  enabled.editor.cursorOffset = 11
  await enabled.renderOnce()
  expect(enabled.ghost.visible()).toBe(false)
  for (const text of ["```\nplease comp\n```", "please `comp\nlater`", "please comp\n\nlater"]) {
    enabled.editor.setText(text)
    enabled.editor.cursorOffset = text.startsWith("please comp\n\n") ? 12 : enabled.editor.editBuffer.measureText(text.slice(0, text.indexOf("comp") + 4))
    await enabled.renderOnce()
    expect(enabled.ghost.visible()).toBe(false)
    expect(enabled.ghost.accept()).toBe(false)
  }
})

test("line-end suggestions never replace words, including casing corrections", async () => {
  const fixture = await setup("please cmplete\nlater", 60, true)
  fixture.editor.cursorOffset = 14
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  const model = new PersonalModel()
  model.observe([{ id: "a", text: "ask Ozan today" }, { id: "b", text: "ask Ozan today" }])
  fixture.predictor.setPersonal(model.snapshot())
  fixture.editor.setText("ask oz\nlater")
  fixture.editor.cursorOffset = 6
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  fixture.editor.setText("ask Oz\nlater")
  fixture.editor.cursorOffset = 6
  await fixture.renderOnce()
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("ask Ozan\nlater")
})

test("line-local cycling resets on cursor changes and incremental typing preserves the trailing draft", async () => {
  const fixture = await setup("please comp\nplease comp", 60, true)
  const model = new PersonalModel()
  model.observe(Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: index < 6 ? "please complete" : "please compare" })))
  fixture.predictor.setPersonal(model.snapshot())
  fixture.editor.cursorOffset = 11
  await fixture.renderOnce()
  expect(fixture.ghost.cycle(1)).toBe(true)
  await fixture.renderOnce()
  expect(fixture.captureCharFrame()).toContain("please compare")
  fixture.editor.gotoBufferEnd()
  expect(fixture.ghost.accept()).toBe(false)
  await fixture.renderOnce()
  expect(fixture.captureCharFrame()).toContain("please complete")
  fixture.editor.cursorOffset = 11
  await fixture.renderOnce()
  fixture.editor.insertText("l")
  expect(fixture.ghost.accept()).toBe(false)
  await fixture.renderOnce()
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please complete\nplease comp")
})

test("line-end next-word acceptance leaves subsequent lines untouched", async () => {
  const fixture = await setup("please run \nlater", 60, true)
  const model = new PersonalModel()
  model.observe([{ id: "a", text: "please run tests" }, { id: "b", text: "please run tests" }])
  fixture.predictor.setPersonal(model.snapshot())
  fixture.editor.cursorOffset = 11
  await fixture.renderOnce()
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please run tests\nlater")
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe("please run \nlater")
})

test("line-end dismissal does not suppress suggestions at a different logical line end", async () => {
  const fixture = await setup("please comp\nplease comp", 60, true)
  fixture.editor.cursorOffset = 11
  await fixture.renderOnce()
  expect(fixture.ghost.dismiss()).toBe(true)
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  fixture.editor.gotoBufferEnd()
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(true)
})

test.each([13, 14, 16])("line-end ghost never overwrites the next logical line when width is %s", async (width) => {
  const fixture = await setup("please comp\nright", width, true)
  fixture.editor.cursorOffset = 11
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  expect(fixture.captureCharFrame()).toContain("right")
})

test("cycles confident alternatives without editing, wraps, and accepts with native undo", async () => {
  const fixture = await setup()
  const model = new PersonalModel()
  model.observe(Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: index < 6 ? "please complete" : "please compare" })))
  fixture.predictor.setPersonal(model.snapshot())
  await fixture.renderOnce()
  expect(fixture.ghost.cycle(1)).toBe(true)
  expect(fixture.editor.plainText).toBe("please comp")
  await fixture.renderOnce()
  expect(fixture.captureCharFrame()).toContain("please compare")
  expect(fixture.ghost.cycle(1)).toBe(true)
  await fixture.renderOnce()
  expect(fixture.captureCharFrame()).toContain("please complete")
  expect(fixture.ghost.cycle(-1)).toBe(true)
  await fixture.renderOnce()
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please compare")
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe("please comp")
  expect(fixture.editor.redo()).toBe(true)
  expect(fixture.editor.plainText).toBe("please compare")
})

test("cycling falls through for a single candidate and invalidates on model or extmark changes", async () => {
  const fixture = await setup()
  expect(fixture.ghost.cycle(1)).toBe(false)
  fixture.predictor.setPersonal(new PersonalModel().snapshot())
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  await fixture.renderOnce()
  fixture.editor.extmarks.create({ start: 0, end: 2 })
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.cycle(1)).toBe(false)
})

test.each(["text", "cursor", "extmark", "model"])("cycling resets to the best candidate after %s changes", async (change) => {
  const fixture = await setup()
  const model = new PersonalModel()
  model.observe(Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: index < 6 ? "please complete" : "please compare" })))
  fixture.predictor.setPersonal(model.snapshot())
  await fixture.renderOnce()
  expect(fixture.ghost.cycle(1)).toBe(true)
  await fixture.renderOnce()
  expect(fixture.captureCharFrame()).toContain("please compare")
  if (change === "text") fixture.editor.insertText("l")
  if (change === "cursor") fixture.editor.moveCursorLeft()
  if (change === "extmark") fixture.editor.extmarks.create({ start: 0, end: 2 })
  if (change === "model") fixture.predictor.setPersonal(model.snapshot())
  expect(fixture.ghost.cycle(1)).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  await fixture.renderOnce()
  if (change === "cursor") {
    fixture.editor.gotoBufferEnd()
    await fixture.renderOnce()
  }
  expect(fixture.captureCharFrame()).toContain("please complete")
})

test("unchanged redraws reuse ranked candidates and a changed model refreshes them", async () => {
  const fixture = await setup()
  const candidates = spyOn(fixture.predictor, "candidates")
  fixture.ghost.invalidate()
  for (let frame = 0; frame < 20; frame++) await fixture.renderOnce()
  expect(candidates).toHaveBeenCalledTimes(1)
  fixture.predictor.setPersonal(new PersonalModel().snapshot())
  await fixture.renderOnce()
  expect(candidates).toHaveBeenCalledTimes(2)
})

test("cycling does not hide the current ghost behind an alternative that cannot fit", async () => {
  const fixture = await setup("please comp", 17)
  const model = new PersonalModel()
  model.observe(Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: index < 6 ? "please complete" : "please complicated" })))
  fixture.predictor.setPersonal(model.snapshot())
  await fixture.renderOnce()
  expect(fixture.ghost.cycle(1)).toBe(false)
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please complete")
})

test("screen clipping and resize before repaint invalidate visible acceptance", async () => {
  const fixture = await setup()
  fixture.resize(12, 8)
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.dismiss()).toBe(false)
  expect(fixture.editor.plainText).toBe("please comp")
})

test.each(["😊", "漢字", "e\u0301"])("Unicode attachment offsets and metadata survive insertion: %s", async (prefix) => {
  const fixture = await setup(`${prefix} [Image 1] please comp`)
  const start = fixture.editor.editBuffer.measureText(`${prefix} `)
  const metadata = { attachment: "synthetic-image", source: { type: "image" } }
  const mark = fixture.editor.extmarks.create({ start, end: start + 9, virtual: true, metadata, data: { label: "Image 1" } })
  const marks = fixture.editor.extmarks.getAll()
  await fixture.renderOnce()
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe(`${prefix} [Image 1] please complete`)
  expect(fixture.editor.extmarks.getAll()).toEqual(marks)
  expect(fixture.editor.extmarks.getMetadataFor(mark)).toEqual(metadata)
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe(`${prefix} [Image 1] please comp`)
  expect(fixture.editor.extmarks.getAll()).toEqual(marks)
  expect(fixture.editor.redo()).toBe(true)
  expect(fixture.editor.extmarks.getMetadataFor(mark)).toEqual(metadata)
  fixture.editor.cursorOffset = start + 2
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
})

test("wrapped, scrolled and resized cursor rows paint only when the whole ghost fits", async () => {
  const fixture = await setup("first line\nsecond line\nthird line\nplease comp", 30)
  expect(fixture.editor.visualCursor.visualRow).toBeLessThan(fixture.editor.height)
  expect(fixture.captureCharFrame()).toContain("please complete")
  fixture.resize(16, 8)
  fixture.editor.parent!.width = 16
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  fixture.resize(30, 8)
  fixture.editor.parent!.width = 30
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(true)
  fixture.editor.setText("please please please please comp")
  fixture.editor.gotoBufferEnd()
  await fixture.renderOnce()
  expect(fixture.editor.visualCursor.logicalCol).toBeGreaterThan(fixture.editor.width)
  expect(fixture.captureCharFrame()).toContain("complete")
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please please please please complete")
})

test("public selected-word insertion cannot provide single-step correction undo", async () => {
  const fixture = await setup("please cmplete")
  fixture.editor.setSelection(7, 14)
  expect(fixture.editor.getSelectedText()).toBe("cmplete")
  fixture.editor.insertText("complete")
  await fixture.renderOnce()
  expect(fixture.editor.plainText).toBe("please complete")
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe("please ")
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe("please cmplete")
})

test("uses Ghost's exact muted RGB and 0.55 alpha multiplier", () => {
  const muted = RGBA.fromValues(0.2, 0.4, 0.6, 0.8)
  const ghost = dimGhostColor(muted)
  expect(ghost.r).toBeCloseTo(muted.r)
  expect(ghost.g).toBeCloseTo(muted.g)
  expect(ghost.b).toBeCloseTo(muted.b)
  expect(ghost.a).toBeCloseTo(muted.a * 0.55)
})

test("Unicode insertion offsets work after emoji, wide characters, and combining marks", async () => {
  for (const text of ["😊 漢字 comp", "please re\u0301", "café comp"]) {
    const fixture = await setup(text)
    expect(fixture.ghost.visible()).toBe(true)
    expect(fixture.ghost.accept()).toBe(true)
    expect(fixture.editor.plainText).toBe(text.startsWith("please") ? "please re\u0301viser" : `${text}lete`)
  }
})

test("insertion preserves host content callbacks and never submits", async () => {
  const fixture = await setup()
  let changed = 0
  let submitted = 0
  const onContentChange = () => { changed++ }
  const onSubmit = () => { submitted++ }
  fixture.editor.onContentChange = onContentChange
  fixture.editor.onSubmit = onSubmit
  expect(fixture.ghost.accept()).toBe(true)
  await fixture.renderOnce()
  expect(changed).toBeGreaterThan(0)
  expect(submitted).toBe(0)
  expect(fixture.editor.onContentChange).toBe(onContentChange)
  expect(fixture.editor.onSubmit).toBe(onSubmit)
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe("please comp")
})

test("Escape hides an unchanged ghost and editing makes a new suggestion eligible", async () => {
  const fixture = await setup()
  expect(fixture.ghost.dismiss()).toBe(true)
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.captureCharFrame()).not.toContain("please complete")
  fixture.editor.insertText("l")
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please complete")
})

test.each(["normal", "mode", "selected", "enabled", "focused"] as const)("falls through when composer eligibility changes: %s", async (field) => {
  const fixture = await setup()
  if (field === "mode") fixture.view.mode = "dialog"
  else if (field === "focused") fixture.view.focused = undefined
  else if (field === "selected") fixture.view.selected = true
  else fixture.view[field] = false
  expect(fixture.ghost.accept()).toBe(false)
  expect(fixture.editor.plainText).toBe("please comp")
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
})

test("does not override host autocomplete, extmarks, selections, or empty-composer hints", async () => {
  const fixture = await setup()
  fixture.editor.traits = { capture: ["tab", "navigate"] }
  expect(eligibleComposer(fixture.view)).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  fixture.editor.traits = {}
  fixture.editor.setSelection(0, 2)
  expect(fixture.ghost.accept()).toBe(false)
  fixture.editor.clearSelection()
  fixture.editor.setText("")
  fixture.editor.placeholder = "Ghost owns this hint"
  await fixture.renderOnce()
  expect(fixture.editor.placeholder).toBe("Ghost owns this hint")
  expect(fixture.ghost.visible()).toBe(false)
})

test("predicts after an attachment placeholder and keeps its extmark intact", async () => {
  const fixture = await setup("[Image 1] please comp")
  const mark = fixture.editor.extmarks.create({ start: 0, end: 9, virtual: true })
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("[Image 1] please complete")
  expect(fixture.editor.extmarks.getAll().map(({ id, start, end }) => ({ id, start, end }))).toEqual([{ id: mark, start: 0, end: 9 }])
})

test("predicts after an attachment placeholder on a later line", async () => {
  const fixture = await setup("first line\n[Image 1] please comp")
  fixture.editor.extmarks.create({ start: 11, end: 20, virtual: true })
  await fixture.renderOnce()
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("first line\n[Image 1] please complete")
})

test("never completes inside or against an attachment placeholder", async () => {
  const fixture = await setup("[Image 1]")
  fixture.editor.extmarks.create({ start: 0, end: 9, virtual: true })
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  fixture.editor.insertText(" ")
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)

  const covered = await setup("please comp")
  covered.editor.extmarks.create({ start: 7, end: 11 })
  await covered.renderOnce()
  expect(covered.ghost.visible()).toBe(false)
  expect(covered.ghost.accept()).toBe(false)
  expect(covered.editor.plainText).toBe("please comp")
})

test("never rewrites the draft with typo replacements while extmarks exist", async () => {
  const fixture = await setup("[Image 1] please cmplete")
  const mark = fixture.editor.extmarks.create({ start: 0, end: 9, virtual: true })
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  expect(fixture.editor.plainText).toBe("[Image 1] please cmplete")
  expect(fixture.editor.extmarks.getAll().map(({ id }) => id)).toEqual([mark])
})

test("a mark created after painting stops acceptance of a replacement", async () => {
  const fixture = await setup("please cmplete")
  expect(fixture.ghost.visible()).toBe(true)
  fixture.editor.extmarks.create({ start: 0, end: 2 })
  expect(fixture.ghost.accept()).toBe(false)
  expect(fixture.editor.plainText).toBe("please cmplete")
})

test("normal host Tab capture does not suppress word suggestions", async () => {
  const fixture = await setup()
  fixture.editor.traits = { capture: ["tab"], suspend: true }
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.accept()).toBe(true)
})

test("paints and inserts a context-ranked next word while preserving the trailing space", async () => {
  const fixture = await setup("please run ")
  const model = new PersonalModel()
  model.observe([{ id: "1", text: "please run tests" }, { id: "2", text: "please run tests" }])
  fixture.predictor.setPersonal(model.snapshot())
  fixture.ghost.invalidate()
  await fixture.renderOnce()
  expect(fixture.captureCharFrame()).toContain("please run tests")
  expect(fixture.editor.plainText).toBe("please run ")
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please run tests")
})

test("stale text, moved cursors, and teardown never insert a suggestion", async () => {
  const fixture = await setup()
  fixture.editor.moveCursorLeft()
  expect(fixture.ghost.accept()).toBe(false)
  await fixture.renderOnce()
  expect(fixture.ghost.visible()).toBe(false)
  fixture.editor.gotoBufferEnd()
  await fixture.renderOnce()
  fixture.editor.insertText("x")
  expect(fixture.ghost.accept()).toBe(false)
  fixture.ghost.dispose()
  expect(fixture.ghost.accept()).toBe(false)
  fixture.editor.destroy()
  fixture.ghost.dispose()
})

test("dismissal falls through after a cursor move before rendering", async () => {
  const fixture = await setup()
  fixture.editor.moveCursorLeft()
  expect(fixture.ghost.dismiss()).toBe(false)
  fixture.editor.gotoBufferEnd()
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.dismiss()).toBe(true)
})

test("hides and refuses a suggestion that does not fit the cursor row", async () => {
  const fixture = await setup("please comp", 16)
  expect(fixture.captureCharFrame()).not.toContain("please compl")
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  expect(fixture.editor.plainText).toBe("please comp")
})

test("shows a suggestion that exactly fills the cursor row", async () => {
  const fixture = await setup("please comp", 17)
  expect(fixture.captureCharFrame()).toContain("please complete")
  expect(fixture.ghost.accept()).toBe(true)
})

test("hides a typo replacement that does not fit the cursor row", async () => {
  const fixture = await setup("please cmplete", 20)
  expect(fixture.ghost.visible()).toBe(false)
  expect(fixture.ghost.accept()).toBe(false)
  expect(fixture.editor.plainText).toBe("please cmplete")
})

test("paints and accepts a typo replacement on the current word with single-step undo", async () => {
  const fixture = await setup("please cmplete")
  expect(fixture.captureCharFrame()).toContain("please cmplete → complete")
  expect(fixture.editor.plainText).toBe("please cmplete")
  expect(fixture.ghost.visible()).toBe(true)
  expect(fixture.ghost.accept()).toBe(true)
  expect(fixture.editor.plainText).toBe("please complete")
  expect(fixture.editor.undo()).toBe(true)
  expect(fixture.editor.plainText).toBe("please cmplete")
})

test("sticky continuation keeps the shown word first without duplicating it in the cycle list", async () => {
  const testing = await createTestRenderer({ width: 60, height: 8 })
  cleanups.push(() => testing.renderer.destroy())
  const parent = new BoxRenderable(testing.renderer, { id: "composer", width: 60, height: 4, paddingLeft: 2, paddingTop: 1 })
  const editor = new TextareaRenderable(testing.renderer, { id: "input", width: "100%", height: 2 })
  parent.add(editor)
  testing.renderer.root.add(parent)
  editor.setText("please co")
  editor.gotoBufferEnd()
  editor.focus()
  const view: Composer = { editor, normal: true, focused: editor, mode: "base", selected: false, enabled: true }
  const complete = { suffix: "mplete", word: "complete", confidence: 0.9 }
  const compare = { suffix: "mpare", word: "compare", confidence: 0.8 }
  const predictor = {
    modelRevision: 1,
    grammar: proseGrammar,
    candidates: (query: { prefix: string }) => query.prefix === "co" ? [complete, compare] : [{ ...compare, suffix: "pare" }, { ...complete, suffix: "plete" }],
  } as unknown as WordPredictor
  const ghost = new ComposerGhost(editor, predictor, () => view, () => RGBA.fromHex("#888888"), testing.renderer)
  cleanups.push(() => ghost.dispose())
  await testing.renderOnce()
  expect(testing.captureCharFrame()).toContain("please complete")
  editor.insertText("m")
  await testing.renderOnce()
  expect(testing.captureCharFrame()).toContain("please complete")
  expect(ghost.cycle(1)).toBe(true)
  await testing.renderOnce()
  expect(testing.captureCharFrame()).toContain("please compare")
  expect(ghost.cycle(1)).toBe(true)
  await testing.renderOnce()
  expect(testing.captureCharFrame()).toContain("please complete")
})
