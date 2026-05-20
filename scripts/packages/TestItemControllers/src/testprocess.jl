# This is the dispatch handler for messages from the test processes. It directly passes
# those messages into the main message channel for the test process
JSONRPC.@message_dispatcher dispatch_testprocess_msg begin
    TestItemServerProtocol.started_notification_type => (params, msg_channel) -> put!(
        msg_channel,
        (
            event = :testitem_started,
            testitem_id = params.testItemId,
        )
    )
    TestItemServerProtocol.passed_notification_type => (params, msg_channel) -> put!(
        msg_channel,
        (
            event = :testitem_passed,
            testitem_id = params.testItemId,
            duration = params.duration,
            coverage = params.coverage
        )
    )
    TestItemServerProtocol.failed_notification_type => (params, msg_channel) -> put!(
        msg_channel,
        (
            event = :testitem_failed,
            testitem_id = params.testItemId,
            messages = params.messages,
            duration = params.duration,
        )
    )
    TestItemServerProtocol.errored_notification_type => (params, msg_channel) -> put!(
        msg_channel,
        (
            event = :testitem_errored,
            testitem_id = params.testItemId,
            messages = params.messages,
            duration = params.duration,
        )
    )
    TestItemServerProtocol.skipped_stolen_notification_type => (params, msg_channel) -> put!(
        msg_channel,
        (
            event = :testitem_skipped_stolen,
            testitem_id = params.testItemId
        )
    )
end

function create_testprocess(
        controller_msg_channel::Channel,
        env::TestEnvironment,
        is_precompile_process::Bool,
        test_env_content_hash::Union{Nothing,String},
        error_handler_file,
        crash_reporting_pipename)

    testprocess_id = string(UUIDs.uuid4())
    msg_channel = Channel(Inf)

    @async try
        # These are not nothing while a testrun is going on
        testrun_channel = nothing
        test_setups = nothing
        coverage_root_uris = nothing

        # These are nothing if no Julia process is up and running
        jl_process = nothing
        endpoint = nothing

        debug_pipe_name = JSONRPC.generate_pipe_name()

        precompile_done = false

        cs = CancellationTokens.CancellationTokenSource()

        julia_proc_cs = nothing

        queued_tests_n = 0
        queued_test_cancels_n = 0
        finished_testitems = Set{String}()
        testitems_to_run_when_ready = nothing

        state = :created

        while true
            msg = take!(msg_channel)
            @debug "Test process new message" msg

            if msg.event == :shutdown
                CancellationTokens.cancel(cs)
                @async try
                    JSONRPC.send(
                        endpoint,
                        TestItemServerProtocol.testserver_shutdown_request_type,
                        nothing
                    )
                catch err
                    Base.display_error(err, catch_backtrace())
                end
            elseif msg.event == :terminate
                error("NOT YET IMPLEMENTED")
            elseif msg.event == :start_testrun
                state in (:created, :idle) || error("Invalid state transition from $state.")
                state = :testrun_idle

                testrun_channel = msg.testrun_channel
                test_setups =msg.test_setups
                coverage_root_uris = msg.coverage_root_uris
            elseif msg.event == :cancel_test_run
                CancellationTokens.cancel(julia_proc_cs)
                kill(jl_process)
                jl_process = nothing
                endpoint = nothing
                julia_proc_cs = nothing
                # put!(msg_channel, (;event = :start))

                # tp.killed = true
    #                 @info "Now canceling $(tp.id)"
    #                 put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:test_process_status_changed, id=tp.id, status="Canceling")))
    #                 @info "Canceling process $(tp.id)"
    #                 kill(tp.jl_process)

    #                 put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:test_process_terminated, id=tp.id)))
    #                 break
            elseif msg.event == :revise
                state == :testrun_idle || error("Invalid state transition")
                state = :testrun_revising

                put!(controller_msg_channel, (event=:test_process_status_changed, id=testprocess_id, status="Revising"))

                @async try
                    needs_restart = false

                    if msg.test_env_content_hash != test_env_content_hash
                        needs_restart = true
                    else
                        res = JSONRPC.send(endpoint, TestItemServerProtocol.testserver_revise_request_type, nothing)

                        if res=="success"
                            needs_restart = false
                        elseif res == "failed"
                            needs_restart = true
                        else
                            error("")
                        end
                    end

                    if !needs_restart
                        put!(msg_channel, (;event=:testprocess_activated))
                    else
                        put!(msg_channel, (;event=:restart))
                    end
                catch err
                    Base.display_error(err, catch_backtrace())
                end
            elseif msg.event == :restart
                state == :testrun_revising || error("Invalid state transition")
                state = :testrun_killed_after_revise_fail

                @info "Revise could not handle changes or test env was changed, restarting process"
                CancellationTokens.cancel(julia_proc_cs)
                kill(jl_process)
                jl_process = nothing
                endpoint = nothing
                julia_proc_cs = nothing
                put!(msg_channel, (;event = :start))
            elseif msg.event == :start
                state in (:testrun_idle, :testrun_killed_after_revise_fail) || error("Invalid state transition")
                state = :testrun_starting

                julia_proc_cs === nothing || error("Invalid state for julia_proc_cs")
                julia_proc_cs = CancellationTokens.CancellationTokenSource(CancellationTokens.get_token(cs))

                put!(controller_msg_channel, (event=:test_process_status_changed, id=testprocess_id, status="Launching"))
                @async try

                    start(testprocess_id, controller_msg_channel, msg_channel, env, debug_pipe_name, error_handler_file, crash_reporting_pipename, CancellationTokens.get_token(julia_proc_cs))
                catch err
                    Base.display_error(err, catch_backtrace())
                end
            elseif msg.event == :end_testrun
                state == :testrun_idle || error("Invalid state transition from $state")
                state = :idle

                testrun_channel = nothing
                test_setups = nothing
                coverage_root_uris = nothing
            elseif msg.event == :testprocess_launched
                state == :testrun_starting || error("Invalid state transition.")

                jl_process = msg.jl_process
                endpoint = msg.endpoint
                if is_precompile_process || precompile_done
                    state = is_precompile_process ? :testrun_precompiling : :testrun_activating
                    @async try
                        JSONRPC.send(
                            endpoint,
                            TestItemServerProtocol.testserver_activate_env_request_type,
                            TestItemServerProtocol.ActivateEnvParams(
                                projectUri=something(env.project_uri, missing),
                                packageUri=env.package_uri,
                                packageName=env.package_name
                            )
                        )

                        put!(testrun_channel, (source=:testprocess, msg=(;event=:precompile_done, env=env, testprocess_id=testprocess_id)))
                        put!(msg_channel, (;event=:testprocess_activated))
                    catch err
                        Base.display_error(err, catch_backtrace())
                    end
                else
                    state = :testrun_waiting_for_precompile_done
                end
            elseif msg.event == :precompile_by_other_proc_done
                state == :testrun_waiting_for_precompile_done || error("Invalid state transition from $state.")
                state = :activating_env

                precompile_done = true
                if !is_precompile_process && jl_process !== nothing
                    @async try
                        JSONRPC.send(
                            endpoint,
                            TestItemServerProtocol.testserver_activate_env_request_type,
                            TestItemServerProtocol.ActivateEnvParams(
                                projectUri=something(env.project_uri, missing),
                                packageUri=env.package_uri,
                                packageName=env.package_name
                            )
                        )

                        put!(msg_channel, (;event=:testprocess_activated))
                    catch err
                        Base.display_error(err, catch_backtrace())
                    end
                end
            elseif msg.event == :testprocess_activated
                state in (:activating_env, :testrun_precompiling, :testrun_revising) || error("Invalid state transition from $state.")
                state = :configuring_test_run

                if env.mode == "Debug"
                    put!(testrun_channel, (source=:testprocess, msg=(;event=:attach_debugger, debug_pipe_name=debug_pipe_name)))
                end

                @async try
                    JSONRPC.send(
                        endpoint,
                        TestItemServerProtocol.configure_testrun_request_type,
                        TestItemServerProtocol.ConfigureTestRunRequestParams(
                            mode = env.mode,
                            coverageRootUris = something(coverage_root_uris,missing),
                            testSetups = test_setups
                        )
                    )

                    put!(msg_channel, (;event=:testprocess_testsetups_loaded))
                catch err
                    Base.display_error(err, catch_backtrace())
                end
            elseif msg.event == :testprocess_testsetups_loaded
                state == :configuring_test_run || error("Invalid state transition from $state.")
                state = :ready_to_run_tests
                put!(
                    testrun_channel,
                    (
                        source=:testprocess,
                        msg = (
                            event = :ready_to_run_testitems,
                            id = testprocess_id,
                            channel = msg_channel
                        )
                    )
                )

                if testitems_to_run_when_ready!==nothing
                    state = :running_tests

                    queued_tests_n == length(finished_testitems) || error("HA, $queued_tests_n")
                    queued_tests_n = length(testitems_to_run_when_ready)
                    empty!(finished_testitems)

                    put!(controller_msg_channel, (event=:test_process_status_changed, id=testprocess_id, status="Running"))
                    @async try
                        JSONRPC.send(
                            endpoint,
                            TestItemServerProtocol.testserver_run_testitems_batch_request_type,
                            TestItemServerProtocol.RunTestItemsRequestParams(
                                mode = env.mode,
                                coverageRootUris = something(coverage_root_uris, missing),
                                testItems = TestItemServerProtocol.RunTestItem[
                                    TestItemServerProtocol.RunTestItem(
                                        id = i.id,
                                        uri = i.uri,
                                        name = i.label,
                                        packageName = something(i.package_name, missing),
                                        packageUri = something(i.package_uri, missing),
                                        useDefaultUsings = i.option_default_imports,
                                        testSetups = i.test_setups,
                                        line = i.code_line,
                                        column = i.code_column,
                                        code = i.code,
                                    ) for i in testitems_to_run_when_ready
                                ],
                            )
                        )
                        testitems_to_run_when_ready! = nothing
                    catch err
                        Base.display_error(err, catch_backtrace())
                    end
                end
            elseif msg.event == :run_testitems
                if state in (:ready_to_run_tests, :testrun_idle, :running_tests)
                    state = :running_tests

                    queued_tests_n == length(finished_testitems) || error("HA, $queued_tests_n")
                    queued_tests_n = length(msg.testitems)
                    empty!(finished_testitems)

                    put!(controller_msg_channel, (event=:test_process_status_changed, id=testprocess_id, status="Running"))
                    @async try
                        JSONRPC.send(
                            endpoint,
                            TestItemServerProtocol.testserver_run_testitems_batch_request_type,
                            TestItemServerProtocol.RunTestItemsRequestParams(
                                mode = env.mode,
                                coverageRootUris = something(coverage_root_uris, missing),
                                testItems = TestItemServerProtocol.RunTestItem[
                                    TestItemServerProtocol.RunTestItem(
                                        id = i.id,
                                        uri = i.uri,
                                        name = i.label,
                                        packageName = something(i.package_name, missing),
                                        packageUri = something(i.package_uri, missing),
                                        useDefaultUsings = i.option_default_imports,
                                        testSetups = i.test_setups,
                                        line = i.code_line,
                                        column = i.code_column,
                                        code = i.code,
                                    ) for i in msg.testitems
                                ],
                            )
                        )
                    catch err
                        Base.display_error(err, catch_backtrace())
                    end
                elseif state == :starting
                    testitems_to_run_when_ready = msg.testitems
                else
                    error("Invalid state transition from $state on $testprocess_id.")
                end
            elseif msg.event == :steal
                queued_test_cancels_n += length(msg.testitem_ids)
                @async try
                    JSONRPC.send(
                            endpoint,
                            TestItemServerProtocol.testserver_steal_testitems_request_type,
                            TestItemServerProtocol.StealTestItemsRequestParams(
                                testItemIds = msg.testitem_ids
                            )
                        )
                catch err
                    Base.display_error(err, catch_backtrace())
                end
            elseif msg.event == :testitem_started
                put!(
                    testrun_channel,
                    (
                        source=:testprocess,
                        msg=(
                            event=:started,
                            testitemid=msg.testitem_id
                        )
                    )
                )
            elseif msg.event in (:testitem_passed, :testitem_failed, :testitem_errored, :testitem_skipped_stolen)
                state == :running_tests || error("Invalid state transition from $state, id is $testprocess_id, testitem_id $(msg.testitem_id) has $(msg.event)")

                if msg.event == :testitem_skipped_stolen
                    push!(finished_testitems, msg.testitem_id)
                    queued_test_cancels_n -= 1
                elseif !(msg.testitem_id in finished_testitems)
                    push!(finished_testitems, msg.testitem_id)
                else
                    error("asdf")
                end

                if queued_tests_n == length(finished_testitems) && queued_test_cancels_n == 0
                    state = :testrun_idle
                end

                if msg.event == :testitem_passed
                    put!(
                        testrun_channel,
                        (
                            source=:testprocess,
                            msg=(
                                event=:passed,
                                testitemid=msg.testitem_id,
                                duration=msg.duration,
                                coverage=msg.coverage,
                                test_process_id = testprocess_id
                            )
                        )
                    )
                elseif msg.event == :testitem_failed
                    put!(
                        testrun_channel,
                        (
                            source=:testprocess,
                            msg=(
                                event=:failed,
                                testitemid=msg.testitem_id,
                                messages=msg.messages,
                                duration=msg.duration,
                                test_process_id = testprocess_id
                            )
                        )
                    )
                elseif msg.event == :testitem_errored
                    put!(
                        testrun_channel,
                        (
                            source=:testprocess,
                            msg=(
                                event=:errored,
                                testitemid=msg.testitem_id,
                                messages=msg.messages,
                                duration=msg.duration,
                                test_process_id = testprocess_id
                            )
                        )
                    )
                elseif msg.event == :testitem_skipped_stolen
                    put!(
                        testrun_channel,
                        (
                            source=:testprocess,
                            msg=(
                                event=:skipped_stolen,
                                testitemid=msg.testitem_id,
                                test_process_id = testprocess_id
                            )
                        )
                    )
                else
                    error("Unknown message")
                end
            elseif msg.event == :append_output
                # TODO Remove this and understand the race situation better
                if testrun_channel !== nothing
                    put!(
                        testrun_channel,
                        (
                            source=:testprocess,
                            msg=(
                                event=:append_output,
                                testitemid=msg.testitem_id,
                                # testrunid=params.testRunId,
                                output=msg.output
                            )
                        )
                    )
                end
            end
        end
    catch err
        Base.display_error(err, catch_backtrace())
    end

    return testprocess_id, msg_channel
end

function start(testprocess_id, controller_msg_channel, testprocess_msg_channel, env::TestEnvironment, debug_pipe_name, error_handler_file, crash_reporting_pipename, token)
    pipe_name = JSONRPC.generate_pipe_name()
    server = Sockets.listen(pipe_name)

    testserver_script = joinpath(@__DIR__, "../testprocess/app/testserver_main.jl")

    pipe_out = Pipe()

    coverage_arg = env.mode == "Coverage" ? "--code-coverage=user" : "--code-coverage=none"

# //             if(package_uri && false) {
# //                 jlArgs.push(`--code-coverage=@${vscode.Uri.parse(package_uri).fsPath}`)
# //             }
# //             else {

    jlArgs = copy(env.juliaArgs)

    if env.juliaNumThreads!==missing && env.juliaNumThreads == "auto"
        push!(jlArgs, "--threads=auto")
    end

    jlEnv = copy(ENV)

    for (k,v) in pairs(env.env)
        if v!==nothing
            jlEnv[k] = v
        elseif haskey(jlEnv, k)
            delete!(jlEnv, k)
        end
    end

    if env.juliaNumThreads!==missing && env.juliaNumThreads!="auto" && env.juliaNumThreads!=""
        jlEnv["JULIA_NUM_THREADS"] = env.juliaNumThreads
    end

    error_handler_file = error_handler_file === nothing ? [] : [error_handler_file]
    crash_reporting_pipename = crash_reporting_pipename === nothing ? [] : [crash_reporting_pipename]

    @debug "Launch proc"
    jl_process = open(
        pipeline(
            Cmd(`$(env.juliaCmd) $(env.juliaArgs) --check-bounds=yes --startup-file=no --history-file=no --depwarn=no $coverage_arg $testserver_script $pipe_name $(debug_pipe_name) $(error_handler_file...) $(crash_reporting_pipename...)`, detach=false, env=jlEnv),
            stdout = pipe_out,
            stderr = pipe_out
        )
    )

    @async try
        begin_marker = "\x1f3805a0ad41b54562a46add40be31ca27"
        end_marker = "\x1f4031af828c3d406ca42e25628bb0aa77"
        buffer = ""
        current_output_testitem_id = nothing
        while !eof(pipe_out)
            data = readavailable(pipe_out)
            data_as_string = String(data)

            buffer *= data_as_string

            output_for_test_proc = IOBuffer()
            output_for_test_items = Pair{Union{Nothing,String},IOBuffer}[]

            i = 1
            while i<=length(buffer)
                might_be_begin_marker = false
                might_be_end_marker = false

                if current_output_testitem_id === nothing
                    j = 1
                    might_be_begin_marker = true
                    while i + j - 1<=length(buffer) && j <= length(begin_marker)
                        if buffer[i + j - 1] != begin_marker[j] || nextind(buffer, i + j - 1) != i + j
                            might_be_begin_marker = false
                            break
                        end
                        j += 1
                    end
                    is_begin_marker = might_be_begin_marker && length(buffer) - i + 1 >= length(begin_marker)

                    if is_begin_marker
                        ti_id_end_index = findfirst("\"", SubString(buffer, i))
                        if ti_id_end_index === nothing
                            break
                        else
                            current_output_testitem_id = SubString(buffer, i + length(begin_marker), i + ti_id_end_index.start - 2)
                            i = nextind(buffer, i + ti_id_end_index.start - 1)
                        end
                    elseif might_be_begin_marker
                        break
                    end
                else
                    j = 1
                    might_be_end_marker = true
                    while i + j - 1<=length(buffer) && j <= length(end_marker)
                        if buffer[i + j - 1] != end_marker[j] || nextind(buffer, i + j - 1) != i + j
                            might_be_end_marker = false
                            break
                        end
                        j += 1
                    end
                    is_end_marker = might_be_end_marker && length(buffer) - i + 1 >= length(end_marker)

                    if is_end_marker
                        current_output_testitem_id = nothing
                        i = i + length(end_marker)
                    elseif might_be_end_marker
                        break
                    end
                end

                if !might_be_begin_marker && !might_be_end_marker
                    print(output_for_test_proc, buffer[i])

                    if length(output_for_test_items) == 0 || output_for_test_items[end].first != current_output_testitem_id
                        push!(output_for_test_items, current_output_testitem_id => IOBuffer())
                    end

                    output_for_ti = output_for_test_items[end].second
                    if !CancellationTokens.is_cancellation_requested(token)
                        print(output_for_ti, buffer[i])
                    end

                    i = nextind(buffer, i)
                end
            end

            buffer = buffer[i:end]

            output_for_test_proc_as_string = String(take!(output_for_test_proc))

            if length(output_for_test_proc_as_string) > 0
                put!(
                    controller_msg_channel,
                    (
                        event = :testprocess_output,
                        id = testprocess_id,
                        output = output_for_test_proc_as_string
                    )
                )
            end

            for (k,v) in output_for_test_items
                output_for_ti_as_string = String(take!(v))

                if length(output_for_ti_as_string) > 0
                    put!(
                        testprocess_msg_channel,
                        (
                            event = :append_output,
                            testitem_id = something(k, missing),
                            output = replace(output_for_ti_as_string, "\n"=>"\r\n")
                        )
                    )
                end
            end
        end
    catch err
        bt = catch_backtrace()
        if controller.err_handler !== nothing
            controller.err_handler(err, bt)
        else
            Base.display_error(err, bt)
        end
    end

    @debug "Waiting for connection from test process"
    socket = Sockets.accept(server)
    @debug "Connection established"

    endpoint = JSONRPC.JSONRPCEndpoint(socket, socket)

    run(endpoint)

    put!(testprocess_msg_channel, (event=:testprocess_launched, jl_process=jl_process, endpoint=endpoint))

    while true
        msg = try
            JSONRPC.get_next_message(endpoint)
        catch err
            if CancellationTokens.is_cancellation_requested(token)
                break
            else
                rethrow(err)
            end
        end
        # @info "Processing msg from test process" msg

        dispatch_testprocess_msg(endpoint, msg, testprocess_msg_channel)
    end

    # @async try
    #     while true
    #         msg = take!(tp.channel_to_sub)

    #         if msg.source==:controller
    #             if msg.msg.command == :activate
    #                 JSONRPC.send(
    #                     tp.endpoint,
    #                     TestItemServerProtocol.testserver_start_test_run_request_type,
    #                     [tp.test_run_id]
    #                 )




    #                 put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:test_process_status_changed, id=tp.id, status="Idle")))

    #                 put!(tp.activated, true)

    #             elseif msg.msg.command == :cancel
    #                 tp.killed = true
    #                 @info "Now canceling $(tp.id)"
    #                 put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:test_process_status_changed, id=tp.id, status="Canceling")))
    #                 @info "Canceling process $(tp.id)"
    #                 kill(tp.jl_process)

    #                 put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:test_process_terminated, id=tp.id)))
    #                 break
    #             elseif msg.msg.command == :terminate
    #                 tp.killed = true
    #                 @info "Now terminating $(tp.id)"
    #                 put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:test_process_status_changed, id=tp.id, status="Terminating")))
    #                 kill(tp.jl_process)

    #                 if tp.test_run_id!==nothing
    #                     for ti in tp.testitems_to_run
    #                         put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:failed, testitemid=ti.id, testrunid=tp.test_run_id, messages=[TestItemServerProtocol.TestMessage("Test process was terminated.", TestItemServerProtocol.Location(ti.uri, TestItemServerProtocol.Position(ti.line-1, ti.column-1)))])))
    #                     end
    #                 end

    #                 put!(tp.controller_msg_channel, (source=:testprocess, msg=(event=:test_process_terminated, id=tp.id)))
    #                 break
    #             elseif msg.msg.command == :run

    #             else
    #                 error("")
    #             end
    #         else
    #             error("")
    #         end
    #     end
    # catch err
    #     bt = catch_backtrace()
    #     if controller.err_handler !== nothing
    #         controller.err_handler(err, bt)
    #     else
    #         Base.display_error(err, bt)
    #     end
    # end
end
