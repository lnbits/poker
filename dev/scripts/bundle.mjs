import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'

const devDir = process.cwd()
const sdkPath = resolve(devDir, 'src/lnbits-sdk.js')
const entryPath = resolve(devDir, 'src/index.js')
const outPath = resolve(devDir, 'dist/index.bundle.js')

const sdk = await readFile(sdkPath, 'utf8')
const entry = await readFile(entryPath, 'utf8')
const bundledSdk = sdk.replace(/^export const /gm, 'const ')
const bundledEntry = entry.replace(
  /^import \{[^}]+\} from '\.\/lnbits-sdk\.js'\n\n/,
  ''
)

await mkdir(dirname(outPath), {recursive: true})
await writeFile(outPath, `${bundledSdk}\n\n${bundledEntry}`, 'utf8')
