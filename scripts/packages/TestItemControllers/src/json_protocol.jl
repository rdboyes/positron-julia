module TestItemControllerProtocol

import ..JSONRPC

using ..JSONRPC: @dict_readable, RequestType, NotificationType, Outbound

@dict_readable struct TestProfile
    id::String
    label::String
    juliaCmd::String
    juliaArgs::Vector{String}
    juliaNumThreads::Union{Missing,String}
    juliaEnv::Dict{String,Union{String,Nothing}}
    maxProcessCount::Int
    mode::String
    coverageRootUris::Union{Missing,Vector{String}}
end

@dict_readable struct TestItemDetail
    id::String
    uri::String
    label::String
    packageName::Union{Missing,String}
    packageUri::Union{Missing,String}
    projectUri::Union{Missing,String}
    envContentHash::Union{Missing,String}
    useDefaultUsings::Bool
    testSetups::Vector{String}
    line::Int
    column::Int
    code::String
    codeLine::Int
    codeColumn::Int
end

@dict_readable struct TestSetupDetail
    packageUri::Union{Missing,String}
    name::String
    kind::String
    uri::String
    line::Int
    column::Int
    code::String
end

@dict_readable struct CreateTestRunParams
    testRunId::String
    testProfiles::Vector{TestProfile}
    testItems::Vector{TestItemDetail}
    testSetups::Vector{TestSetupDetail}
end

@dict_readable struct FileCoverage <: JSONRPC.Outbound
    uri::String
    coverage::Vector{Union{Int,Nothing}}
end

@dict_readable struct CreateTestRunResponse <: JSONRPC.Outbound
    status::String
    coverage::Union{Missing,Vector{FileCoverage}}
end

const create_testrun_request_type = RequestType("createTestRun", CreateTestRunParams, CreateTestRunResponse)

@dict_readable struct CancelTestRunParams
    testRunId::String
end

const cancel_testrun_notificationType = NotificationType("cancelTestRun", CancelTestRunParams)

@dict_readable struct TerminateTestProcessParams
    testProcessId::String
end

const terminate_test_process_request_type = RequestType("terminateTestProcess", TerminateTestProcessParams, Nothing)

@dict_readable struct TestMessage
    message::String
    expectedOutput::Union{Missing,String}
    actualOutput::Union{Missing,String}
    uri::Union{Missing,String}
    line::Union{Missing,Int}
    column::Union{Missing,Int}
end

@dict_readable struct TestItemStartedParams <: Outbound
    testRunId::String
    testItemId::String
end


const notficiationTypeTestItemStarted = NotificationType("testItemStarted", TestItemStartedParams)

@dict_readable struct TestItemErroredParams <: Outbound
    testRunId::String
    testItemId::String
    messages::Vector{TestMessage}
    duration::Union{Missing,Float64}
end
const notficiationTypeTestItemErrored = NotificationType("testItemErrored", TestItemErroredParams)

@dict_readable struct TestItemFailedParams <: Outbound
    testRunId::String
    testItemId::String
    messages::Vector{TestMessage}
    duration::Union{Missing,Float64}
end
const notficiationTypeTestItemFailed = NotificationType("testItemFailed", TestItemFailedParams)

@dict_readable struct TestItemPassedParams <: Outbound
    testRunId::String
    testItemId::String
    duration::Union{Missing,Float64}
end

const notficiationTypeTestItemPassed = NotificationType("testItemPassed", TestItemPassedParams)
const notficiationTypeTestItemSkipped = NotificationType("testItemSkipped", @NamedTuple{testRunId::String,testItemId::String})

@dict_readable struct AppendOutputParams <: Outbound
    testRunId::String
    testItemId::Union{Missing,String}
    output::String
end

const notficiationTypeAppendOutput = NotificationType("appendOutput", AppendOutputParams)

@dict_readable struct TestProcessCreatedParams
    id::String
    packageName::String
    packageUri::Union{Missing,String}
    projectUri::Union{Missing,String}
    coverage::Bool
    env::Dict{String,Union{String, Nothing}}
end

const notificationTypeTestProcessCreated = NotificationType("testProcessCreated", TestProcessCreatedParams)

const notificationTypeTestProcessTerminated = NotificationType("testProcessTerminated", @NamedTuple{id::String})

@dict_readable struct TestProcessStatusChangedParams
    id::String
    status::String
end

const notificationTypeTestProcessStatusChanged = NotificationType("testProcessStatusChanged", TestProcessStatusChangedParams)

@dict_readable struct TestProcessOutputParams
    id::String
    output::String
end

const notificationTypeTestProcessOutput = NotificationType("testProcessOutput", TestProcessOutputParams)

const notificationTypeLaunchDebugger = NotificationType("launchDebugger", @NamedTuple{debugPipeName::String, testRunId::String})

end
