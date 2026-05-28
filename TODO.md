# Julia Extension - Deferred Improvements

## Profiler

**Status**: Not implemented

Profile data needs to flow from the Julia kernel to TypeScript via a new Positron comm (`positron.profile`), since there is no direct REPL connection (unlike julia-vscode which uses a JSON-RPC `repl/showprofileresult` notification).

**Julia side** — new files in `julia/Positron/src/`:
- `profile.jl` — serialize `Profile.fetch()` into a `ProfilerFrame` tree matching julia-vscode's structure
- `profile_comm.jl` — register `positron.profile` comm target in `kernel.jl`, send serialized data on demand

**TypeScript side**:
- `src/profiler.ts` — `ProfilerFeature` class with WebviewPanel flame graph; `receiveProfileData()` called from `session.ts` when comm message arrives; commands: `julia.openProfiler`, `julia.profileSelection`, `julia.nextProfile`, `julia.previousProfile`, `julia.deleteProfile`, `julia.deleteAllProfiles`
- Wire comm message → `profilerFeature.receiveProfileData()` in `session.ts` (same pattern as `positron.plots`)
- Wire feature activation in `extension.ts`

**Flame graph renderer**: copy `libs/jl-profile/` from julia-vscode (standalone canvas renderer, no external deps). Include pre-compiled `profile-viewer.js` as a webview resource.

**`package.json`**: add the six profiler commands listed above.

---

## Data Explorer — Code Generation

**Status**: Not implemented

Generate reproducible Julia code from the current Data Explorer state (filters, sorts, column selections). See Python implementation in `data_explorer.py` for the pattern.

**Requirements**:
- Generate `DataFrames.jl` code for active filters (including AND/OR conditions)
- Generate code for sort operations and column selections
- Expose via `convert_to_code` in the data explorer comm

**Priority**: Medium

---

## Language Server — Runtime Connection

**Status**: Not implemented

LanguageServer.jl runs in a separate process and has no access to runtime state. julia-vscode bridges this via a custom RPC mechanism (`repl/getcompletions`) that queries the running Julia process for runtime-aware completions.

Connecting the LS to the running session would improve completion quality for variables defined at the REPL.

---

## Formatting

**Status**: Implemented

- Native code formatting is fully supported out-of-the-box via the Julia Language Server (`LanguageServer.jl`), which includes `JuliaFormatter.jl` as a core dependency.
- Enables standard VS Code / Positron commands **Format Document** (`Shift+Alt+F` / `Option+Shift+F`) and **Format Selection** (`Ctrl+K Ctrl+F`) natively without needing a separate process spawning extension.
- Automatically respects workspace-local `.JuliaFormatter.toml` configuration files.

## TODO
The extension currently provides:

- syntax highlighting
- snippets: latex and user-shared snippets
- Julia specific commands
- integrated Julia REPL
- code completion
- hover help
- a linter
- code navigation
- tasks for running tests, builds, benchmarks and build documentation
- a debugger
- a plot gallery
- a grid viewer for tabular data
- integrated support for Weave.jl
