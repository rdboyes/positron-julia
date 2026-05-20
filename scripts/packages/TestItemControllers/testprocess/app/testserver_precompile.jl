@info "Julia test item process precompiling"

import Pkg
version_specific_env_path = joinpath(@__DIR__, "../environments", "v$(VERSION.major).$(VERSION.minor)")
if isdir(version_specific_env_path)
    @static if VERSION >= v"1.6"
        Pkg.activate(version_specific_env_path, io=devnull)
    else
        Pkg.activate(version_specific_env_path)
    end
else
    @static if VERSION >= v"1.6"
        Pkg.activate(joinpath(@__DIR__, "../environments", "fallback"), io=devnull)
    else
        Pkg.activate(joinpath(@__DIR__, "../environments", "fallback"))
    end
end

let
    has_error_handler = false

    try

        if length(ARGS) > 0
            include(ARGS[1])
            has_error_handler = true
        end

        using TestItemServer
    catch err
        bt = catch_backtrace()
        if has_error_handler
            global_err_handler(err, bt, Base.ARGS[2], "Test Process")
        else
            rethrow(err)
        end
    end
end
