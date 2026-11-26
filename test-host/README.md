# VS Code Extension Host smoke test

Run this test after the extension sources and dependencies are present.

```powershell
$env:VSCODE_EXECUTABLE_PATH = 'C:\\Path\\To\\Microsoft VS Code\\bin\\code.cmd'
node test-host/run-smoke.cjs
```

`VSCODE_EXECUTABLE_PATH` can set an explicit VS Code executable. The runner creates separate user-data, extensions, and workspace directories under the system temporary directory. It launches only the development extension, verifies its public commands, starts OMP, Claude Code, and Codex through local `.cmd` fixtures, then hides and disposes the resulting terminals.

The test invokes the workbench command as well. When that command returns a `WebviewPanel`, the test checks that the panel is visible and disposes it.

To launch the three locally installed CLIs without sending a prompt, run the opt-in process smoke test. It confirms a process for each executable appears while the three terminals coexist, then hides and disposes the terminals. Some CLIs maintain short-lived background processes after their terminal has closed, so the test treats the VS Code terminal-close event as the cleanup boundary.

```powershell
node test-host/run-smoke.cjs --installed
```

This mode requires `omp.exe`, `claude.exe`, and `codex.exe` to be available through `PATH`. The default fixture mode remains suitable for machines without those CLIs.
