// tsc copies no assets; the icons ride beside the compiled nodes and credentials.
import { cpSync } from 'node:fs'
for (const f of ['billos.svg', 'billos.dark.svg']) {
  cpSync(`nodes/Billos/${f}`, `dist/nodes/Billos/${f}`)
  cpSync(`nodes/Billos/${f}`, `dist/credentials/${f}`)
}
