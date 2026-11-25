# YAAT UI Zen

## The 9 Axioms

1. Grow from the existing grain; refine, do not redesign.
2. Quiet chrome; show what people can do, and keep the action they are using within reach.
3. Make state legible; spend emphasis on what needs attention now.
4. Attach metadata to its entity, never to a wrapper box.
5. Expand detail where it is read; interrupt only when the task requires it.
6. Align what people read, not the boxes they hit; separate with space and hairlines before adding a frame or a second tint.
7. Judge spacing by the boundaries and marks visible in each state and theme.
8. Keep backend bounds in data and protocol, out of user choreography.
9. Reuse the token and control vocabulary; green logic tests never excuse visual drift.

## Vocabulary & Reference Map

- **Type scale:** list, sidebar, side-panel, and board text uses `--fs-name`, `--fs-text`, `--fs-meta`, and `--fs-tag` (with mobile step-up in `@media (max-width: 768px), (max-height: 500px)`) in `webview/src/styles.css`.
- **Host surfaces:**
  - Inline reading-stream expansion: `EventItem` and `SubAgentItem` in `webview/src/chat/messages.tsx`.
  - Companion files, diffs, and entities: `SidePanel` (`.side-panel` in `webview/src/styles.css`, `webview/src/panels/SidePanel.tsx`), such as `FilesPanel` (`webview/src/panels/FilesPanel.tsx`) and `ChangesList` / `DiffView` (`webview/src/panels/ChangesView.tsx`).
  - Blocking tasks only (confirmations and required input): `DialogFrame` (`.dialog` in `webview/src/styles.css`, `webview/src/workspace/DialogFrame.tsx`).
- **Controls:**
  - Inline low-noise actions: `.btn-inline`, `.panel-btn` in `webview/src/styles.css`.
  - Standalone form, primary, and destructive actions: `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost` in `webview/src/styles.css`.
  - Filters: `FilterChip` (`.bp-chip`) in `webview/src/project/parts.tsx`.
- **Optical & touch geometry:** expand mobile touch hit targets without bloating card padding (`.ap-toggle` in `webview/src/styles.css`), evaluated by visible marks and state-specific boundaries rather than invisible hit boxes.
- **Nested flatness:** strip inner background tint inside already-tinted status containers (`background: transparent` inside `.subagent-item` via `.subagent-item .subagent-item` and `.subagent-details` rules), while un-tinted containers like `.ap-session` may still distinguish inner focus blocks such as `.ap-work`.

## Engineering Loop

- **Task scoping (only when visible UI/interaction changes):** state the host surface (where it is triggered, where it is read, and which existing primitive it reuses). Skip for pure backend/protocol tasks.
- **Static & geometry guards:** protect vocabulary tokens, primitives, contrast, and spacing symmetry without brittle blanket regexes, and state explicitly whether a geometry test measures element boxes or visible marks/sections (`webview/tests/ui-vocabulary.test.ts`, `webview/tests/browser/theme-contrast.browser.test.ts`, `webview/tests/browser/border-symmetry.browser.test.tsx`).
- **Review & visual check:** review `webview/` UI diffs against `docs/UI_ZEN.md` and verify rendered light/dark desktop/mobile output. Litmus test: _"paginating subagent output bounds data fetching; it never relocates where the user reads."_
