import type { KeymapLayer } from "@opencode/plugin/tui/context"
import type { Options } from "./options"

type Suggestion = { visible(): boolean; accept(): boolean; dismiss(): boolean; canCycle(): boolean; cycle(direction: 1 | -1): boolean; summon(): boolean }

export function completionLayer(options: Options, suggestion: () => Suggestion | undefined): KeymapLayer {
  return {
    mode: "base",
    priority: 2,
    commands: [
      {
        id: "quill.accept",
        title: "Accept word suggestion",
        bind: options.acceptKeys.length ? options.acceptKeys.join(",") : false,
        enabled: () => suggestion()?.visible() === true,
        run: () => suggestion()?.accept() ? undefined : false,
      },
      {
        id: "quill.dismiss",
        title: "Dismiss word suggestion",
        bind: options.dismissKeys.length ? options.dismissKeys.join(",") : false,
        enabled: () => suggestion()?.visible() === true,
        run: () => suggestion()?.dismiss() ? undefined : false,
      },
      ...([["next", 1, options.cycleNextKeys], ["previous", -1, options.cyclePreviousKeys]] as const).map(([name, direction, keys]) => ({
        id: `quill.${name}`,
        title: `${name === "next" ? "Next" : "Previous"} word suggestion`,
        bind: keys.length ? keys.join(",") : false as const,
        enabled: () => suggestion()?.canCycle() === true,
        run: () => suggestion()?.cycle(direction) ? undefined : false,
      })),
      {
        id: "quill.summon",
        title: "Summon word suggestions",
        bind: options.summonKeys.length ? options.summonKeys.join(",") : false,
        run: () => suggestion()?.summon() ? undefined : false,
      },
    ],
  }
}
