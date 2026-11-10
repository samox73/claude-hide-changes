
/** Whether Edit/Write/NotebookEdit and Bash file diffs are hidden this session. */
export type IsHidden = boolean

declare module 'claude-code' {
  interface PluginState {
    // isExpanded: a hidden row the person clicked open, by tool_use_id
    'hide-file-changes': { isHidden: IsHidden; isExpanded: StateFamily<boolean> }
  }
}
