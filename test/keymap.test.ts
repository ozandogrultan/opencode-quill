import { expect, test } from "bun:test"
import { completionLayer } from "../src/keymap"
import { parseQuillCommand, resolveOptions } from "../src/options"

test("custom keys replace defaults and are passed to the host keymap", () => {
  const options = resolveOptions({ acceptKeys: ["ctrl+y", "<leader>a"], dismissKeys: ["ctrl+g"] })
  const layer = completionLayer(options, () => undefined)
  expect(layer.mode).toBe("base")
  expect(layer.commands?.map((command) => command.bind)).toEqual(["ctrl+y,<leader>a", "ctrl+g", false, false])
})

test("empty key lists disable bindings instead of restoring defaults", () => {
  const layer = completionLayer(resolveOptions({ acceptKeys: [], dismissKeys: [] }), () => undefined)
  expect(layer.commands?.map((command) => command.bind)).toEqual([false, false, false, false])
})

test("commands fall through without an eligible suggestion", () => {
  let visible = false
  let eligible = false
  const suggestion = { visible: () => visible, accept: () => eligible, dismiss: () => eligible, canCycle: () => visible, cycle: () => eligible }
  const layer = completionLayer(resolveOptions({}), () => suggestion)
  for (const command of layer.commands!) {
    expect((command.enabled as () => boolean)()).toBe(false)
    expect(command.run()).toBe(false)
    visible = true
    expect((command.enabled as () => boolean)()).toBe(true)
    expect(command.run()).toBe(false)
    eligible = true
    expect(command.run()).toBeUndefined()
    visible = false
    eligible = false
  }
})

test("option parsing preserves host syntax and rejects invalid input", () => {
  expect(resolveOptions({})).toEqual({ enabled: true, completeAtLineEnd: false, completeShell: true, acceptKeys: ["tab", "right"], dismissKeys: ["escape"], cycleNextKeys: [], cyclePreviousKeys: [] })
  expect(resolveOptions({ completeAtLineEnd: true }).completeAtLineEnd).toBe(true)
  expect(resolveOptions({ acceptKeys: [" ctrl+y ", "ctrl+y"] }).acceptKeys).toEqual(["ctrl+y"])
  for (const input of [{ enabled: "yes" }, { completeAtLineEnd: "yes" }, { completeAtLineEnd: 1 }, { acceptKeys: false }, { acceptKeys: [""] }, { dismissKeys: [1] }, { cycleNextKeys: "tab" }, { cyclePreviousKeys: [null] }]) {
    expect(() => resolveOptions(input)).toThrow()
  }
})

test("cycle commands have no default bindings and custom keys preserve direction", () => {
  const directions: number[] = []
  const suggestion = { visible: () => true, accept: () => true, dismiss: () => true, canCycle: () => true, cycle: (direction: 1 | -1) => { directions.push(direction); return true } }
  const layer = completionLayer(resolveOptions({ cycleNextKeys: ["alt+n"], cyclePreviousKeys: ["alt+p"] }), () => suggestion)
  for (const [id, binding] of [["quill.next", "alt+n"], ["quill.previous", "alt+p"]]) {
    const command = layer.commands!.find((command) => command.id === id)!
    expect(command.bind).toBe(binding)
    expect(command.palette).toBeUndefined()
    expect(command.run()).toBeUndefined()
  }
  expect(directions).toEqual([1, -1])
})

test("parses quill slash commands into toggle, explicit enable, and clear", () => {
  expect(parseQuillCommand(undefined)).toEqual({ type: "toggle" })
  expect(parseQuillCommand("")).toEqual({ type: "toggle" })
  expect(parseQuillCommand("toggle")).toEqual({ type: "toggle" })
  expect(parseQuillCommand("on")).toEqual({ type: "enable", value: true })
  expect(parseQuillCommand("off")).toEqual({ type: "enable", value: false })
  expect(parseQuillCommand("clear")).toEqual({ type: "clear" })
  expect(parseQuillCommand("reset")).toEqual({ type: "clear" })
  expect(parseQuillCommand("clear casing")).toEqual({ type: "casing" })
  expect(parseQuillCommand("RESET CASING")).toEqual({ type: "casing" })
  expect(parseQuillCommand("unknown")).toEqual({ type: "invalid" })
})
