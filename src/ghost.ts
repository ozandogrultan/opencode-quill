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
  private shown: { text: string; offset: number; prediction: Prediction; marks: string; revision: number; predictor: WordPredictor } | undefined
  private dismissed: { text: string; offset: number } | undefined
  private memo: { text: string; offset: number; marks: string; revision: number; predictor: WordPredictor; predictions: Prediction[]; index: number; summoned: boolean } | undefined
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
    private readonly showAlternativeCounter = () => false,
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
    if (query && !query.next && offset === text.length && last && last.offset === last.text.length && this.memo?.index === 0 && !this.memo.summoned && last.revision === revision && last.predictor === predictor && last.marks === signature && !last.prediction.replace && text.startsWith(last.text)) {
      const typed = text.slice(last.text.length)
      if (typed && last.prediction.suffix.startsWith(typed) && typed.length < last.prediction.suffix.length) {
        const sticky = { ...last.prediction, suffix: last.prediction.suffix.slice(typed.length) }
        predictions.splice(0, predictions.length, sticky, ...predictions.filter((prediction) => prediction.word !== sticky.word))
      }
    }
    this.memo = { text, offset, marks: signature, revision, predictor, predictions, index: 0, summoned: false }
    return predictions[0]
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
    buffer.pushScissorRect(x, y, room, 1)
    try {
      const color = this.color()
      buffer.drawText(ghost, x, y, color, this.editor.backgroundColor)
      const memo = this.memo!
      if (memo.predictions.length > 1 && this.showAlternativeCounter()) {
        const fitting = memo.predictions.filter((candidate) => this.fits(candidate))
        if (fitting.length > 1) {
          const counter = `  ${fitting.indexOf(prediction) + 1}/${fitting.length}`
          const width = this.editor.editBuffer.measureText(ghost)
          if (width + this.editor.editBuffer.measureText(counter) <= room) {
            buffer.drawText(counter, x + width, y, dimGhostColor(color), this.editor.backgroundColor)
          }
        }
      }
    } finally {
      buffer.popScissorRect()
    }
    this.shown = { text, offset, prediction, marks: this.memo!.marks, revision: this.memo!.revision, predictor: this.memo!.predictor }
  }

  accept(): boolean {
    const shown = this.shown
    if (!shown || !this.visible()) return false
    const marks = this.editor.extmarks.getAll()
    if (!completionQuery(shown.text, shown.offset, this.protectedRanges(marks), this.completeAtLineEnd, shown.predictor.grammar)) return false
    if ((marks.length || shown.offset !== shown.text.length) && shown.prediction.replace) return false
    this.shown = undefined
    if (shown.prediction.replace) {
      this.editor.replaceText(shown.text.slice(0, shown.text.length - shown.prediction.replace) + shown.prediction.suffix)
      this.editor.gotoBufferEnd()
    } else {
      this.editor.insertText(shown.prediction.suffix)
    }
    this.editor.requestRender()
    return true
  }

  dismiss(): boolean {
    if (!this.visible()) return false
    this.dismissed = { text: this.shown!.text, offset: this.shown!.offset }
    this.shown = undefined
    this.editor.requestRender()
    return true
  }

  visible(): boolean {
    return !this.disposed && !!this.shown && eligibleComposer(this.view()) &&
      this.editor.plainText === this.shown.text && this.offset() === this.shown.offset &&
      this.marksKey() === this.shown.marks && this.active() === this.shown.predictor && this.shown.predictor.modelRevision === this.shown.revision && this.fits(this.shown.prediction)
  }

  canCycle(): boolean {
    return this.visible() && this.memo!.predictions.some((prediction, index) => index !== this.memo!.index && this.fits(prediction))
  }

  summon(): boolean {
    if (this.disposed || this.visible() || !eligibleComposer(this.view())) return false
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
    this.memo = { text, offset, marks: this.marksKey(), revision: predictor.modelRevision, predictor, predictions, index: 0, summoned: true }
    this.editor.requestRender()
    return true
  }

  cycle(direction: 1 | -1): boolean {
    if (!this.canCycle()) return false
    const memo = this.memo!
    do {
      memo.index = (memo.index + direction + memo.predictions.length) % memo.predictions.length
    } while (!this.fits(memo.predictions[memo.index]))
    this.shown = undefined
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
