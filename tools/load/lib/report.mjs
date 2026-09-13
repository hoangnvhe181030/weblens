import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const reportDirectory = path.join(workspaceRoot, 'tmp', 'load')

export async function writeReport(scenario, report) {
  await mkdir(reportDirectory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `${stamp}-${safeName(scenario)}.json`
  const target = path.join(reportDirectory, filename)
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return target
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'result'
}
