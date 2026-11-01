/** Crash-safe file replacement shared by the cache and settings writers. */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write `text` to a temporary sibling and rename it over `file`, so a reader
 * (or a crash) never sees a half-written file.
 * @param file - destination path; its directory is created when missing.
 * @param text - UTF-8 content.
 * @param mode - optional permission bits for the new file.
 */
export async function writeFileAtomic(file, text, mode) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  try {
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
