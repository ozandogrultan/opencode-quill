import { RGBA, type CliRenderer, type OptimizedBuffer, type Renderable, type TextareaRenderable } from "@opentui/core"
import { completionQuery, type TextRange } from "./prose"
import type { Prediction, WordPredictor } from "./predictor"

export type Composer = {
  editor: TextareaRenderable
  normal: boolean
  focused: unknown
  mode: string
  shell?: boolean
  selected: boolean
  enabled: boolean
}

type Alternatives = {
  summon?: string
  cycle: boolean
  accept?: string
  dismiss?: string
  colors: {
    text: RGBA
    muted: RGBA
    background: RGBA
    selectedText: RGBA
    selectedBackground: RGBA
  }
}

type CandidateMemo = {
  text: string
  offset: number
  marks: string
  revision: number
  predictor: WordPredictor
  predictions: Prediction[]
  index: number
  summoned: boolean
  prefix: string
  picker: boolean
}

type PaintedSuggestion = {
  memo: CandidateMemo
  prediction: Prediction
  picker?: { geometry: string; drawn: boolean }
}

export function dimGhostColor(muted: RGBA): RGBA {
  return RGBA.fromValues(muted.r, muted.g, muted.b, muted.a * 0.55)
}

export function eligibleComposer(view: Composer, text?: string): boolean {
  const editor = view.editor
  return view.enabled && view.normal && view.mode === "base" && !view.selected &&
    editor === view.focused && editor.focused && editor.visible && !editor.isDestroyed &&
    !!editor.parent && !editor.parent.isDestroyed && !editor.hasSelection() &&
    !editor.traits.capture?.includes("navigate") &&
    (text ?? editor.plainText).trim().length > 0
}

export function findComposer(marker: Renderable | undefined, isEditor: (node: Renderable) => node is TextareaRenderable): TextareaRenderable | undefined {
  if (!marker || marker.isDestroyed) return
  const editors = (node: Renderable): TextareaRenderable[] => isEditor(node) ? [node] : node.getChildren().flatMap((child) => editors(child as Renderable))
  for (let node = marker.parent; node?.parent; node = node.parent) {
    if (node.isDestroyed) return
    const found = editors(node)
    if (found.length > 1) return
    if (found.length === 1) {
      const editor = found[0]
      return typeof (editor as unknown as { getClipboardText?: unknown }).getClipboardText === "function" ? editor : undefined
    }
  }
}

export class ComposerGhost {
  private shown: PaintedSuggestion | undefined
  private dismissed: { text: string; offset: number } | undefined
  private memo: CandidateMemo | undefined
  private disposed = false
  private readonly draw: (buffer: OptimizedBuffer, delta: number) => void

  constructor(
    readonly editor: TextareaRenderable,
    private readonly predictor: WordPredictor,
    private readonly view: () => Composer,
    private readonly color: () => RGBA,
    private readonly renderer: CliRenderer,
    private readonly completeAtLineEnd = false,
    private readonly shellPredictor?: WordPredictor,
    private readonly alternatives?: () => Alternatives,
  ) {
    this.draw = (buffer) => { if (!this.disposed) this.paint(buffer) }
    renderer.addPostProcessFn(this.draw)
  }

  private active(): WordPredictor {
    return this.shellPredictor && this.view().shell ? this.shellPredictor : this.predictor
  }

  private offset(): number {
    return this.editor.editBuffer.getTextRange(0, this.editor.cursorOffset).length
  }

  private protectedRanges(marks = this.editor.extmarks.getAll()): TextRange[] {
    return marks.map((mark) => [
      this.editor.editBuffer.getTextRange(0, mark.start).length,
      this.editor.editBuffer.getTextRange(0, mark.end).length,
    ])
  }

  private marksKey(): string {
    return this.editor.extmarks.getAll().map((mark) => `${mark.id}:${mark.start}:${mark.end}:${mark.virtual}:${mark.typeId}:${mark.styleId}:${mark.priority}`).join()
  }

  private room(): number {
    const cursor = this.editor.visualCursor
    const x = this.editor.screenX + cursor.visualCol
    const y = this.editor.screenY + cursor.visualRow
    if (x < 0 || y < 0 || y >= this.renderer.height || cursor.visualRow < 0 || cursor.visualRow >= this.editor.height) return 0
    return Math.min(this.editor.width - cursor.visualCol, this.renderer.width - x)
  }

  private fits(prediction: Prediction): boolean {
    const room = this.room()
    return room > 0 && this.editor.editBuffer.measureText(prediction.replace ? ` → ${prediction.suffix}` : prediction.suffix) <= room
  }

  invalidate(): void {
    this.memo = undefined
    this.shown = undefined
    if (!this.editor.isDestroyed) this.editor.requestRender()
  }

  private prediction(text: string, offset: number): Prediction | undefined {
    if (this.dismissed && (this.dismissed.text !== text || this.dismissed.offset !== offset)) this.dismissed = undefined
    if (this.dismissed || !eligibleComposer(this.view(), text)) return
    const marks = this.editor.extmarks.getAll()
    const signature = this.marksKey()
    const predictor = this.active()
    const revision = predictor.modelRevision
    if (this.memo?.text === text && this.memo.offset === offset && this.memo.marks === signature && this.memo.revision === revision && this.memo.predictor === predictor) return this.memo.predictions[this.memo.index]
    const query = completionQuery(text, offset, this.protectedRanges(marks), this.completeAtLineEnd, predictor.grammar)
    const allowReplacement = marks.length === 0 && offset === text.length
    const predictions = query ? predictor.candidates(query, undefined, false, allowReplacement) : []
    if (!allowReplacement && predictions[0]?.replace) predictions.length = 0
    else if (!allowReplacement) predictions.splice(0, predictions.length, ...predictions.filter((prediction) => !prediction.replace))
    const last = this.shown
    if (query && !query.next && offset === text.length && last && last.memo === this.memo && last.memo.offset === last.memo.text.length && last.memo.index === 0 && !last.memo.summoned && last.memo.revision === revision && last.memo.predictor === predictor && last.memo.marks === signature && !last.prediction.replace && text.startsWith(last.memo.text)) {
      const typed = text.slice(last.memo.text.length)
      if (typed && last.prediction.suffix.startsWith(typed) && typed.length < last.prediction.suffix.length) {
        const sticky = { ...last.prediction, suffix: last.prediction.suffix.slice(typed.length) }
        predictions.splice(0, predictions.length, sticky, ...predictions.filter((prediction) => prediction.word !== sticky.word))
      }
    }
    this.memo = { text, offset, marks: signature, revision, predictor, predictions, index: 0, summoned: false, prefix: query?.prefix ?? "", picker: false }
    return predictions[0]
  }

  private pickerGeometry(): string {
    const { visualCol, visualRow } = this.editor.visualCursor
    return [this.renderer.width, this.renderer.height, this.editor.screenX, this.editor.screenY,
      this.editor.width, visualCol, visualRow].join(":")
  }

  private paintPicker(buffer: OptimizedBuffer, x: number, y: number, fitting: Prediction[], prediction: Prediction, options: Alternatives): boolean {
    const { prefix } = this.memo!
    const prefixWidth = this.editor.editBuffer.measureText(prefix)
    const cursor = this.editor.visualCursor
    if (cursor.visualRow !== 0 || cursor.visualCol < prefixWidth || y < fitting.length) return false
    const terms = fitting.map((candidate) => candidate.replace ? candidate.suffix : prefix + candidate.suffix)
    const measure = (text: string) => this.editor.editBuffer.measureText(text)
    const termWidth = Math.max(...terms.map(measure)) + 3
    const left = Math.max(0, this.editor.screenX)
    const right = Math.min(buffer.width, this.editor.screenX + this.editor.width)
    if (termWidth > Math.min(48, right - left)) return false
    const start = Math.max(left, Math.min(x - prefixWidth - 2, right - termWidth))
    const fullHelp = ["↑/↓ move", options.accept && `${options.accept} accept`, options.dismiss && `${options.dismiss} close`].filter(Boolean).join(" · ")
    const help = y > fitting.length
      ? [fullHelp, "↑/↓ move"].find((label) => measure(label) + 3 <= Math.min(48, right - start))
      : undefined
    const width = Math.max(termWidth, help ? measure(help) + 3 : 0)
    const height = fitting.length + Number(!!help)
    const top = y - height
    const { colors } = options
    buffer.pushScissorRect(start, top, width, height)
    try {
      buffer.fillRect(start, top, width, height, colors.background)
      terms.forEach((term, index) => {
        const selected = fitting[index] === prediction
        if (selected) buffer.fillRect(start, top + index, width, 1, colors.selectedBackground)
        buffer.drawText(`${selected ? "› " : "  "}${term}`, start, top + index,
          selected ? colors.selectedText : colors.text, selected ? colors.selectedBackground : colors.background)
      })
      if (help) buffer.drawText(help, start + 2, y - 1, colors.muted, colors.background)
    } finally {
      buffer.popScissorRect()
    }
    return true
  }

  private paint(buffer: OptimizedBuffer): void {
    if (this.editor.isDestroyed) {
      this.shown = undefined
      return
    }
    const text = this.editor.plainText
    const offset = this.offset()
    const prediction = this.prediction(text, offset)
    if (!prediction) {
      if (this.memo) this.memo.picker = false
      this.shown = undefined
      return
    }
    const cursor = this.editor.visualCursor
    const room = this.room()
    const ghost = prediction.replace ? ` → ${prediction.suffix}` : prediction.suffix
    if (!this.fits(prediction)) {
      this.shown = undefined
      return
    }
    const x = this.editor.screenX + cursor.visualCol
    const y = this.editor.screenY + cursor.visualRow
    const memo = this.memo!
    const fitting = memo.predictions.length > 1 ? memo.predictions.filter((candidate) => this.fits(candidate)) : []
    const options = fitting.length > 1 ? this.alternatives?.() : undefined
    const attempted = memo.picker && fitting.length > 1
    const picker = !!options && attempted && this.paintPicker(buffer, x, y, fitting, prediction, options)
    buffer.pushScissorRect(x, y, room, 1)
    try {
      const color = this.color()
      buffer.drawText(ghost, x, y, color, this.editor.backgroundColor)
      if (options && !picker && (options.summon || options.cycle || memo.picker)) {
        const counter = `  ${fitting.indexOf(prediction) + 1}/${fitting.length}`
        const hint = options.summon && (!attempted || !options.cycle)
          ? `  ${options.summon} ${attempted ? "cycles" : "for"} ${fitting.length} choices`
          : counter
        const width = this.editor.editBuffer.measureText(ghost)
        for (const label of hint === counter ? [counter] : [hint, counter]) {
          if (width + this.editor.editBuffer.measureText(label) > room) continue
          buffer.drawText(label, x + width, y, dimGhostColor(color), this.editor.backgroundColor)
          break
        }
      }
    } finally {
      buffer.popScissorRect()
    }
    this.shown = { memo, prediction, picker: attempted ? { geometry: this.pickerGeometry(), drawn: picker } : undefined }
  }

  accept(): boolean {
    const shown = this.shown
    if (!shown || !this.visible()) return false
    const { memo } = shown
    const prediction = memo.predictions[memo.index]
    if (prediction !== shown.prediction && (!this.pickerVisible() || !this.fits(prediction))) return false
    const marks = this.editor.extmarks.getAll()
    if (!completionQuery(memo.text, memo.offset, this.protectedRanges(marks), this.completeAtLineEnd, memo.predictor.grammar)) return false
    if ((marks.length || memo.offset !== memo.text.length) && prediction.replace) return false
    memo.picker = false
    this.shown = undefined
    if (prediction.replace) {
      this.editor.replaceText(memo.text.slice(0, memo.text.length - prediction.replace) + prediction.suffix)
      this.editor.gotoBufferEnd()
    } else {
      this.editor.insertText(prediction.suffix)
    }
    this.editor.requestRender()
    return true
  }

  dismiss(): boolean {
    if (!this.visible()) return false
    const { memo } = this.shown!
    if (!this.pickerVisible()) this.dismissed = { text: memo.text, offset: memo.offset }
    memo.picker = false
    this.shown = undefined
    this.editor.requestRender()
    return true
  }

  visible(): boolean {
    const shown = this.shown
    if (this.disposed || !shown || shown.memo !== this.memo || !eligibleComposer(this.view())) return false
    const { memo, prediction } = shown
    return this.editor.plainText === memo.text && this.offset() === memo.offset &&
      this.marksKey() === memo.marks && this.active() === memo.predictor && memo.predictor.modelRevision === memo.revision && this.fits(prediction)
  }

  canCycle(): boolean {
    return this.visible() && this.memo!.predictions.some((prediction, index) => index !== this.memo!.index && this.fits(prediction))
  }

  pickerVisible(): boolean {
    const picker = this.shown?.picker
    return picker?.drawn === true && this.visible() && picker.geometry === this.pickerGeometry()
  }

  summon(): boolean {
    if (this.visible()) {
      if (!this.canCycle()) return false
      const picker = this.shown!.picker
      if (picker?.drawn === false && picker.geometry === this.pickerGeometry()) return this.cycle(1)
      this.memo!.picker = true
      this.editor.requestRender()
      return true
    }
    if (this.disposed || !eligibleComposer(this.view())) return false
    const text = this.editor.plainText
    const offset = this.offset()
    const automatic = this.prediction(text, offset)
    if (automatic && this.fits(automatic)) return false
    const predictor = this.active()
    const marks = this.editor.extmarks.getAll()
    const query = completionQuery(text, offset, this.protectedRanges(marks), this.completeAtLineEnd, predictor.grammar)
    if (!query) return false
    const allowReplacement = marks.length === 0 && offset === text.length
    const predictions = predictor.candidates(query, 5, true, allowReplacement).filter((prediction) =>
      (allowReplacement || !prediction.replace) && this.fits(prediction))
    if (!predictions.length) return false
    this.dismissed = undefined
    this.memo = { text, offset, marks: this.marksKey(), revision: predictor.modelRevision, predictor, predictions, index: 0, summoned: true, prefix: query.prefix, picker: predictions.length > 1 }
    this.editor.requestRender()
    return true
  }

  cycle(direction: 1 | -1): boolean {
    if (!this.canCycle()) return false
    const memo = this.memo!
    do {
      memo.index = (memo.index + direction + memo.predictions.length) % memo.predictions.length
    } while (!this.fits(memo.predictions[memo.index]))
    memo.picker = true
    this.editor.requestRender()
    return true
  }

  dispose(): void {
    this.disposed = true
    this.shown = undefined
    if (!this.renderer.isDestroyed) this.renderer.removePostProcessFn(this.draw)
    if (this.editor.isDestroyed) return
    this.editor.requestRender()
  }
}
