if VERSION < v"1.10.0"
    error("Julia test item controller requires Julia 1.10.0 or newer")
end

@info "Starting Julia test item controller on Julia $VERSION"

import Pkg
version_specific_env_path = joinpath(@__DIR__, "..", "environments", "testitemcontroller", "v$(VERSION.major).$(VERSION.minor)")
if isdir(version_specific_env_path)
    Pkg.activate(version_specific_env_path; io=devnull)
else
    Pkg.activate(joinpath(@__DIR__, "..", "environments", "testitemcontroller", "fallback"); io=devnull)
end

using Logging
global_logger(ConsoleLogger(stderr))

try
    global conn_in = stdin
    global conn_out = stdout
    redirect_stdout(stderr)
    redirect_stdin()

    using TestItemControllers

    controller = JSONRPCTestItemController(conn_in, conn_out, nothing)
    run(controller)
catch err
    @error "Test Item Controller crashed" exception=(err, catch_backtrace())
    exit(1)
end
