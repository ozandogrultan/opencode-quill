/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { InputRenderable, TextareaRenderable, type BoxRenderable } from "@opentui/core"
import { createEffect, createRoot, createSignal, onCleanup, untrack } from "solid-js"
import { unwrap } from "solid-js/store"
import frequencies from "subtlex-word-frequencies"
import { proseGrammar, type Grammar } from "./prose"
import { ComposerGhost, dimGhostColor, findComposer } from "./ghost"
import { completionLayer } from "./keymap"
import { parseQuillCommand, resolveOptions } from "./options"
import { emptySnapshot, PersonalModel, WordPredictor } from "./predictor"
import { shellGrammar } from "./shell"

export default Plugin.define({
  id: "quill",
  setup(context) {
    const options = resolveOptions(context.options)
    const [settings, setSettings] = context.storage.store("settings", {
      initial: { enabled: options.enabled, shell: options.completeShell },
    })
    const [learning, setLearning] = context.storage.store("learning", {
      initial: { snapshot: emptySnapshot() },
    })
    const [shellLearning, setShellLearning] = context.storage.store("shell", {
      initial: { snapshot: emptySnapshot() },
    })
    const predictor = new WordPredictor(frequencies)
    const shellPredictor = new WordPredictor([], shellGrammar)
    const composers = new Map<string, { marker: BoxRenderable; mode: () => "normal" | "shell" }>()
    const seeded = new Set<string>()
    const inFlight = new Map<string, { pending: boolean; announce: boolean }>()
    const [revision, setRevision] = createSignal(0)
    let ghost: ComposerGhost | undefined
    let disposed = false
    let warned = false
    let resetVersion = 0

    const shellEnabled = () => settings.shell !== false

    const routeKey = () => {
      const route = context.ui.router.current()
      return route.type === "home" ? "home" : route.type === "session" ? route.sessionID : undefined
    }

    let found: { marker: BoxRenderable; editor: TextareaRenderable | undefined; text: string } | undefined
    const currentEditor = () => {
      const key = routeKey()
      const composer = key && composers.get(key)
      if (!composer) return
      const cached = found?.marker === composer.marker && found.editor
      if (cached && !cached.isDestroyed && !composer.marker.isDestroyed && cached.parent && !cached.parent.isDestroyed && cached.plainText === found!.text) return cached
      const editor = findComposer(composer.marker, (node): node is TextareaRenderable => node instanceof TextareaRenderable && !(node instanceof InputRenderable))
      found = { marker: composer.marker, editor, text: editor?.plainText ?? "" }
      return editor
    }

    const syncEditor = () => {
      if (disposed) return
      const editor = currentEditor()
      if (ghost?.editor === editor) return
      ghost?.dispose()
      ghost = editor && new ComposerGhost(editor, predictor, () => {
        const key = routeKey()
        const shell = !!key && composers.get(key)?.mode() === "shell"
        return {
          editor,
          normal: !!key && composers.has(key),
          focused: context.renderer.currentFocusedEditor,
          mode: context.keymap.mode.current(),
          shell,
          selected: context.renderer.hasSelection,
          enabled: !disposed && settings.enabled && (!shell || shellEnabled()) && currentEditor() === editor,
        }
      }, () => dimGhostColor(context.theme.text.muted), context.renderer, options.completeAtLineEnd, shellPredictor)
    }

    const sessionInfo = (sessionID: string) =>
      context.data.session.get?.(sessionID) ?? context.data.session.list().find((session) => session.id === sessionID)

    const learn = async (sessionID: string, announce = true) => {
      if (disposed || !settings.enabled) return
      if (sessionInfo(sessionID)?.parentID) return
      const active = inFlight.get(sessionID)
      if (active) {
        if (announce) {
          active.pending = true
          active.announce = true
        }
        return
      }
      const state = { pending: false, announce }
      inFlight.set(sessionID, state)
      try {
        do {
          state.pending = false
          const version = resetVersion
          const shouldAnnounce = state.announce
          state.announce = false
          try {
            await Promise.all([context.data.session.sync?.(sessionID), context.data.session.message.sync(sessionID)])
            if (disposed || !settings.enabled) return
            if (sessionInfo(sessionID)?.parentID) return
            if (version !== resetVersion) continue
            const messages = context.data.session.message.list(sessionID)
            const absorb = async (store: typeof learning, update: typeof setLearning, grammar: Grammar, candidates: { id: string; text: string; created?: number }[]) => {
              const promptsFor = (clearedAt: number | undefined) => candidates
                .filter((prompt) => clearedAt === undefined || (prompt.created !== undefined && prompt.created >= clearedAt))
                .map(({ id, text }) => ({ id, text }))
              const snapshot = unwrap(store.snapshot)
              const seen = new Set(snapshot.seen)
              const prompts = promptsFor(snapshot.clearedAt)
              if (!prompts.some((prompt) => !seen.has(prompt.id))) return
              const model = new PersonalModel(snapshot, grammar)
              if (!model.observe(prompts)) return
              await update((draft) => {
                if (disposed || !settings.enabled || version !== resetVersion) return
                const session = sessionInfo(sessionID)
                if (!session || session.parentID) return
                const latest = new PersonalModel(unwrap(draft.snapshot), grammar)
                if (latest.observe(promptsFor(latest.clearedAt))) draft.snapshot = latest.snapshot()
              })
            }
            await absorb(learning, setLearning, proseGrammar, messages
              .filter((message) => message.type === "user")
              .slice(-200)
              .map((message) => ({ id: `${sessionID}:${message.id}`, text: message.text, created: message.time?.created })))
            if (shellEnabled()) {
              await absorb(shellLearning, setShellLearning, shellGrammar, messages
                .flatMap((message) => message.type === "shell" ? [{ id: `${sessionID}:${message.id}`, text: message.command, created: message.time.created }] : [])
                .slice(-200))
            }
          } catch (error) {
            if (shouldAnnounce && !disposed && version === resetVersion && !warned) {
              warned = true
              context.ui.toast.show({ title: "Quill", message: `History learning unavailable (${sessionID}: ${error instanceof Error ? error.message : String(error)}); vocabulary completion is still active.`, variant: "warning" })
            }
          }
        } while (state.pending && !disposed && settings.enabled)
      } finally {
        inFlight.delete(sessionID)
      }
    }

    const clearHistory = async () => {
      resetVersion++
      for (const state of inFlight.values()) {
        state.pending = false
        state.announce = false
      }
      const cleared = { ...emptySnapshot(), clearedAt: Date.now() }
      predictor.setPersonal(cleared)
      shellPredictor.setPersonal(cleared)
      await setLearning((draft) => { draft.snapshot = cleared })
      await setShellLearning((draft) => { draft.snapshot = cleared })
      ghost?.invalidate()
      context.ui.toast.show({ title: "Quill", message: "Word autocomplete history cleared" })
    }

    const clearCasing = async () => {
      const next = { ...unwrap(learning.snapshot), forms: [] }
      predictor.setPersonal(next)
      await setLearning((draft) => { draft.snapshot = { ...unwrap(draft.snapshot), forms: [] } })
      ghost?.invalidate()
      context.ui.toast.show({ title: "Quill", message: "Learned word casing cleared" })
    }

    const disposeEffects = createRoot((dispose) => {
      createEffect(() => {
        const snapshot = learning.snapshot
        snapshot.seen.length
        snapshot.seen.at(-1)
        predictor.setPersonal(unwrap(snapshot))
        ghost?.invalidate()
      })
      createEffect(() => {
        const snapshot = shellLearning.snapshot
        snapshot.seen.length
        snapshot.seen.at(-1)
        shellPredictor.setPersonal(unwrap(snapshot))
        ghost?.invalidate()
      })
      createEffect(() => {
        revision()
        routeKey()
        settings.enabled
        settings.shell
        context.keymap.mode.current()
        syncEditor()
        ghost?.invalidate()
      })
      createEffect(() => {
        if (!settings.enabled) return
        const route = context.ui.router.current()
        if (route.type === "session") untrack(() => { void learn(route.sessionID, false) })
        if (seeded.size >= 8) return
        for (const session of context.data.session.list().filter((session) => !session.parentID).sort((a, b) => b.time.updated - a.time.updated).slice(0, 8)) {
          if (seeded.has(session.id)) continue
          seeded.add(session.id)
          untrack(() => { void learn(session.id, false) })
        }
      })
      return dispose
    })

    const beforeRender = async () => { syncEditor() }
    context.renderer.setFrameCallback(beforeRender)
    const offStarted = context.data.on("session.execution.started", (event) => { void learn(event.data.sessionID) })
    const offSucceeded = context.data.on("session.execution.succeeded", (event) => { void learn(event.data.sessionID) })
    const offDelivered = context.data.on("session.inbox.delivered", (event) => { void learn(event.data.sessionID) })

    context.keymap.layer(() => completionLayer(options, () => ghost))
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "quill.toggle",
          title: `Word autocomplete: ${settings.enabled ? "on" : "off"}`,
          description: "Toggle local word suggestions",
          group: "Prompt",
          palette: true,
          slash: { name: "quill", arguments: true },
          run: async (input) => {
            const command = parseQuillCommand(input)
            if (command.type === "clear") {
              await clearHistory()
              return
            }
            if (command.type === "casing") {
              await clearCasing()
              return
            }
            if (command.type === "shell") {
              await setSettings((draft) => { draft.shell = command.value })
              ghost?.invalidate()
              context.ui.toast.show({ title: "Quill", message: `Shell autocomplete: ${command.value ? "on" : "off"}` })
              return
            }
            if (command.type === "invalid") {
              context.ui.toast.show({ title: "Quill", message: "Use /quill, /quill on, /quill off, /quill shell on, /quill shell off, /quill clear, or /quill clear casing", variant: "warning" })
              return
            }
            const enabled = command.type === "enable" ? command.value : !settings.enabled
            await setSettings((draft) => { draft.enabled = enabled })
            ghost?.invalidate()
            context.ui.toast.show({ title: "Quill", message: `Word autocomplete: ${enabled ? "on" : "off"}` })
          },
        },
        {
          id: "quill.clear",
          title: "Clear word autocomplete history",
          description: "Reset learned vocabulary, n-grams, and prompt transitions",
          group: "Prompt",
          palette: true,
          run: clearHistory,
        },
      ],
    }))

    const offComposer = context.ui.slot({
      append: "prompt.footer",
      render(input) {
        const [marker, setMarker] = createSignal<BoxRenderable>()
        createEffect(() => {
          const key = input.sessionID ?? "home"
          const node = marker()
          if (!node) return
          composers.set(key, { marker: node, mode: () => input.mode })
          setRevision((value) => value + 1)
          onCleanup(() => {
            if (composers.get(key)?.marker !== node) return
            composers.delete(key)
            setRevision((value) => value + 1)
          })
        })
        return <box width={0} height={0} ref={setMarker} />
      },
    })

    return () => {
      disposed = true
      context.renderer.removeFrameCallback(beforeRender)
      disposeEffects()
      offStarted()
      offSucceeded()
      offDelivered()
      offComposer()
      ghost?.dispose()
      composers.clear()
    }
  },
})
