#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")
const root = path.resolve(dir, "../..")

type Pkg = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  workspaces?: unknown
}

type Lock = {
  configVersion?: number
}

function json<T>(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T
}

function mod(base: string, name: string) {
  return path.join(base, "node_modules", ...name.split("/"))
}

function linker(): "hoisted" | "isolated" {
  const rootPkg = json<Pkg>(path.join(root, "package.json"))
  const pkg = json<Pkg>(path.join(dir, "package.json"))

  for (const [name, ver] of Object.entries(pkg.dependencies ?? {})) {
    if (ver.startsWith("workspace:")) continue
    if (rootPkg.dependencies?.[name] || rootPkg.devDependencies?.[name]) continue

    const inRoot = fs.existsSync(mod(root, name))
    const inDir = fs.existsSync(mod(dir, name))

    if (inRoot !== inDir) return inRoot ? "hoisted" : "isolated"
  }

  const lock = json<Lock>(path.join(root, "bun.lock"))
  if (lock.configVersion === 0) return "hoisted"
  return rootPkg.workspaces ? "isolated" : "hoisted"
}

process.chdir(dir)

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const link = linker()

await $`bun install --linker=${link} --os="*" --cpu="*" @lydell/node-pty@1.2.0-beta.10`

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
