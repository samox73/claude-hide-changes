import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const isHidden = { plugin: 'hide-file-changes', key: 'isHidden' } as const
const isExpanded = { plugin: 'hide-file-changes', key: 'isExpanded' } as const
type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
type Patch = { lines: string[] }[]
// Bash results carry a diff of the files the command changed (bashEditDiffEnabled), absent from the published types
type BashDiff = { files: { filePath: string; hunks: Hunk[]; deleted?: boolean }[]; moreFiles?: number; changedFiles?: string[] }
type BashOutput = { bashEditDiff?: BashDiff }

// unified-diff source for Code; Code takes no control characters but tab and newline
const unified = (hunks: Hunk[]) =>
  hunks
    .map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`)
    .join('\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

const tally = (patch: Patch): [number, number] => {
  const lines = patch.flatMap(h => h.lines)
  return [lines.filter(l => l.startsWith('+')).length, lines.filter(l => l.startsWith('-')).length]
}

// +N -M from the result's hunks; a Write that created a file may carry none
const counts = (tool: string, output: unknown): [number, number] | undefined => {
  if (tool === 'NotebookEdit') {
    return undefined
  }
  if (tool === 'Bash') {
    return tally(((output as BashOutput).bashEditDiff?.files ?? []).flatMap(f => f.hunks))
  }
  const o = output as { structuredPatch?: Patch; type?: string; content?: string }
  const patch = o.structuredPatch ?? []
  if (patch.length === 0 && o.type === 'create' && typeof o.content === 'string') {
    return [o.content.split('\n').length, 0]
  }
  return tally(patch)
}

// the git root when the session runs inside a repository, else the working directory
const workspace = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()
  const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  return git?.exitCode === 0 && git.stdout.trim() ? git.stdout.trim() : cwd
}

const USAGE = 'Usage: /hide-changes [on|off|toggle] [save]   (save: remember as this workspace\'s default)'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hide-changes',
      description: 'Hide/show Edit/Write/Bash file diffs: [on|off|toggle] [save]',
      argumentHint: '[on|off|toggle] [save]',
    })
    // version 0 = fresh session, not a hot reload: seed from the workspace default
    if ((await $.state.get(isHidden)).version === 0) {
      const saved = await $.store.get(`workspace:${await workspace($)}`)
      await $.state.set(isHidden, saved === true)
    }

    return next(e)
  })

  on('command.run', { command: 'hide-changes' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const save = words.includes('save')
    const mode = words.filter(w => w !== 'save')
    if (mode.length > 1 || (mode[0] && !['on', 'off', 'toggle'].includes(mode[0]))) {
      return { text: USAGE }
    }

    const { value: current = false } = await $.state.get(isHidden)
    // bare `/hide-changes` toggles; `/hide-changes save` just saves the current value
    const next = mode[0] === 'on' ? true : mode[0] === 'off' ? false : mode[0] === 'toggle' || !save ? !current : current
    await $.state.set(isHidden, next)

    const root = save ? await workspace($) : ''
    if (save) {
      await $.store.set(`workspace:${root}`, next)
    }

    return {
      text: `File-change diffs ${next ? 'hidden' : 'shown'} for this session${save ? `; saved as default for ${root}` : ''}.`,
    }
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const bash = e.props.tool === 'Bash' ? (e.props.output as BashOutput | undefined) : undefined
    if ((!FILE_TOOLS.has(e.props.tool) && bash?.bashEditDiff === undefined) || e.props.isErrored) {
      return next(e)
    }
    // reads subscribe this row, so toggling redraws rows already on screen
    const { value = false } = await $.state.get(isHidden)
    if (!value) {
      return next(e)
    }

    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const row = { ...isExpanded, id: e.props.tool_use_id }
    const { value: isOpen = false } = await $.state.get(row)
    const cwd = await $.session.cwd()
    const rel = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
    const o = e.props.output as { filePath?: string; notebook_path?: string; edit_mode?: string; cell_id?: string }
    const diff = bash?.bashEditDiff
    const names = diff ? (diff.changedFiles ?? diff.files.map(f => f.filePath)).map(rel) : [rel(o.filePath ?? o.notebook_path ?? '')]
    const n = counts(e.props.tool, e.props.output)
    // clicking the summary opens or closes this row's diff
    const toggle = (
      <Button key="toggle" plain onPress={() => void update($, row, open => !open)}>
        <Text>{names.length > 3 ? `${names.slice(0, 2).join(', ')}, +${names.length - 2} more` : names.join(', ')} </Text>
        {n ? (
          <Text>
            <Text color="success">+{n[0]}</Text> <Text color="error">-{n[1]}</Text>
          </Text>
        ) : (
          <Text dimColor>
            {o.edit_mode ?? 'edited'} cell {o.cell_id ?? ''}
          </Text>
        )}
        <Text dimColor>{isOpen ? ' ▾' : ' ▸'}</Text>
      </Button>
    )

    if (!bash || !diff) {
      return isOpen ? (
        <Box flexDirection="column">
          {toggle}
          {await next(e)}
        </Box>
      ) : (
        toggle
      )
    }

    // Bash: the engine draws stdout/stderr without the diff; the diff is drawn here, under the summary
    const { bashEditDiff: _, ...output } = bash
    return (
      <Box flexDirection="column">
        {await next({ ...e, props: { ...e.props, output } })}
        {toggle}
        {isOpen &&
          diff.files.map(f => (
            <Box flexDirection="column">
              {diff.files.length > 1 && <Text dimColor>{rel(f.filePath)}</Text>}
              {f.deleted ? <Text dimColor>deleted</Text> : <Code format="diff" path={f.filePath} source={unified(f.hunks)} />}
            </Box>
          ))}
        {isOpen && (diff.moreFiles ?? 0) > 0 && <Text dimColor>+{diff.moreFiles} more files not diffed</Text>}
      </Box>
    )
  })
}
