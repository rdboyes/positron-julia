module TestItemServer

include("pkg_imports.jl")

import .JSONRPC: @dict_readable
import .CoverageTools: LCOV, amend_coverage_from_src!
import Test, Pkg, Sockets

include("../../../shared/testserver_protocol.jl")
include("helper.jl")
include("vscode_testset.jl")

mutable struct Testsetup
    name::String
    kind::Symbol
    uri::String
    line::Int
    column::Int
    code::String
    evaled::Bool
end

mutable struct TestProcessState{ERR_HANDLER<:Union{Function,Nothing}}
    endpoint::JSONRPC.JSONRPCEndpoint
    err_handler::ERR_HANDLER

    test_setups::Dict{Tuple{String,Symbol},Testsetup}
    mode::String
    coverage_root_uris::Union{Nothing,Vector{String}}

    testitems_channel::Channel{Vector{TestItemServerProtocol.RunTestItem}}
    stolen_testitem_ids_channel::Channel{Vector{String}}

    function TestProcessState(endpoint::JSONRPC.JSONRPCEndpoint, err_handler::ERR_HANDLER = nothing) where {ERR_HANDLER<:Union{Function,Nothing}}
        return new{ERR_HANDLER}(
            endpoint,
            err_handler,
            Dict{Tuple{String,Symbol},Testsetup}(),
            "",
            nothing,
            Channel{Vector{TestItemServerProtocol.RunTestItem}}(Inf),
            Channel{Vector{String}}(Inf)
        )
    end
end

const DEBUG_SESSION = Ref{Channel{DebugAdapter.DebugSession}}()

function __init__()
    DEBUG_SESSION[] = Channel{DebugAdapter.DebugSession}(1)

    Core.eval(Main, :(module Testsetups end))
end

function withpath(f, path)
    tls = task_local_storage()
    hassource = haskey(tls, :SOURCE_PATH)
    hassource && (path′ = tls[:SOURCE_PATH])
    tls[:SOURCE_PATH] = path
    try
        return f()
    finally
        hassource ? (tls[:SOURCE_PATH] = path′) : delete!(tls, :SOURCE_PATH)
    end
end

function revise_request(::Nothing, state::TestProcessState, token)
    try
        Revise.revise(throw=true)
        return "success"
    catch err
        # Base.display_error(err, catch_backtrace())
        return "failed"
    end
end

function flatten_failed_tests!(ts, out)
    append!(out, i for i in ts.results if !(i isa Test.Pass))

    for cts in ts.children
        flatten_failed_tests!(cts, out)
    end
end

function format_error_message(err, bt)
    try
        return Base.invokelatest(sprint, Base.display_error, err, bt)
    catch err
        # TODO We could probably try to output an even better error message here that
        # takes into account `err`. And in the callsites we should probably also
        # handle this better.
        return "Error while trying to format an error message"
    end
end

function clear_coverage_data()
    @static if VERSION >= v"1.11.0-rc2"
        try
            @ccall jl_clear_coverage_data()::Cvoid
        catch err
            # TODO Call global error handler
        end
    end
end

function collect_coverage_data!(coverage_results, roots)
    @static if VERSION >= v"1.11.0-rc2"
        lcov_filename = tempname() * ".info"
        @ccall jl_write_coverage_data(lcov_filename::Cstring)::Cvoid
        cov_info = try
            LCOV.readfile(lcov_filename)
        finally
            rm(lcov_filename)
        end

        filter!(i->isabspath(i.filename) && any(j->startswith(filepath2uri(i.filename), j), roots) && isfile(i.filename), cov_info)

        append!(coverage_results, cov_info)
    end
end

function process_coverage_data(coverage_results)
    if length(coverage_results) == 0
        return missing
    end

    merged_coverage = CoverageTools.merge_coverage_counts(coverage_results)

    coverage_info = TestItemServerProtocol.FileCoverage[]

    for i in merged_coverage
        file_cov = CoverageTools.FileCoverage(i.filename, read(i.filename, String), i.coverage)

        amend_coverage_from_src!(file_cov)

        push!(coverage_info, TestItemServerProtocol.FileCoverage(filepath2uri(file_cov.filename), file_cov.coverage))
    end

    return coverage_info
end

function run_testitem(endpoint, params::TestItemServerProtocol.RunTestItem, mode::String, coverage_root_uris::Union{Nothing,Vector{String}}, state::TestProcessState)
    JSONRPC.send(
        endpoint,
        TestItemServerProtocol.started_notification_type,
        TestItemServerProtocol.StartedParams(
            testItemId = params.id,
        )
    )

    working_dir = dirname(uri2filepath(params.uri))
    cd(working_dir)

    coverage_results = CoverageTools.FileCoverage[] # This will hold the results of various coverage sprints

    for i in params.testSetups
        if !haskey(state.test_setups, (params.packageUri, Symbol(i)))
            return (
                TestItemServerProtocol.errored_notification_type,
                TestItemServerProtocol.ErroredParams(
                    testItemId = params.id,
                    messages = [
                        TestItemServerProtocol.TestMessage(
                            "The specified testsetup $i does not exist.",
                            TestItemServerProtocol.Location(
                                params.uri,
                                TestItemServerProtocol.Position(params.line, 1)
                            )
                        )
                    ],
                    duration = missing
                )
            )
        end

        setup_details = state.test_setups[(params.packageUri, Symbol(i))]

        if setup_details.kind==:module && !setup_details.evaled
            mod = Core.eval(Main.Testsetups, :(module $(Symbol(i)) end))

            code = string('\n'^(setup_details.line-1), ' '^(setup_details.column-1), setup_details.code)

            filepath = uri2filepath(setup_details.uri)

            t0 = time_ns()
            try
                withpath(filepath) do
                    Base.invokelatest(include_string, mod, code, filepath)
                end
                setup_details.evaled = true
            catch err
                elapsed_time = (time_ns() - t0) / 1e6 # Convert to milliseconds

                bt = catch_backtrace()
                st = stacktrace(bt)

                error_message = format_error_message(err, bt)

                if err isa LoadError
                    error_filepath = err.file
                    error_line = err.line
                else
                    error_filepath =  string(st[1].file)
                    error_line = st[1].line
                end

                return (
                    TestItemServerProtocol.errored_notification_type,
                    TestItemServerProtocol.ErroredParams(
                        testItemId = params.id,
                        messages = [
                            TestItemServerProtocol.TestMessage(
                                error_message,
                                TestItemServerProtocol.Location(
                                    isabspath(error_filepath) ? filepath2uri(error_filepath) : "",
                                    TestItemServerProtocol.Position(max(1, error_line), 1)
                                )
                            )
                        ],
                        duration = missing
                    )
                )
            end
        end
    end

    mod = Core.eval(Main, :(module $(gensym()) end))

    if params.useDefaultUsings
        try
            Core.eval(mod, :(using Test))
        catch
            return (
                TestItemServerProtocol.errored_notification_type,
                TestItemServerProtocol.ErroredParams(
                    testItemId = params.id,
                    messages = [
                        TestItemServerProtocol.TestMessage(
                            "Unable to load the `Test` package. Please ensure that `Test` is listed as a test dependency in the Project.toml for the package.",
                            TestItemServerProtocol.Location(
                                params.uri,
                                TestItemServerProtocol.Position(params.line, 1)
                            )
                        )
                    ],
                    duration = missing
                )
            )
        end

        if params.packageName!=""
            try
                mode == "Coverage" && clear_coverage_data()

                try
                    Core.eval(mod, :(using $(Symbol(params.packageName))))
                finally
                    mode == "Coverage" && collect_coverage_data!(coverage_results, coverage_root_uris)
                end
            catch err
                bt = catch_backtrace()
                error_message = format_error_message(err, bt)

                return (
                    TestItemServerProtocol.errored_notification_type,
                    TestItemServerProtocol.ErroredParams(
                        testItemId = params.id,
                        messages = [
                            TestItemServerProtocol.TestMessage(
                                error_message,
                                TestItemServerProtocol.Location(
                                    params.uri,
                                    TestItemServerProtocol.Position(params.line, 1)
                                )
                            )
                        ],
                        duration = missing
                    )
                )
            end
        end
    end

    for i in params.testSetups
        testsetup_details = state.test_setups[(params.packageUri,Symbol(i))]

        try
            if testsetup_details.kind==:module
                Core.eval(mod, :(using ..Testsetups: $(Symbol(i))))
            elseif testsetup_details.kind==:snippet
                testsnippet_filepath = uri2filepath(testsetup_details.uri)
                testsnippet_code = string('\n'^(testsetup_details.line-1), ' '^(testsetup_details.column-1), testsetup_details.code)

                withpath(testsnippet_filepath) do
                    if mode == "Debug"
                        debug_session = wait_for_debug_session()
                        DebugAdapter.debug_code(debug_session, mod, testsnippet_code, testsnippet_filepath)
                    else
                        mode == "Coverage" && clear_coverage_data()
                        try
                            Base.invokelatest(include_string, mod, testsnippet_code, testsnippet_filepath)
                        finally
                            mode == "Coverage" && collect_coverage_data!(coverage_results, coverage_root_uris)
                        end
                    end
                end
            else
                error("Unknown testsetup kind $(i.kind).")
            end
        catch err
            Base.display_error(err, catch_backtrace())
            return (
                TestItemServerProtocol.errored_notification_type,
                TestItemServerProtocol.ErroredParams(
                    testItemId = params.id,
                    messages = [
                        TestItemServerProtocol.TestMessage(
                            "Unable to load the `$i` testsetup.",
                            TestItemServerProtocol.Location(
                                params.uri,
                                TestItemServerProtocol.Position(params.line, 1)
                            )
                        )
                    ],
                    duration = missing
                )
            )

        end
    end

    filepath = uri2filepath(params.uri)

    code = string('\n'^(params.line-1), ' '^(params.column-1), params.code)

    ts = Test.DefaultTestSet("$filepath:$(params.name)")

    Test.push_testset(ts)

    elapsed_time = UInt64(0)

    t0 = time_ns()
    try
        withpath(filepath) do

            if mode == "Debug"
                debug_session = wait_for_debug_session()
                DebugAdapter.debug_code(debug_session, mod, code, filepath)
            else
                mode == "Coverage" && clear_coverage_data()
                try
                    Base.invokelatest(include_string, mod, code, filepath)
                finally
                    mode == "Coverage" && collect_coverage_data!(coverage_results, coverage_root_uris)
                end
            end
            elapsed_time = (time_ns() - t0) / 1e6 # Convert to milliseconds
        end
    catch err
        elapsed_time = (time_ns() - t0) / 1e6 # Convert to milliseconds

        Test.pop_testset()

        bt = catch_backtrace()
        st = stacktrace(bt)

        error_message = format_error_message(err, bt)



        if err isa LoadError
            error_filepath = err.file
            error_line = err.line
        else
            error_filepath =  string(st[1].file)
            error_line = st[1].line
        end

        return (
            TestItemServerProtocol.errored_notification_type,
            TestItemServerProtocol.ErroredParams(
                testItemId = params.id,
                messages = [
                    TestItemServerProtocol.TestMessage(
                        error_message,
                        TestItemServerProtocol.Location(
                            isabspath(error_filepath) ? filepath2uri(error_filepath) : "",
                            TestItemServerProtocol.Position(max(1, error_line), 1)
                        )
                    )
                ],
                duration = missing
            )
        )
    end

    ts = Test.pop_testset()

    try
        Test.finish(ts)

        return (
            TestItemServerProtocol.passed_notification_type,
            TestItemServerProtocol.PassedParams(
                testItemId = params.id,
                duration = elapsed_time,
                coverage = process_coverage_data(coverage_results)
            )
        )
    catch err
        if err isa Test.TestSetException
            failed_tests = Test.filter_errors(ts)

            return (
                TestItemServerProtocol.failed_notification_type,
                TestItemServerProtocol.FailedParams(
                    testItemId = params.id,
                    messages = [ create_test_message_for_failed(i) for i in failed_tests],
                    duration = elapsed_time
                )
            )
        else
            rethrow(err)
        end
    end
end

function run_testitems_batch_request(params::TestItemServerProtocol.RunTestItemsRequestParams, state::TestProcessState, token)
    put!(state.testitems_channel, params.testItems)


    return nothing
end

function create_test_message_for_failed(i)
    (expected, actual) = extract_expected_and_actual(i)
    return TestItemServerProtocol.TestMessage(sprint(Base.show, i),
        expected,
        actual,
        TestItemServerProtocol.Location(filepath2uri(string(i.source.file)), TestItemServerProtocol.Position(i.source.line, 1)))
end

function extract_expected_and_actual(result)
    actual = nothing
    expected = nothing

    if isa(result, Test.Fail)
        s = result.data

        if isa(s, String)
            m = match(r"\"(.*)\" == \"(.*)\""s, s)
            if m !== nothing
                try
                    expected = unescape_string(m.captures[2])
                    actual = unescape_string(m.captures[1])
                catch err
                    # theoretically possible if a user registers a Fail instance that matches
                    # above regexp, but doesn't contain two escaped strings.
                    # just return nothing in this unlikely case, meaning no diff will be shown.
                end
            else
                # Now try the version without quotation marks
                m = match(r"(.*) == (.*)"s, s)
                if m !== nothing
                    try
                        expected = unescape_string(m.captures[2])
                        actual = unescape_string(m.captures[1])
                    catch err
                        # theoretically possible if a user registers a Fail instance that matches
                        # above regexp, but doesn't contain two escaped strings.
                        # just return nothing in this unlikely case, meaning no diff will be shown.
                    end
                end
            end
        end
    end

    if actual !== nothing && expected !== nothing
        return (expected, actual)
    else
        return (missing, missing)
    end
end



function start_debug_backend(debug_pipename, error_handler)
    ready = Channel{Bool}(1)
    @async try
        server = Sockets.listen(debug_pipename)

        put!(ready, true)

        while true
            conn = Sockets.accept(server)

            debug_session = DebugAdapter.DebugSession(conn)

            global DEBUG_SESSION

            put!(DEBUG_SESSION[], debug_session)

            try
                run(debug_session, error_handler)
            finally
                take!(DEBUG_SESSION[])
            end
        end
    catch err
        bt = catch_backtrace()
        if err_handler !== nothing
            err_handler(err, bt)
        else
            Base.display_error(err, bt)
        end
    end

    take!(ready)
end

function wait_for_debug_session()
    @info "Now waiting for debug session"
    fetch(DEBUG_SESSION[])
end

function get_debug_session_if_present()
    if isready(DEBUG_SESSION[])
        return fetch(DEBUG_SESSION[])
    else
        return nothing
    end
end


function activate_env_request(params::TestItemServerProtocol.ActivateEnvParams, state::TestProcessState, token)
    if params.projectUri===missing
        @static if VERSION >= v"1.5.0"
            Pkg.activate(temp=true)
        else
            temp_path = mktempdir()
            Pkg.activate(temp_path)
        end

        Pkg.develop(Pkg.PackageSpec(path=uri2filepath(params.packageUri)))

        TestEnv.activate(params.packageName)
    else
        Pkg.activate(uri2filepath(params.projectUri))

        if params.packageName!==missing
            TestEnv.activate(params.packageName)
        end
    end

    return nothing
end

function configure_test_run_request(params::TestItemServerProtocol.ConfigureTestRunRequestParams, state::TestProcessState, token)
    state.mode = params.mode
    state.coverage_root_uris = coalesce(params.coverageRootUris, nothing)

    setups_to_remove = setdiff(keys(state.test_setups), map(i->(i.packageUri,Symbol(i.name)), params.testSetups))
    for i in setups_to_remove
        delete!(state.test_setups, i)
    end

    for i in params.testSetups
        key = (i.packageUri, Symbol(i.name))
        if !haskey(state.test_setups, key)
            state.test_setups[key] = Testsetup(
                i.name,
                Symbol(i.kind),
                i.uri,
                i.line,
                i.column,
                i.code,
                false
            )
        else
            val = state.test_setups[key]

            if val.code != i.code || val.kind != i.kind
                val.evaled = false
                val.code = i.code
                val.kind = Symbol(i.kind)
            end

            val.uri = i.uri
            val.line = i.line
            val.column = i.column
            val.name = i.name
        end
    end
end

function steal_testitems_request(params::TestItemServerProtocol.StealTestItemsRequestParams, state::TestProcessState, token)
    put!(state.stolen_testitem_ids_channel, params.testItemIds)

    return nothing
end

function shutdown_request(::Nothing, state::TestProcessState, token)
    return nothing
end

JSONRPC.@message_dispatcher dispatch_msg begin
    TestItemServerProtocol.testserver_revise_request_type => revise_request
    TestItemServerProtocol.testserver_activate_env_request_type => activate_env_request
    TestItemServerProtocol.configure_testrun_request_type => configure_test_run_request
    TestItemServerProtocol.testserver_run_testitems_batch_request_type => run_testitems_batch_request
    TestItemServerProtocol.testserver_steal_testitems_request_type => steal_testitems_request
    TestItemServerProtocol.testserver_shutdown_request_type => shutdown_request
end

function runner_loop(state::TestProcessState)
    stolen_testitem_ids = String[]
    testitems = TestItemServerProtocol.RunTestItem[]

    while true
        if isready(state.stolen_testitem_ids_channel)
            append!(stolen_testitem_ids, take!(state.stolen_testitem_ids_channel))
        end

        if length(testitems) == 0
            if isready(state.testitems_channel)
                append!(testitems, take!(state.testitems_channel))
            end
        end

        if length(testitems) == 0
            for id in stolen_testitem_ids
                JSONRPC.send(
                    state.endpoint,
                    TestItemServerProtocol.skipped_stolen_notification_type,
                    TestItemServerProtocol.SkippedStolenParams(
                        testItemId = id
                    )
                )
            end
            empty!(stolen_testitem_ids)
        else
            current_testitem = popfirst!(testitems)

            idx = findfirst(i->i==current_testitem.id, stolen_testitem_ids)
            if idx !== nothing
                deleteat!(stolen_testitem_ids, idx)

                JSONRPC.send(
                    state.endpoint,
                    TestItemServerProtocol.skipped_stolen_notification_type,
                    TestItemServerProtocol.SkippedStolenParams(
                        testItemId = current_testitem.id
                    )
                )
            else
                print(stderr, "\x1f3805a0ad41b54562a46add40be31ca27", "$(current_testitem.id)\"", "")
                flush(stderr)
                ret = run_testitem(state.endpoint, current_testitem, state.mode, state.coverage_root_uris, state)
                print(stderr, "\x1f4031af828c3d406ca42e25628bb0aa77")
                flush(stderr)

                JSONRPC.send(
                    state.endpoint,
                    ret[1],
                    ret[2]
                )
            end
        end


        # We now check again for stolen test items, as we might have received some
        # while we were running the last test item
        if isready(state.stolen_testitem_ids_channel)
            append!(stolen_testitem_ids, take!(state.stolen_testitem_ids_channel))
        end

        if length(testitems)==0 && length(stolen_testitem_ids)==0
            fetch(state.testitems_channel)
        end
    end
end

function serve(pipename, debug_pipename, error_handler=nothing)
    if debug_pipename!==nothing
        start_debug_backend(debug_pipename, error_handler)
    end

    conn = Sockets.connect(pipename)

    endpoint = JSONRPC.JSONRPCEndpoint(conn, conn)

    run(endpoint)

    state = TestProcessState(endpoint, error_handler)

    @async try
        runner_loop(state)
    catch err
        Base.display_error(err, catch_backtrace())
    end

    while true
        msg = JSONRPC.get_next_message(endpoint)

        if msg.method == "testserver/shutdown"
            dispatch_msg(endpoint, msg, state)
            break
        else
            @async try
                dispatch_msg(endpoint, msg, state)
            catch err
                Base.display_error(err, catch_backtrace())
            end
        end
    end
end

end
