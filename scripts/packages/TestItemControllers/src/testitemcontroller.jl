mutable struct TestProcess
    id::String
    msg_channel::Channel
    idle::Bool
    # killed::Bool
    # status::Symbol
end

mutable struct TestItemController{ERR_HANDLER<:Function}
    err_handler::Union{Nothing,ERR_HANDLER}

    msg_channel::Channel

    testrun_msg_channels::Dict{String,Channel}

    testprocesses::Dict{TestEnvironment,Vector{TestProcess}}
    testprocess_precompile_not_required::Set{
        @NamedTuple{
            julia_cmd::String,
            julia_args::Vector{String},
            env::Dict{String,Union{String,Nothing}},
            coverage::Bool
        }
    }

    precompiled_envs::Set{TestEnvironment}

    coverage::Dict{String,Vector{CoverageTools.FileCoverage}}

    error_handler_file::Union{Nothing,String}
    crash_reporting_pipename::Union{Nothing,String}

    function TestItemController(
        err_handler::ERR_HANDLER;
        error_handler_file=nothing,
        crash_reporting_pipename=nothing) where {ERR_HANDLER<:Union{Function,Nothing}}

        return new{ERR_HANDLER}(
            err_handler,
            Channel(Inf),
            Dict{String,Channel}(),
            Dict{TestEnvironment,Vector{TestProcess}}(),
            Set{@NamedTuple{julia_cmd::String,julia_args::Vector{String},env::Dict{String,Union{String,Nothing}},coverage::Bool}}(),
            Set{TestEnvironment}(),
            Dict{String,Vector{CoverageTools.FileCoverage}}(),
            error_handler_file,
            crash_reporting_pipename
        )
    end
end

function shutdown(controller::TestItemController)
    for i in Iterators.flatten(values(controller.testprocesses))
        put!(
            i.msg_channel,
            (;
                event = :shutdown
            )
        )
    end
end

function terminate_test_process(controller::TestItemController, id::String)
    for v in values(controller.testprocesses)
        for p in v
            if p.id == id
                put!(p.msg_channel, (;event=:terminate))
            end
        end
    end

    return nothing
end

function Base.run(
        controller::TestItemController,
        testprocess_created_callback,
        testprocess_terminated,
        testprocess_statuschanged,
        testprocess_output
    )
    while true
        msg = take!(controller.msg_channel)

        if msg.event == :test_process_status_changed
            # Inform the user via callback
            testprocess_statuschanged(msg.id, msg.status)
        elseif msg.event == :testprocess_output
            testprocess_output(msg.id, msg.output)
        elseif msg.event == :test_process_terminated
            for procs in values(controller.testprocesses)
                ind = findfirst(i->i.id==msg.id, procs)
                if ind!==nothing
                    deleteat!(procs, ind)
                    break
                end
            end

            # Inform the user via callback
            testprocess_terminated(msg.id)
        elseif msg.event == :return_to_pool
            put!(msg.testprocess.msg_channel, (;event=:end_testrun))
            msg.testprocess.idle = true
            testprocess_statuschanged(msg.testprocess.id, "Idle")
        elseif msg.event == :get_procs_for_testrun
            our_procs = Dict{TestEnvironment,Vector{TestProcess}}()

            for (k,v) in pairs(msg.proc_count_by_env)
                our_procs[k] = TestProcess[]

                testprocesses = get!(controller.testprocesses, k) do
                    TestProcess[]
                end

                existing_idle_procs = filter(i->i.idle, testprocesses)

                @info "Test environment\n\nProject Uri: $(k.project_uri)\nPackage Uri: $(k.package_uri)\nPackage Name: $(k.package_name)\nJulia command: $(k.juliaCmd)\nJulia Num Threads: $(k.juliaNumThreads)\nMode: $(k.mode)\nEnv: $(k.env)\n\nWe need $v procs, there are $(length(testprocesses)) processes, of which $(length(existing_idle_procs)) are idle."

                # Grab existing procs
                for p in Iterators.take(existing_idle_procs, v)
                    put!(
                        p.msg_channel,
                        (
                            event = :start_testrun,
                            testrun_channel = msg.testrun_msg_queue,
                            test_setups = msg.test_setups,
                            coverage_root_uris = msg.coverage_root_uris
                        )
                    )

                    push!(our_procs[k], p)

                    put!(p.msg_channel, (event=:revise, test_env_content_hash=msg.env_content_hash_by_env[k]))
                end

                # Now comes a horrible hack for old Julia versions: pre Julia 1.10 parallel precompile
                # crashes Julia. If we are on one of these old Julia verions, we need to precompile
                # the test process itself once before we do anything else. We do this only once per
                # Julia version per session
                if !(
                    (
                        julia_cmd=k.juliaCmd,
                        julia_args=k.juliaArgs,
                        env=k.env,
                        coverage=k.mode == "Coverage"
                    ) in controller.testprocess_precompile_not_required)

                    @info "New env, lets figure out whether we need to precompile the test environment"
                    coverage_arg = k.mode == "Coverage" ? "--code-coverage=user" : "--code-coverage=none"

                    jlEnv = copy(ENV)
                    for (k,v) in pairs(k.env)
                        if v!==nothing
                            jlEnv[k] = v
                        elseif haskey(jlEnv, k)
                            delete!(jlEnv, k)
                        end
                    end

                    julia_version_as_string = read(Cmd(`$(k.juliaCmd) $(k.juliaArgs) --version`, detach=false, env=jlEnv), String)
                    julia_version_as_string = julia_version_as_string[length("julia version")+2:end]
                    julia_version = VersionNumber(julia_version_as_string)

                    if julia_version <= v"1.10.0"
                        testserver_precompile_script = joinpath(@__DIR__, "../testprocess/app/testserver_precompile.jl")

                        asdf = success(Cmd(`$(k.juliaCmd) $(k.juliaArgs) --check-bounds=yes --startup-file=no --history-file=no --depwarn=no $coverage_arg $testserver_precompile_script`, detach=false, env=jlEnv))

                        @info "Precompile of test server" asdf

                        push!(controller.testprocess_precompile_not_required, (
                            julia_cmd=k.juliaCmd,
                            julia_args=k.juliaArgs,
                            env=k.env,
                            coverage=k.mode == "Coverage"
                        ))
                    else
                        @info "Julia version is new enough"
                    end
                else
                    @info "Precompile check has been done already"
                end


                precompile_required = !(k in controller.precompiled_envs)

                identified_precompile_proc = false

                while length(our_procs[k]) < v
                    @info "Launching new test process"

                    # The first process we create will be the precompile proc if we need one
                    this_is_the_precompile_proc = precompile_required && !identified_precompile_proc
                    identified_precompile_proc =true

                    testprocess_id, testprocess_msg_channel = create_testprocess(
                        controller.msg_channel,
                        k,
                        this_is_the_precompile_proc,msg.env_content_hash_by_env[k],
                        controller.error_handler_file,
                        controller.crash_reporting_pipename
                    )

                    put!(
                        testprocess_msg_channel,
                        (
                            event = :start_testrun,
                            testrun_channel = msg.testrun_msg_queue,
                            test_setups = msg.test_setups,
                            coverage_root_uris = msg.coverage_root_uris
                        )
                    )

                    put!(
                        testprocess_msg_channel,
                        (;
                            event = :start,
                        )
                    )

                    p = TestProcess(testprocess_id, testprocess_msg_channel, false)

                    push!(our_procs[k], p)

                    push!(testprocesses, p)

                    testprocess_created_callback(testprocess_id, k.package_name, k.package_uri, k.project_uri, k.mode == "Coverage", k.env)
                end
            end

            put!(
                msg.testrun_msg_queue,
                (
                    source=:controller,
                    msg=(
                        event=:procs_acquired,
                        procs=our_procs,
                    )
                )
            )
        else
            error("Unknown message")
        end
    end
end

function makechunks(X::AbstractVector, n::Integer)
    if n<1
        error("n is smaller than 1")
    end
    c = length(X) ÷ n
    return [X[1+c*k:(k == n-1 ? end : c*k+c)] for k = 0:n-1]
end

struct TestProfile
    id::String
    label::String
    julia_cmd::String
    julia_args::Vector{String}
    julia_num_threads::Union{Missing,String}
    julia_env::Dict{String,Union{String,Nothing}}
    max_process_count::Int
    mode::String
    coverage_root_uris::Union{Nothing,Vector{String}}
end

struct TestItemDetail
    id::String
    uri::String
    label::String
    package_name::Union{Nothing,String}
    package_uri::Union{Nothing,String}
    project_uri::Union{Nothing,String}
    env_content_hash::Union{Nothing,String}
    option_default_imports::Bool
    test_setups::Vector{String}
    line::Int
    column::Int
    code::String
    code_line::Int
    code_column::Int
end

struct TestSetupDetail
    package_uri::Union{Nothing,String}
    name::String
    kind::String
    uri::String
    line::Int
    column::Int
    code::String
end

function execute_testrun(
    controller::TestItemController,
    testrun_id::String,
    profiles::Vector{TestProfile},
    test_items::Vector{TestItemDetail},
    test_setups::Vector{TestSetupDetail},
    testitem_started_callback,
    testitem_passed_callback,
    testitem_failed_callback,
    testitem_errored_callback,
    append_output_callback,
    attach_debugger_callback,
    token)

    @assert length(profiles) == 1 "Currently one must pass one test profile"

    @info "Creating new test run"

    state = :created

    testrun_msg_queue = Channel{Any}(Inf)
    controller.testrun_msg_channels[testrun_id] = testrun_msg_queue
    our_procs = nothing

    valid_test_items = Dict(i.id => i for i in test_items if i.package_name !== nothing && i.package_uri !== nothing)
    test_items_without_package = [i for i in test_items if i.package_name === nothing || i.package_uri === nothing]

    stolen_testitem_ids_by_proc_id = Dict{String,Vector{String}}()

    testitem_ids_by_env = Dict{TestEnvironment,Vector{String}}()

    env_content_hash_by_env = Dict{TestEnvironment,String}()

    for i in values(valid_test_items)
        te = TestEnvironment(
            i.project_uri,
            i.package_uri,
            i.package_name,
            profiles[1].julia_cmd,
            profiles[1].julia_args,
            profiles[1].julia_num_threads,
            profiles[1].mode,
            profiles[1].julia_env
        )

        testitems = get!(testitem_ids_by_env, te) do
            String[]
        end

        push!(testitems, i.id)

        if haskey(env_content_hash_by_env, te)
            if env_content_hash_by_env[te] != i.env_content_hash
                error("This is invalid.")
            end
        else
            env_content_hash_by_env[te] = i.env_content_hash
        end
    end

    testitem_ids_by_env_chunked = Dict{TestEnvironment,Vector{Vector{String}}}()

    for (k,v) in pairs(testitem_ids_by_env)
        as_share = length(v)/length(valid_test_items)

        n_procs = min(floor(Int, profiles[1].max_process_count * as_share), length(valid_test_items))

        chunks =  makechunks(v, n_procs)

        testitem_ids_by_env_chunked[k] = chunks
    end

    # Finally, we send error notifications for all test items that didn't have a package
    for i in test_items_without_package
        testitem_failed_callback(
            params.testRunId,
            i.id,
            TestItemControllerProtocol.TestMessage[
                TestItemControllerProtocol.TestMessage(
                    message = "Test item '$(i.label)' is not inside a Julia package. Test items must be inside a package to be run.",
                    expectedOutput = missing,
                    actualOutput = missing,
                    uri = i.uri,
                    line = i.line,
                    column = i.column
                )
            ],
            missing
        )
    end

    state = :procs_requested

    put!(
        controller.msg_channel,
        (
            event = :get_procs_for_testrun,
            proc_count_by_env = Dict(k=>length(v) for (k,v) in testitem_ids_by_env_chunked),
            env_content_hash_by_env = env_content_hash_by_env,
            test_setups = [
                TestItemServerProtocol.TestsetupDetails(
                    packageUri = something(i.package_uri, missing),
                    name = i.name,
                    kind = i.kind,
                    uri = i.uri,
                    line = i.line,
                    column = i.column,
                    code = i.code
                ) for i in test_setups],
            coverage_root_uris = profiles[1].coverage_root_uris,
            testrun_msg_queue = testrun_msg_queue
        )
    )

    testitem_ids_by_proc = Dict{String,Vector{String}}()

    coverage_results = missing

    processes_that_are_ready = Set{@NamedTuple{id::String,channel::Channel}}()

    while true
        msg = take!(testrun_msg_queue)
        @debug "Testrun msg" msg

        if msg.source==:controller
            if msg.msg.event==:procs_acquired
                state == :procs_requested || error("Invalid state transition from $state")
                our_procs = msg.msg.procs

                # Now distribute test items over test processes
                for (k,v) in pairs(our_procs)
                    for proc in v
                        stolen_testitem_ids_by_proc_id[proc.id] = String[]
                        testitem_ids_by_proc[proc.id] = pop!(testitem_ids_by_env_chunked[k])
                    end
                end

                state = :all_procs_acquired

                for i in processes_that_are_ready
                    put!(i.channel, (event=:run_testitems, testitems=collect(valid_test_items[i] for i in testitem_ids_by_proc[i.id])))
                end
            elseif msg.msg.event==:cancel_test_run
                for i in Iterators.flatten(values(our_procs))
                    put!(i.msg_channel, (; event=:cancel_test_run))
                end

                # TODO What then?
            else
                error("Unknown message")
            end
        elseif msg.source==:testprocess
            if msg.msg.event == :ready_to_run_testitems
                state in (:procs_requested, :all_procs_acquired) || error("Invalid state transition from $state")

                if state == :all_procs_acquired
                    put!(msg.msg.channel, (event=:run_testitems, testitems=collect(valid_test_items[i] for i in testitem_ids_by_proc[msg.msg.id])))
                else
                    push!(processes_that_are_ready, (id=msg.msg.id, channel=msg.msg.channel))
                end
            elseif msg.msg.event == :attach_debugger
                attach_debugger_callback(testrun_id, msg.msg.debug_pipe_name)
            elseif msg.msg.event == :precompile_done
                state in (:procs_requested, :all_procs_acquired) || error("Invalid state transition from $state")

                for i in our_procs[msg.msg.env]
                    if i.id !== msg.msg.testprocess_id
                        put!(i.msg_channel, (;event=:precompile_by_other_proc_done))
                    end
                end
            elseif msg.msg.event == :started
                state in (:procs_requested, :all_procs_acquired) || error("Invalid state transition from $state")

                testitem_started_callback(
                    testrun_id,
                    msg.msg.testitemid
                )
            elseif msg.msg.event == :append_output
                state in (:procs_requested, :all_procs_acquired) || error("Invalid state transition from $state")

                append_output_callback(
                    testrun_id,
                    msg.msg.testitemid,
                    msg.msg.output
                )
            elseif msg.msg.event in (:passed, :failed, :errored, :skipped_stolen)
                state in (:procs_requested, :all_procs_acquired) || error("Invalid state transition from $state")

                idx = findfirst(isequal(msg.msg.testitemid), stolen_testitem_ids_by_proc_id[msg.msg.test_process_id])
                if msg.msg.event == :skipped_stolen
                    deleteat!(stolen_testitem_ids_by_proc_id[msg.msg.test_process_id], idx)
                else
                    if idx === nothing
                        delete!(valid_test_items, msg.msg.testitemid)
                        idx = findfirst(isequal(msg.msg.testitemid), testitem_ids_by_proc[msg.msg.test_process_id])
                        deleteat!(testitem_ids_by_proc[msg.msg.test_process_id], idx)

                        if msg.msg.event == :passed
                            testitem_passed_callback(
                                testrun_id,
                                msg.msg.testitemid,
                                msg.msg.duration
                            )

                            if msg.msg.coverage !== missing
                                file_coverage = get!(controller.coverage, testrun_id) do
                                    CoverageTools.FileCoverage[]
                                end
                                append!(file_coverage, map(i->CoverageTools.FileCoverage(uri2filepath(i.uri), "", i.coverage), msg.msg.coverage))
                            end
                        elseif msg.msg.event == :failed
                            testitem_failed_callback(
                                testrun_id,
                                msg.msg.testitemid,
                                TestItemControllerProtocol.TestMessage[
                                    TestItemControllerProtocol.TestMessage(
                                        message = i.message,
                                        expectedOutput = i.expectedOutput,
                                        actualOutput = i.actualOutput,
                                        uri = i.location.uri,
                                        line = i.location.position.line,
                                        column = i.location.position.character
                                    ) for i in msg.msg.messages
                                ],
                                missing
                            )
                        elseif msg.msg.event == :errored
                            testitem_errored_callback(
                                testrun_id,
                                msg.msg.testitemid,
                                TestItemControllerProtocol.TestMessage[
                                    TestItemControllerProtocol.TestMessage(
                                        message = i.message,
                                        expectedOutput = missing,
                                        actualOutput = missing,
                                        uri = i.location.uri,
                                        line = i.location.position.line,
                                        column = i.location.position.character
                                    ) for i in msg.msg.messages
                                ],
                                missing
                            )
                        end
                    end
                end

                # Stealing logic
                if length(testitem_ids_by_proc[msg.msg.test_process_id]) == 0 && length(stolen_testitem_ids_by_proc_id[msg.msg.test_process_id]) == 0
                    # First we find the test process instance and test env
                    test_process = nothing
                    test_processes_in_same_env = nothing
                    test_env = nothing
                    for (k,v) in pairs(our_procs)
                        ix = findfirst(i->i.id == msg.msg.test_process_id, v)
                        if ix!==nothing
                            test_process = v[ix]
                            test_processes_in_same_env = v
                            test_env = k
                            break
                        end
                    end

                    if test_process === nothing
                        error("This should never happen")
                    end

                    test_process_to_steal_from = nothing
                    # Now we look through all test processes with the same env that have more than 1 pending test item to run
                    for candidate_test_process in test_processes_in_same_env
                        n_test_items_still_pending = length(testitem_ids_by_proc[candidate_test_process.id])
                        # We only steal from this one if there are more than 1 test item pending
                        # AND if we haven't identified another process yet that has more pending test items
                        if n_test_items_still_pending > 1 && (test_process_to_steal_from===nothing || length(testitem_ids_by_proc[test_process_to_steal_from.id]) < n_test_items_still_pending)
                            test_process_to_steal_from = candidate_test_process
                        end
                    end

                    if test_process_to_steal_from === nothing
                        @info "Nothing to steal for $(test_process.id), returning to pool ($(msg.msg.event): $(msg.msg.testitemid))."
                        put!(controller.msg_channel, (event=:return_to_pool, testprocess=test_process))
                    else

                        # we just steal half the items at the end of the queue

                        # TODO HERE
                        testitem_ids_from_which_we_steal = testitem_ids_by_proc[test_process_to_steal_from.id]
                        steal_range = (div(length(testitem_ids_from_which_we_steal), 2, RoundUp) + 1):lastindex(testitem_ids_from_which_we_steal)

                        testitem_ids_to_steal = testitem_ids_from_which_we_steal[steal_range]

                        @info "Stealing $(length(testitem_ids_to_steal)) test items from $(test_process_to_steal_from.id) for $(test_process.id)."

                        deleteat!(testitem_ids_from_which_we_steal, steal_range)

                        for i in testitem_ids_to_steal
                            push!(stolen_testitem_ids_by_proc_id[test_process_to_steal_from.id], i)
                        end

                        append!(testitem_ids_by_proc[test_process.id], testitem_ids_to_steal)

                        put!(test_process_to_steal_from.msg_channel, (event=:steal, testitem_ids=testitem_ids_to_steal))

                        put!(test_process.msg_channel, (event=:run_testitems, testitems=collect(valid_test_items[i] for i in testitem_ids_to_steal)))
                        # run_testitems(test_process, stolen_test_items, msg.msg.testrunid, missing, controller)
                    end
                end

                # Are we done with the testrun?
                # @info "Still $(length(valid_test_items)) test items and $(sum(length.(values(stolen_testitem_ids_by_proc_id)))) stolen items processing."
                if length(valid_test_items)==0 && sum(length.(values(stolen_testitem_ids_by_proc_id)))==0

                    if haskey(controller.coverage, testrun_id)
                        coverage_results = map(CoverageTools.merge_coverage_counts(controller.coverage[testrun_id])) do i
                            TestItemControllerProtocol.FileCoverage(
                                uri = filepath2uri(i.filename),
                                coverage = i.coverage
                            )
                        end
                    end

                    break

                end
            elseif msg.msg.event == :test_process_terminated
                state in (:procs_requested, :all_procs_acquired) || error("Invalid state transition from $state")

                for procs in values(controller.testprocesses)
                    ind = findfirst(i->i.id==msg.msg.id, procs)
                    if ind!==nothing
                        deleteat!(procs, ind)
                    end
                end

                # Inform the user via callback
                testprocess_terminated(msg.msg.id)
            else
                error("Unknown message")
            end
        else
            error("Unknown source")
        end
    end

    delete!(controller.testrun_msg_channels, testrun_id)

    return coverage_results
end
