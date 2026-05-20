# ---------------------------------------------------------------------------------------------
# Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

# Julia Language Server startup script for Positron
#
# This script is spawned by the positron-julia extension to provide
# LSP-based code intelligence features like completion, hover, and diagnostics.
#
# The extension sets JULIA_DEPOT_PATH to point to its own depot where
# LanguageServer.jl is installed.
#
# Usage: julia main.jl <env_path> [--debug]

# Parse command line arguments
env_path = length(ARGS) >= 1 ? ARGS[1] : pwd()
debug_mode = "--debug" in ARGS

# Try to load LanguageServer.jl
try
    @info "Starting Julia Language Server..."
    @info "  Environment path: $env_path"
    @info "  DEPOT_PATH entries: $(DEPOT_PATH)"
    @info "  Debug mode: $debug_mode"

    using LanguageServer
    using SymbolServer

    # Change to the environment directory so LanguageServer finds Project.toml
    if isdir(env_path)
        cd(env_path)
        @info "  Changed working directory to: $(pwd())"
    end

    # Determine the user's depot for package resolution.
    # DEPOT_PATH is set by the extension as [ls_depot, user_depot, ...].
    # The LS depot (first entry) only contains LanguageServer.jl/SymbolServer.jl.
    # User-installed packages (DataFrames, Plots, etc.) live in the user depot.
    # We MUST pass the user depot to runserver() so SymbolServer.jl can
    # locate user packages and build symbol caches for them.
    ls_depot = first(DEPOT_PATH)
    user_depot = get(ENV, "POSITRON_JULIA_USER_DEPOT", "")
    if isempty(user_depot) || !isdir(user_depot)
        # Fallback: second entry in DEPOT_PATH is the user depot
        user_depot = length(DEPOT_PATH) >= 2 ? DEPOT_PATH[2] : ls_depot
    end

    @info "  LS depot (for LanguageServer.jl): $ls_depot"
    @info "  User depot (for package resolution): $user_depot"

    # Symbol server cache goes in the LS depot (isolated from user depot)
    symserver_store_path = joinpath(ls_depot, "symbolstorev5")
    if !ispath(symserver_store_path)
        mkpath(symserver_store_path)
    end
    @info "  Symbol store: $symserver_store_path"

    # Log environment details for debugging
    project_file = joinpath(env_path, "Project.toml")
    manifest_file = joinpath(env_path, "Manifest.toml")
    @info "  Project.toml exists: $(isfile(project_file))"
    @info "  Manifest.toml exists: $(isfile(manifest_file))"

    user_packages_dir = joinpath(user_depot, "packages")
    if isdir(user_packages_dir)
        pkgs = readdir(user_packages_dir)
        preview = join(first(pkgs, 15), ", ")
        @info "  User depot packages ($(length(pkgs))): $(preview)$(length(pkgs) > 15 ? "..." : "")"
    else
        @warn "  User depot packages directory not found: $user_packages_dir"
    end

    # Run the language server.
    # Key: pass user_depot (not ls_depot) so SymbolServer can find user packages.
    runserver(stdin, stdout, env_path, user_depot, nothing, symserver_store_path)
catch e
    @error "Failed to start language server" exception = (e, catch_backtrace())

    if isa(e, ArgumentError) && occursin("Package LanguageServer", string(e))
        @error """
        LanguageServer.jl is not installed in the depot.
        The Positron extension should have installed it automatically.
        Please try reloading the window or check the Julia Language Server output.
        """
    end

    # Exit with error code
    exit(1)
end
