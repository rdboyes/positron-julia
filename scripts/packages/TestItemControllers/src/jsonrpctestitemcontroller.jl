mutable struct JSONRPCTestItemController{ERR_HANDLER<:Function}
    err_handler::Union{Nothing,ERR_HANDLER}
    endpoint::JSONRPC.JSONRPCEndpoint
    controller::TestItemController

    function JSONRPCTestItemController(
        pipe_in,
        pipe_out,
        err_handler::ERR_HANDLER;
        error_handler_file=nothing,
        crash_reporting_pipename=nothing) where {ERR_HANDLER<:Union{Function,Nothing}}

        endpoint = JSONRPC.JSONRPCEndpoint(pipe_in, pipe_out, err_handler)

        return new{ERR_HANDLER}(
            err_handler,
            endpoint,
            TestItemController(err_handler; error_handler_file=error_handler_file, crash_reporting_pipename=crash_reporting_pipename)
        )
    end
end

function create_testrun_request(params::TestItemControllerProtocol.CreateTestRunParams, jr_controller::JSONRPCTestItemController, token)
    ret =  execute_testrun(
        jr_controller.controller,
        params.testRunId,
        [
            TestProfile(
                i.id,
                i.label,
                i.juliaCmd,
                i.juliaArgs,
                i.juliaNumThreads,
                i.juliaEnv,
                i.maxProcessCount,
                i.mode,
                coalesce(i.coverageRootUris,nothing)
            ) for i in params.testProfiles
        ],
        [
            TestItemDetail(
                i.id,
                i.uri,
                i.label,
                coalesce(i.packageName, nothing),
                coalesce(i.packageUri, nothing),
                coalesce(i.projectUri, nothing),
                coalesce(i.envContentHash, nothing),
                i.useDefaultUsings,
                i.testSetups,
                i.line,
                i.column,
                i.code,
                i.codeLine,
                i.codeColumn
            )
            for i in params.testItems
        ],
        [
            TestSetupDetail(
                coalesce(i.packageUri, nothing),
                i.name,
                i.kind,
                i.uri,
                i.line,
                i.column,
                i.code
            ) for i in params.testSetups
        ],
        # testitem_started_callback,
        (testrun_id, testitem_id) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notficiationTypeTestItemStarted,
            TestItemControllerProtocol.TestItemStartedParams(
                testRunId=testrun_id,
                testItemId=testitem_id
            )
        ),
        # testitem_passed_callback
        (testrun_id, testitem_id, duration) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notficiationTypeTestItemPassed,
            TestItemControllerProtocol.TestItemPassedParams(
                testRunId=testrun_id,
                testItemId=testitem_id,
                duration=duration
            )
        ),
        # testitem_failed_callback
        (testrun_id, testitem_id, messages, duration) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notficiationTypeTestItemFailed,
            TestItemControllerProtocol.TestItemFailedParams(
                    testRunId=testrun_id,
                    testItemId=testitem_id,
                    messages = messages,
                    duration=duration
            )
        ),
        # testitem_errored_callback
        (testrun_id, testitem_id, messages, duration) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notficiationTypeTestItemErrored,
            TestItemControllerProtocol.TestItemErroredParams(
                    testRunId=testrun_id,
                    testItemId=testitem_id,
                    messages = messages,
                    duration=duration
            )
        ),
        # append_output_callback
        (testrun_id, testitem_id, output) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notficiationTypeAppendOutput,
            TestItemControllerProtocol.AppendOutputParams(
                testRunId=testrun_id,
                testItemId=testitem_id,
                output=output
            )
        ),
        # attach_debugger_callback
        (testrun_id, debug_pipename) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notificationTypeLaunchDebugger,
            (;
                debugPipeName = debug_pipename,
                testRunId = testrun_id
            )
        ),
        token
    )

    return TestItemControllerProtocol.CreateTestRunResponse("success", ret)
end

function cancel_testrun_notification(params::TestItemControllerProtocol.CancelTestRunParams, controller::JSONRPCTestItemController, token)
    ch = get(controller.testrun_msg_channels, params.testRunId, nothing)
    if ch!==nothing
        put!(
            ch,
            (
                source=:controller,
                msg=(;
                    event=:cancel_test_run,
                )
            )
        )
    end
end

function terminate_test_process_request(params::TestItemControllerProtocol.TerminateTestProcessParams, json_controller::JSONRPCTestItemController, token)
    terminate_test_process(json_controller.controller, params.testProcessId)
end

JSONRPC.@message_dispatcher dispatch_msg begin
    TestItemControllerProtocol.create_testrun_request_type => create_testrun_request
    TestItemControllerProtocol.cancel_testrun_notificationType => cancel_testrun_notification
    TestItemControllerProtocol.terminate_test_process_request_type => terminate_test_process_request
end

function Base.run(jr_controller::JSONRPCTestItemController)
    run(jr_controller.endpoint)

    @async try
        while true
            msg = JSONRPC.get_next_message(jr_controller.endpoint)

            @async try
                dispatch_msg(jr_controller.endpoint, msg, jr_controller)
            catch err
                bt = catch_backtrace()
                if jr_controller.err_handler !== nothing
                    jr_controller.err_handler(err, bt)
                else
                    Base.display_error(err, bt)
                end
            end
        end
    catch err
        bt = catch_backtrace()
        if jr_controller.err_handler !== nothing
            jr_controller.err_handler(err, bt)
        else
            Base.display_error(err, bt)
        end
    end

    run(
        jr_controller.controller,
        (id, package_name, package_uri, project_uri, coverage, env) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notificationTypeTestProcessCreated,
            TestItemControllerProtocol.TestProcessCreatedParams(
                id = id,
                packageName = package_name,
                packageUri = something(package_uri, missing),
                projectUri = something(project_uri, missing),
                coverage = coverage,
                env = env
            )
        ),
        id -> JSONRPC.send(
            jr_controller.endpoint,
            notificationTypeTestProcessTerminated,
            (;id = id)
        ),
        (id, status) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notificationTypeTestProcessStatusChanged,
            TestItemControllerProtocol.TestProcessStatusChangedParams(id = id, status = status)
        ),
        (id, output) -> JSONRPC.send(
            jr_controller.endpoint,
            TestItemControllerProtocol.notificationTypeTestProcessOutput,
            TestItemControllerProtocol.TestProcessOutputParams(id = id, output = output)
        )
    )
end
