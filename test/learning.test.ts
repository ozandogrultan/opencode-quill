import { afterEach, expect, mock, test } from "bun:test"
import { createStore, produce } from "solid-js/store"
import { emptySnapshot, PersonalModel, type Snapshot } from "../src/predictor"
import plugin from "../src/tui"

type Message = { id: string; type: "user"; text: string; time?: { created: number } }
type SessionInfo = { id: string; parentID?: string; time: { updated: number } }
type Layer = { commands?: { id?: string; run?: (input?: string) => unknown }[] }
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

async function setup(sync: () => Promise<void>, initialMessages: Message[] = [], initialWrite?: Promise<void>, route = "home", sessions: SessionInfo[] = [{ id: "session", time: { updated: 1 } }], initialSnapshot = emptySnapshot(), options: Record<string, unknown> = {}) {
  let messages = initialMessages
  let writeGate = initialWrite
  const [learning, setLearning] = createStore({ snapshot: structuredClone(initialSnapshot) })
  const [settings, setSettings] = createStore({ enabled: true })
  const listeners = new Map<string, (event: { data: { sessionID: string } }) => void>()
  const layers: (() => Layer)[] = []
  const toast = mock(() => {})
  const context = {
    options,
    storage: {
      store: (key: string) => key === "settings"
        ? [settings, async (mutate: (draft: { enabled: boolean }) => void) => { setSettings(produce(mutate)) }]
        : [learning, async (mutate: (draft: { snapshot: Snapshot }) => void) => {
          if (writeGate) await writeGate
          setLearning(produce(mutate))
        }],
    },
    data: {
      session: {
        list: () => sessions,
        message: { sync, list: () => messages },
      },
      on: (name: string, listener: (event: { data: { sessionID: string } }) => void) => {
        listeners.set(name, listener)
        return () => { listeners.delete(name) }
      },
    },
    ui: {
      router: { current: () => route === "home" ? { type: "home" } : { type: "session", sessionID: "session" } },
      toast: { show: toast },
      slot: () => () => {},
    },
    keymap: { mode: { current: () => "base" }, layer: (factory: () => Layer) => { layers.push(factory) } },
    renderer: { setFrameCallback: () => {}, removeFrameCallback: () => {} },
  } as unknown as Parameters<typeof plugin.setup>[0]
  const dispose = await plugin.setup(context)
  let disposed = false
  const stop = async () => {
    if (disposed) return
    disposed = true
    await dispose?.()
  }
  cleanups.push(stop)
  return {
    stop,
    learning,
    toast,
    setMessages: (value: Message[]) => { messages = value },
    setWriteGate: (value: Promise<void> | undefined) => { writeGate = value },
    emit: (name: string, sessionID = "session") => { listeners.get(name)?.({ data: { sessionID } }) },
    run: async (id: string, input?: string) => {
      const command = layers.flatMap((layer) => layer().commands ?? []).find((command) => command.id === id)
      if (!command?.run) throw new Error(`Missing command: ${id}`)
      await command.run(input)
    },
  }
}

test("coalesces concurrent session events into one follow-up sync after an empty backfill", async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  let calls = 0
  const sync = mock(() => (++calls === 1 ? first.promise : second.promise))
  const fixture = await setup(sync)
  expect(sync).toHaveBeenCalledTimes(1)
  fixture.emit("session.execution.started")
  fixture.emit("session.inbox.delivered")
  first.resolve()
  await settle()
  expect(sync).toHaveBeenCalledTimes(2)
  fixture.setMessages([{ id: "new", type: "user", text: "please run tests" }])
  second.resolve()
  await settle()
  expect(fixture.learning.snapshot.seen).toEqual(["session:new"])
  expect(sync).toHaveBeenCalledTimes(2)
})

test("deduplicates overlapping startup and route backfills", async () => {
  const pending = Promise.withResolvers<void>()
  const sync = mock(() => pending.promise)
  await setup(sync, [], undefined, "session")
  expect(sync).toHaveBeenCalledTimes(1)
  pending.resolve()
  await settle()
  expect(sync).toHaveBeenCalledTimes(1)
})

test("reopening old sessions after a large JSON restore never replays retained messages", async () => {
  const model = new PersonalModel()
  model.observe(Array.from({ length: 8001 }, (_, index) => ({ id: `session:${index}`, text: "please complete" })))
  const snapshot: Snapshot = JSON.parse(JSON.stringify(model.snapshot()))
  const fixture = await setup(async () => {}, [{ id: "0", type: "user", text: "please complete" }], undefined, "session", undefined, snapshot)
  await settle()
  expect(fixture.learning.snapshot).toEqual(snapshot)
  fixture.setMessages([
    { id: "0", type: "user", text: "please complete" },
    { id: "new", type: "user", text: "please complete" },
  ])
  fixture.emit("session.inbox.delivered")
  await settle()
  expect(new Map(fixture.learning.snapshot.words).get("please")).toBe(8002)
  expect(fixture.learning.snapshot.seen).toHaveLength(8002)
  expect(fixture.learning.snapshot.seen).toContain("session:0")
})

test("overlapping session writes merge IDs into the latest draft without replay or lost learning", async () => {
  const model = new PersonalModel()
  model.observe(Array.from({ length: 8001 }, (_, index) => ({ id: `history:${index}`, text: "please complete" })))
  const write = Promise.withResolvers<void>()
  const fixture = await setup(async () => {}, [{ id: "shared", type: "user", text: "please complete", time: { created: 1 } }], write.promise, "home", [
    { id: "session", time: { updated: 2 } },
    { id: "other", time: { updated: 1 } },
  ], JSON.parse(JSON.stringify(model.snapshot())))
  await settle()
  write.resolve()
  await settle()
  expect(fixture.learning.snapshot.seen).toHaveLength(8003)
  expect(fixture.learning.snapshot.seen).toContain("session:shared")
  expect(fixture.learning.snapshot.seen).toContain("other:shared")
  expect(new Map(fixture.learning.snapshot.words).get("please")).toBe(8003)
  fixture.emit("session.inbox.delivered")
  fixture.emit("session.inbox.delivered", "other")
  await settle()
  expect(new Map(fixture.learning.snapshot.words).get("please")).toBe(8003)
  expect(fixture.learning.snapshot.seen).toHaveLength(8003)
})

test.each(["quill.clear", "quill.toggle"])("%s cancels stale syncs and queued pre-clear events", async (command) => {
  const pending = Promise.withResolvers<void>()
  const sync = mock(() => pending.promise)
  const fixture = await setup(sync, [{ id: "old", type: "user", text: "please run tests" }])
  fixture.emit("session.execution.started")
  await fixture.run(command, command === "quill.toggle" ? "clear" : undefined)
  pending.resolve()
  await settle()
  expect(fixture.learning.snapshot).toEqual({ ...emptySnapshot(), clearedAt: expect.any(Number) })
  expect(sync).toHaveBeenCalledTimes(1)
})

test("clear is not undone by re-learning messages sent before it", async () => {
  const fixture = await setup(async () => {}, [{ id: "old", type: "user", text: "please run tests", time: { created: 1 } }])
  await settle()
  expect(fixture.learning.snapshot.seen).toEqual(["session:old"])
  await fixture.run("quill.clear")
  fixture.emit("session.inbox.delivered")
  await settle()
  expect(fixture.learning.snapshot.seen).toEqual([])
  expect(fixture.learning.snapshot.words).toEqual([])
  fixture.setMessages([
    { id: "old", type: "user", text: "please run tests", time: { created: 1 } },
    { id: "new", type: "user", text: "please run tests", time: { created: Date.now() + 1000 } },
  ])
  fixture.emit("session.inbox.delivered")
  await settle()
  expect(fixture.learning.snapshot.seen).toEqual(["session:new"])
  expect(fixture.learning.snapshot.clearedAt).toBeNumber()
})

test("a snapshot saved before clearedAt existed keeps learning everything", async () => {
  const fixture = await setup(async () => {}, [
    { id: "old", type: "user", text: "please run tests", time: { created: 1 } },
    { id: "undated", type: "user", text: "please run tests" },
  ])
  await settle()
  expect(fixture.learning.snapshot.seen).toEqual(["session:old", "session:undated"])
  expect(fixture.learning.snapshot.clearedAt).toBeUndefined()
})

test("clear survives restart and excludes old and undated history while learning new messages", async () => {
  const messages: Message[] = [
    { id: "old", type: "user", text: "please run tests", time: { created: 1 } },
    { id: "undated", type: "user", text: "please run tests" },
  ]
  const fixture = await setup(async () => {}, messages)
  await settle()
  expect(fixture.learning.snapshot.seen).toEqual(["session:old", "session:undated"])
  await fixture.run("quill.clear")
  const persisted: Snapshot = JSON.parse(JSON.stringify(fixture.learning.snapshot))
  await fixture.stop()
  const restarted = await setup(async () => {}, messages, undefined, "home", undefined, persisted)
  await settle()
  expect(restarted.learning.snapshot).toEqual(persisted)
  restarted.setMessages([...messages, { id: "new", type: "user", text: "please run tests", time: { created: persisted.clearedAt! + 1 } }])
  restarted.emit("session.inbox.delivered")
  await settle()
  expect(restarted.learning.snapshot.seen).toEqual(["session:new"])
  expect(restarted.learning.snapshot.words).not.toEqual([])
  expect(restarted.learning.snapshot.clearedAt).toBe(persisted.clearedAt)
})

test.each(["sync", "storage"])("child metadata arriving during %s prevents learning", async (phase) => {
  const pending = Promise.withResolvers<void>()
  const sessions: SessionInfo[] = []
  const fixture = await setup(
    () => phase === "sync" ? pending.promise : Promise.resolve(),
    [{ id: "task", type: "user", text: "please run tests" }],
    phase === "storage" ? pending.promise : undefined,
    "session",
    sessions,
  )
  await settle()
  sessions.push({ id: "session", parentID: "parent", time: { updated: 1 } })
  pending.resolve()
  await settle()
  expect(fixture.learning.snapshot).toEqual(emptySnapshot())
  expect(fixture.toast).not.toHaveBeenCalled()
})

test("child sessions are never learned from", async () => {
  const sync = mock(async () => {})
  const sessions = [{ id: "session", parentID: "parent", time: { updated: 1 } }]
  const fixture = await setup(sync, [{ id: "task", type: "user", text: "please run tests" }], undefined, "session", sessions)
  fixture.emit("session.execution.started")
  fixture.emit("session.inbox.delivered")
  await settle()
  expect(sync).not.toHaveBeenCalled()
  expect(fixture.learning.snapshot.seen).toEqual([])
})

test("unlisted sessions without root metadata are never persisted", async () => {
  const fixture = await setup(async () => {}, [{ id: "task", type: "user", text: "please run tests" }], undefined, "session", [])
  fixture.emit("session.execution.started")
  await settle()
  expect(fixture.learning.snapshot).toEqual(emptySnapshot())
})

test("a session event after clear still queues a fresh learning pass", async () => {
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  let calls = 0
  const sync = mock(() => (++calls === 1 ? first.promise : second.promise))
  const fixture = await setup(sync)
  await fixture.run("quill.clear")
  fixture.emit("session.inbox.delivered")
  first.resolve()
  await settle()
  expect(sync).toHaveBeenCalledTimes(2)
  fixture.setMessages([{ id: "new", type: "user", text: "please run tests", time: { created: Date.now() + 1000 } }])
  second.resolve()
  await settle()
  expect(fixture.learning.snapshot.seen).toEqual(["session:new"])
})

test("a storage mutation queued before clear cannot restore the old model", async () => {
  const write = Promise.withResolvers<void>()
  const fixture = await setup(async () => {}, [{ id: "old", type: "user", text: "please run tests" }], write.promise)
  await settle()
  fixture.setWriteGate(undefined)
  await fixture.run("quill.clear")
  write.resolve()
  await settle()
  expect(fixture.learning.snapshot).toEqual({ ...emptySnapshot(), clearedAt: expect.any(Number) })
})

test("a queued live event retains warning behavior after a silent backfill fails", async () => {
  const first = Promise.withResolvers<void>()
  let calls = 0
  const sync = mock(async () => {
    if (++calls === 1) await first.promise
    else throw new Error("unavailable")
  })
  const fixture = await setup(sync)
  fixture.emit("session.execution.started")
  first.reject(new Error("unavailable"))
  await settle()
  expect(sync).toHaveBeenCalledTimes(2)
  expect(fixture.toast).toHaveBeenCalledTimes(1)
})

test("shows every option warning in one toast", async () => {
  const fixture = await setup(async () => {}, [], undefined, "home", undefined, undefined, { acceptKeys: ["tab"], summonKeys: ["tab", "a,b"] })
  expect(fixture.toast).toHaveBeenCalledTimes(1)
  expect(fixture.toast).toHaveBeenCalledWith({
    title: "Quill",
    message: "tab in summonKeys ignored: already bound in acceptKeys\na,b in summonKeys ignored: keys must not contain commas",
    variant: "warning",
  })
})
