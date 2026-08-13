import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'

const uiSource = readFileSync(new URL('../components/ui.tsx', import.meta.url), 'utf8')
const reviewPanelSource = readFileSync(
  new URL('../components/ReviewPanel.tsx', import.meta.url),
  'utf8',
)

describe('native sheet layout contract', () => {
  test('keeps native sheet ownership in the shared UI component', () => {
    const nativeSheetOwners = readProductionSources(new URL('../', import.meta.url))
      .filter(({ source }) => source.includes('@lodev09/react-native-true-sheet'))
      .map(({ path }) => path)

    expect(nativeSheetOwners).toEqual(['components/ui.tsx'])
  })

  test('isolates the screen-sized native sheet node from scroll content layout', () => {
    expect(uiSource).toMatch(
      /<View collapsable=\{false\} pointerEvents="box-none" style=\{styles\.sheetHost\}>\s*<TrueSheet/,
    )

    const sheetHostStyle = extractStyle(uiSource, 'sheetHost')
    expect(sheetHostStyle).toMatch(/\bposition:\s*'absolute'/)
    expect(sheetHostStyle).toMatch(/\btop:\s*0/)
    expect(sheetHostStyle).toMatch(/\bleft:\s*0/)
    expect(sheetHostStyle).toMatch(/\bwidth:\s*0/)
    expect(sheetHostStyle).toMatch(/\bheight:\s*0/)
  })

  test('shows the compact table label once and bounds it to one line', () => {
    expect(reviewPanelSource.match(/team\.tableLabel/g) ?? []).toHaveLength(1)
    expect(reviewPanelSource).toMatch(
      /<Text ellipsizeMode="tail" numberOfLines=\{1\} style=\{styles\.eyebrow\}>\s*\{review\.team\.tableLabel \?\? 'No table yet'\}\s*<\/Text>/,
    )
  })
})

function extractStyle(source: string, name: string) {
  const match = source.match(new RegExp(`\\b${name}:\\s*\\{([^}]*)\\}`))
  expect(match, `${name} style is missing`).not.toBeNull()
  return match?.[1] ?? ''
}

function readProductionSources(directory: URL, prefix = ''): { path: string; source: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory)
    if (entry.isDirectory()) return readProductionSources(url, `${path}/`)
    if (
      (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) ||
      entry.name.includes('.test.')
    ) {
      return []
    }
    return [{ path, source: readFileSync(url, 'utf8') }]
  })
}
