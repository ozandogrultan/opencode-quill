import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

test("tagged release rejects a manifest mismatch before querying npm", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/release.yml"), "utf8")
  const script = workflow.split("id: published\n        run: |\n")[1].split("\n      - name:")[0].replace(/^          /gm, "")
  const root = mkdtempSync(join(tmpdir(), "quill-release-"))
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "quill-test", version: "1.2.3" }))
    writeFileSync(join(root, "npm"), '#!/bin/sh\necho "npm-called" > npm-called\nexit 0\n', { mode: 0o755 })
    const run = (tag: string) => spawnSync("bash", ["-e", "-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, TAG: tag, GITHUB_OUTPUT: join(root, "output"), PATH: `${root}:${process.env.PATH}` } })
    const mismatch = run("v9.9.9")
    expect(mismatch.status).not.toBe(0)
    expect(mismatch.stdout + mismatch.stderr).toContain("does not match")
    expect(mismatch.stdout).not.toContain("already on npm")
    expect(existsSync(join(root, "npm-called"))).toBe(false)
    expect(run("v1.2.3").status).toBe(0)
    expect(readFileSync(join(root, "output"), "utf8")).toBe("exists=1\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
