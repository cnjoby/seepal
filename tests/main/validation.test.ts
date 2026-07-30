import { describe, expect, it } from 'vitest'
import {
  isTrustedRendererUrl,
  requireAbsolutePath,
  requireRecord,
  requireString,
} from '../../src/main/validation.js'

describe('IPC boundary validation', () => {
  it('accepts only absolute paths', () => {
    expect(requireAbsolutePath('/Users/example/project')).toBe(
      '/Users/example/project',
    )
    expect(() => requireAbsolutePath('../project')).toThrow(
      'path must be absolute',
    )
  })

  it('rejects missing and oversized identifiers', () => {
    expect(() => requireString('', 'projectId')).toThrow()
    expect(() => requireString('x'.repeat(513), 'projectId')).toThrow()
    expect(() => requireRecord([])).toThrow()
  })

  it('matches the exact packaged renderer file', () => {
    expect(
      isTrustedRendererUrl(
        'file:///Applications/SeePal.app/Contents/Resources/app.asar/out/renderer/index.html',
        'file:///Applications/SeePal.app/Contents/Resources/app.asar/out/renderer/index.html',
      ),
    ).toBe(true)
    expect(
      isTrustedRendererUrl(
        'file:///tmp/attacker.html',
        'file:///Applications/SeePal.app/Contents/Resources/app.asar/out/renderer/index.html',
      ),
    ).toBe(false)
  })

  it('allows the configured development origin, not arbitrary localhost', () => {
    expect(
      isTrustedRendererUrl(
        'http://localhost:5173/src/renderer/',
        'http://localhost:5173/',
      ),
    ).toBe(true)
    expect(
      isTrustedRendererUrl(
        'http://localhost:5174/',
        'http://localhost:5173/',
      ),
    ).toBe(false)
  })
})
