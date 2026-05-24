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

**Status**: Not implemented

- Integrate `JuliaFormatter.jl` as a format provider
- Expose as VS Code "Format Document" and "Format Selection" commands
