/**
 * Reasoning-level presets, read from data/presets.json.
 *
 * A preset is a complete `reasoningEfforts` dictionary: the levels a model
 * offers and the wire value DSH sends for each. It is a guess about what a
 * channel accepts, so a preset is only ever applied on request, or by the
 * `reasoningPreset` setting when the sources agree that the model reasons but
 * name no level.
 */
import { readFileSync } from 'node:fs'

import { LEVEL_ORDER } from './detect.js'

const PRESET_ID = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Check a `reasoningEfforts` dictionary the way DSH does: known levels only, a
 * wire value for every level except `off`, and at least one level besides `off`.
 * @returns a detached copy in escalation order, or `undefined` when invalid.
 */
export function cleanEfforts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const clean = {}
  for (const key of Object.keys(value)) if (!LEVEL_ORDER.includes(key)) return undefined
  for (const level of LEVEL_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(value, level)) continue
    const wire = value[level]
    if (wire === null) {
      if (level !== 'off') return undefined
    } else if (typeof wire !== 'string' || wire.length === 0 || wire.length > 64 || /[\u0000-\u001f]/.test(wire)) return undefined
    clean[level] = wire
  }
  return Object.keys(clean).some((level) => level !== 'off') ? clean : undefined
}

export function readPresets(file = new URL('../data/presets.json', import.meta.url)) {
  let rows
  try { rows = JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
  if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) return {}
  const presets = {}
  for (const [id, row] of Object.entries(rows)) {
    if (!PRESET_ID.test(id) || id === 'none') continue
    const efforts = cleanEfforts(row?.efforts)
    if (efforts !== undefined) presets[id] = Object.freeze({ description: typeof row.description === 'string' ? row.description : id, efforts: Object.freeze(efforts) })
  }
  return presets
}

export const PRESETS = Object.freeze(readPresets())
export const PRESET_IDS = Object.freeze(Object.keys(PRESETS))

/**
 * The levels DSH's model page writes when its reasoning switch is turned on, before
 * anyone has chosen anything. It is a starting point, not a decision, so a row that
 * still holds exactly this and that the plugin did not write is treated as unfilled
 * (see `isPlaceholder` and the merge rules in plan.js).
 */
const DSH_TEMPLATE = Object.freeze({ off: null, low: 'low', medium: 'medium', high: 'high' })

/** Whether `value` is exactly the template the model page writes, in any key order. */
export function isDshTemplate(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === Object.keys(DSH_TEMPLATE).length
    && keys.every((level) => Object.prototype.hasOwnProperty.call(DSH_TEMPLATE, level) && value[level] === DSH_TEMPLATE[level])
}

/** A fresh copy of one preset's dictionary, or `undefined` for an unknown id. */
export const presetEfforts = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, id) ? structuredClone(PRESETS[id].efforts) : undefined)

/** What the settings page needs to label each preset; no wire values. */
export const describePresets = () => Object.fromEntries(Object.entries(PRESETS)
  .map(([id, preset]) => [id, { description: preset.description, levels: Object.keys(preset.efforts) }]))
