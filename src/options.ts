export type Options = { enabled: boolean; completeAtLineEnd: boolean; completeShell: boolean; minSuggestedWordLength: number; acceptKeys: string[]; dismissKeys: string[]; cycleNextKeys: string[]; cyclePreviousKeys: string[]; summonKeys: string[]; warnings: string[] }

function keys(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string" || !key.trim())) {
    throw new Error(`Quill ${name} must be an array of non-empty keybindings`)
  }
  const seen = new Set<string>()
  return value.map((key: string) => key.trim()).filter((key) => !seen.has(key.toLowerCase()) && seen.add(key.toLowerCase()))
}

export function resolveOptions(input: Readonly<Record<string, unknown>>): Options {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Quill enabled must be a boolean")
  if (input.completeAtLineEnd !== undefined && typeof input.completeAtLineEnd !== "boolean") throw new Error("Quill completeAtLineEnd must be a boolean")
  if (input.completeShell !== undefined && typeof input.completeShell !== "boolean") throw new Error("Quill completeShell must be a boolean")
  if (input.minSuggestedWordLength !== undefined && (typeof input.minSuggestedWordLength !== "number" || !Number.isInteger(input.minSuggestedWordLength) || input.minSuggestedWordLength < 0)) throw new Error("Quill minSuggestedWordLength must be a non-negative integer")
  const defaults = { acceptKeys: ["tab", "right"], dismissKeys: ["escape"], cycleNextKeys: [], cyclePreviousKeys: [], summonKeys: [] } as Record<string, string[]>
  const warnings: string[] = []
  const bindings: Record<string, string[]> = {}
  const owners = new Map<string, string>()
  const claim = (name: string, list: string[], warn: boolean) => {
    for (const key of list) {
      const owner = owners.get(key.toLowerCase())
      if (key.includes(",")) {
        if (warn) warnings.push(`${key} in ${name} ignored: keys must not contain commas`)
      } else if (owner) {
        if (warn) warnings.push(`${key} in ${name} ignored: already bound in ${owner}`)
      } else {
        owners.set(key.toLowerCase(), name)
        bindings[name].push(key)
      }
    }
  }
  const given = Object.keys(defaults).filter((name) => input[name] !== undefined)
  const lists = Object.fromEntries(Object.keys(defaults).map((name) => [name, keys(input[name], defaults[name], name)]))
  for (const name of Object.keys(defaults)) bindings[name] = []
  for (const name of given) claim(name, lists[name], true)
  for (const name of Object.keys(defaults)) if (!given.includes(name)) claim(name, lists[name], false)
  for (const name of Object.keys(defaults)) {
    if (!given.includes(name) && defaults[name].length && !bindings[name].length) warnings.push(`${name} left without keys: its defaults (${defaults[name].join(", ")}) are bound to other actions`)
  }
  return {
    enabled: input.enabled !== false,
    completeAtLineEnd: input.completeAtLineEnd === true,
    completeShell: input.completeShell !== false,
    minSuggestedWordLength: input.minSuggestedWordLength ?? 0,
    acceptKeys: bindings.acceptKeys,
    dismissKeys: bindings.dismissKeys,
    cycleNextKeys: bindings.cycleNextKeys,
    cyclePreviousKeys: bindings.cyclePreviousKeys,
    summonKeys: bindings.summonKeys,
    warnings,
  }
}

export type QuillCommand =
  | { type: "toggle" }
  | { type: "enable"; value: boolean }
  | { type: "clear" }
  | { type: "shell"; value: boolean }
  | { type: "casing" }
  | { type: "invalid" }

export function parseQuillCommand(input: string | undefined): QuillCommand {
  const raw = input?.trim().toLowerCase() ?? ""
  if (!raw || raw === "toggle") return { type: "toggle" }
  if (raw === "clear" || raw === "reset") return { type: "clear" }
  if (raw === "clear casing" || raw === "reset casing") return { type: "casing" }
  if (raw === "on") return { type: "enable", value: true }
  if (raw === "off") return { type: "enable", value: false }
  if (raw === "shell on") return { type: "shell", value: true }
  if (raw === "shell off") return { type: "shell", value: false }
  return { type: "invalid" }
}
