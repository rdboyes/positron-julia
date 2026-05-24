# Julia Extension - Deferred Improvements

This document tracks improvements and features that are out of scope for the initial implementation but should be addressed in future work.

## Console Completions via Jupyter Protocol (RESOLVED)

**Current State**: Runtime completions are **implemented** using `callMethod` → UI comm → `REPL.REPLCompletions`.

### Architecture

```
TypeScript: completions.ts
  → callMethod('complete_request', text, cursorPos)
  → Supervisor: KallichoreSession.callMethod()
  → UI comm JSON-RPC: call_method {method: "complete_request", params: [text, cursorPos]}
  → Julia: ui.jl → call_interpreter_method("complete_request", params)
  → REPL.REPLCompletions.completions(code, cursor_pos)
  → Returns: {matches, cursor_start, cursor_end, status}
```

### Files Modified
- `src/completions.ts` - Completion provider using `callMethod('complete_request', ...)`
- `src/session.ts` - Added `callMethod` delegation to supervisor kernel
- `julia/Positron/src/ui.jl` - Added `handle_complete_request()` using `REPL.REPLCompletions`
- `julia/Positron/src/ui_comm.jl` - Fixed `Param` type alias from `Dict{String,Any}` to `Any`
- `julia/Positron/src/Positron.jl` - Added `using REPL`

## Language Server Improvements

### Connect LanguageServer.jl to Running Session
Currently, the language server runs in a separate Julia process and doesn't have access to runtime state. julia-vscode has a mechanism to connect the language server to the REPL process for runtime-aware completions.

**Reference**: julia-vscode uses a custom RPC mechanism (`repl/getcompletions`) to query the running Julia process.

### Symbol Indexing for Workspace
LanguageServer.jl can index the workspace for better go-to-definition and find-references support. This requires proper configuration of the environment path and project detection.

## Debug Adapter Protocol (DAP) (RESOLVED)

Julia has a debug adapter (`Debugger.jl` / `DebugAdapter.jl`) that could be integrated for breakpoint debugging support.

## Workspace/Project Detection (RESOLVED)

- Detect `Project.toml` / `Manifest.toml` and activate the appropriate environment
- Support for Julia environments in the status bar

## Formatting

- Integrate `JuliaFormatter.jl` for code formatting
- Expose as VS Code format document/selection commands

## Testing (RESOLVED)

- Integration with Julia's `Test` stdlib
- Test discovery and execution in the Test Explorer

## Data Explorer - Code Generation

### convert_to_code Implementation

**Status**: Not implemented

**Description**: Generate Julia code (or dplyr/pandas-style code) from current Data Explorer state (filters, sorts). Allows users to generate reproducible code from interactive exploration.

**Requirements**:
- Generate Julia DataFrames.jl code for filters
- Generate code for sorting operations
- Handle multiple filters with AND/OR conditions
- Generate code for column selections
- Support different code syntax preferences

**Reference**: See Python implementation in `data_explorer.py` for pattern.

**Priority**: Medium (nice-to-have feature, not core functionality)



## IJulia Comm Integration (RESOLVED)

**Status**: Fixed. Comm registration now uses IJulia's type-based dispatch pattern.

See `kernel.jl` — each comm target is registered via:
```julia
function IJulia.register_comm(comm::IJulia.Comm{Symbol("positron.variables")}, msg::IJulia.Msg)
    handle_variables_comm_open(kernel, comm, msg)
end
```
