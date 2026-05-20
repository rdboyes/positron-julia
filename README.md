# Julia for Positron

Julia language support for [Positron](https://github.com/posit-dev/positron). The project is a fork of a [PR](https://github.com/posit-dev/positron/pull/11108) made by @wesm

<p align="center">
  <img src="resources/branding/julia-logo.png" alt="Julia Logo" width="240">
</p>

## Features

- **Julia Runtime** — Start interactive Julia sessions directly in Positron's Console. Define variables, run code, and inspect results with the Variables pane and Data Explorer.
- **Language Server** — Powered by [LanguageServer.jl](https://github.com/julia-vscode/LanguageServer.jl) for diagnostics, completions, go-to-definition, hover info, and more. Automatically installed on first use.
- **Runtime Completions** — Supplements LSP completions with live variables and functions from the running Julia session via the Jupyter `complete_request` protocol.
- **Run Multiline Statements** — Press `Ctrl+Enter` / `Cmd+Enter` to send the full multiline statement at the cursor (functions, loops, blocks) to the console. Handles `function…end`, `if…end`, unclosed brackets, pipe chains, and more.
- **Semantic Highlighting** — Enhanced syntax highlighting with semantic information from the Language Server for accurate color coding of functions, types, modules, and other language constructs.
- **Data Explorer** — Open DataFrames, matrices, and other tabular data in Positron's interactive Data Explorer with sorting, filtering, and summary statistics.
- **Variables Pane** — Browse all session variables with type and value summaries.
- **Help Integration** — View Julia documentation inline via Positron's Help pane.
- **Plots** — Julia plots are captured and displayed in Positron's Plots pane.
- **Package Pane** — Browse and manage Julia packages directly within Positron.

## Requirements

- [Positron IDE](https://github.com/posit-dev/positron) (2026.02 or later)
- [Julia](https://julialang.org/downloads/) 1.10 or later

## Getting Started

1. Install Julia from [julialang.org](https://julialang.org/downloads/) or via [juliaup](https://github.com/JuliaLang/juliaup).
2. Install this extension in Positron (Extensions view → Install from VSIX, or from the marketplace).
3. Open a `.jl` file or start a Julia console session from the interpreter picker.

On first launch, the extension automatically installs required Julia packages (`IJulia`, `LanguageServer.jl`, and supporting dependencies). This one-time setup may take a few minutes.

## Extension Settings

| Setting                                         | Default | Description                                                 |
| ----------------------------------------------- | ------- | ----------------------------------------------------------- |
| `positron.julia.executablePath`                 | `""`    | Path to a specific Julia executable                         |
| `positron.julia.languageServer.enabled`         | `true`  | Enable/disable the Julia Language Server                    |
| `positron.julia.languageServer.environmentPath` | `""`    | Path to a Julia project environment for the Language Server |
| `julia.lint.missingrefs`                        | `"all"` | Control missing-reference diagnostics (`all`, `id`, `none`) |



## License

Elastic License 2.0 — see [LICENSE](LICENSE).
