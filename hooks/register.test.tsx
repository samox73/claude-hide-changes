import { test, expect } from 'claude-code/testing'

const PATCH = { filePath: '/repo/sub/main.tex', structuredPatch: [{ lines: [' ctx', '-old', '+new', '+more'] }] }
const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] }
const BASH = {
  stdout: 'ok',
  stderr: '',
  interrupted: false,
  bashEditDiff: { files: [{ filePath: '/repo/sub/main.fls', hunks: [HUNK] }], moreFiles: 0, changedFiles: ['/repo/sub/main.fls'] },
}

const row = (tool: string, isErrored = false, output: unknown = PATCH) => ({
  plugin: 'hide-file-changes',
  component: 'ToolResult' as const,
  props: { tool_use_id: 't1', tool, output, isErrored },
})

const setup = async ($: any, on: any, git: { exitCode: number; stdout: string }, stored: Record<string, unknown> = {}) => {
  // stands in for the engine's own renderer beneath the mod
  on('ui.render', { component: 'ToolResult' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    const o = e.props.output
    return <Text>{[o.stdout, (o.structuredPatch || o.bashEditDiff) && 'Updated file'].filter(Boolean).join(' ')}</Text>
  })
  const saved: unknown[] = []
  on('store.set', ($: any, e: any) => (saved.push(e), { value: undefined }))
  on('store.get', ($: any, e: any) => ({ value: stored[e.key] }))
  on('process.run', () => ({ value: { ...git, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/repo/sub' }))
  on('session.cwd', () => ({ value: '/repo/sub' }))
  await $.session.start({ source: 'startup', cwd: '/repo/sub' })

  const shown = async (tool: string, isErrored?: boolean, output?: unknown) => {
    const ui = await $.ui.mount({ surface: 'terminal', ...row(tool, isErrored, output) })
    const found = await ui.find({ type: 'Text', text: /Updated/ })
    await ui.unmount()
    return found !== undefined
  }
  const summary = async (tool: string, output?: unknown) => {
    const ui = await $.ui.mount({ surface: 'terminal', ...row(tool, false, output) })
    const texts = [await ui.find({ type: 'Text', text: /^\+\d+$/ }), await ui.find({ type: 'Text', text: /^-\d+$/ })]
    await ui.unmount()
    return texts.map((t: any) => t?.text).join(' ')
  }
  const run = (args: string) => $.command.run({ command: 'hide-changes', args })
  return { saved, shown, summary, run }
}

test('off by default; toggles; saves keyed by git root', async ($, on) => {
  const { saved, shown, summary, run } = await setup($, on, { exitCode: 0, stdout: '/repo\n' })

  expect(await shown('Edit')).toBe(true)
  expect(await shown('Bash', false, BASH)).toBe(true)

  await run('')
  expect(await shown('Edit')).toBe(false)
  expect(await shown('Write')).toBe(false)
  expect(await shown('Edit', true)).toBe(true)
  expect(await shown('Bash')).toBe(true)
  expect(await shown('Bash', false, BASH)).toBe(false)
  const ui = await $.ui.mount({ surface: 'terminal', ...row('Bash', false, BASH) })
  expect(await ui.find({ type: 'Text', text: /^ok$/ })).toBeDefined()
  await ui.unmount()

  // the summary names the file; clicking it opens the diff below it, clicking again closes it
  const edit = await $.ui.mount({ surface: 'terminal', ...row('Edit') })
  expect(await edit.find({ type: 'Text', text: /^main\.tex $/ })).toBeDefined()
  await edit.press({ key: 'toggle' })
  expect(await edit.find({ type: 'Text', text: /Updated/ })).toBeDefined()
  await edit.press({ key: 'toggle' })
  expect(await edit.find({ type: 'Text', text: /Updated/ })).toBeUndefined()
  await edit.unmount()

  const bash = await $.ui.mount({ surface: 'terminal', ...row('Bash', false, BASH) })
  expect(await bash.find({ type: 'Text', text: /^main\.fls $/ })).toBeDefined()
  expect(await bash.find({ type: 'Code' })).toBeUndefined()
  await bash.press({ key: 'toggle' })
  const order = (await bash.findAll({})).map(el => el.type)
  expect(order.indexOf('Code')).toBeGreaterThan(order.indexOf('Button'))
  await bash.press({ key: 'toggle' })
  expect(await bash.find({ type: 'Code' })).toBeUndefined()
  await bash.unmount()

  expect(await summary('Edit')).toBe('+2 -1')
  expect(await summary('Write', { type: 'create', content: 'a\nb\nc', structuredPatch: [] })).toBe('+3 -0')
  expect(saved).toEqual([])

  await run('on save')
  expect(saved).toEqual([{ key: 'workspace:/repo', value: true }])
  expect((await run('bogus')).text).toContain('Usage')
})

test('a saved workspace default seeds the session', async ($, on) => {
  const { shown } = await setup($, on, { exitCode: 0, stdout: '/repo\n' }, { 'workspace:/repo': true })
  expect(await shown('Edit')).toBe(false)
})

test('outside git, keys by the working directory', async ($, on) => {
  const { saved, run } = await setup($, on, { exitCode: 128, stdout: '' })
  await run('on save')
  expect(saved).toEqual([{ key: 'workspace:/repo/sub', value: true }])
})
