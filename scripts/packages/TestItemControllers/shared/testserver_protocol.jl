module TestItemServerProtocol

import ..JSONRPC
import ..JSONRPC.JSON

using ..JSONRPC: @dict_readable, RequestType, NotificationType, Outbound

@dict_readable struct Position <: JSONRPC.Outbound
    line::Int
    character::Int
end

struct Range
    start::Position
    stop::Position
end
function Range(d::Dict)
    Range(Position(d["start"]), Position(d["end"]))
end
function JSON.lower(a::Range)
    Dict("start" => a.start, "end" => a.stop)
end

@dict_readable struct Location <: JSONRPC.Outbound
    uri::String
    position::Position
end

@dict_readable struct TestMessage <: JSONRPC.Outbound
    message::String
    expectedOutput::Union{String,Missing}
    actualOutput::Union{String,Missing}
    location::Location
end

TestMessage(message, location) = TestMessage(message, missing, missing, location)

@dict_readable struct RunTestItem <: JSONRPC.Outbound
    id::String
    uri::String
    name::String
    packageName::String
    packageUri::String
    useDefaultUsings::Bool
    testSetups::Vector{String}
    line::Int
    column::Int
    code::String
end

struct FileCoverage <: JSONRPC.Outbound
    uri::String
    coverage::Vector{Union{Int,Nothing}}
end

function FileCoverage(d::Dict)
    return FileCoverage(
        d["uri"],
        Union{Int,Nothing}[i for i in d["coverage"]]
    )
end

@dict_readable struct TestsetupDetails <: JSONRPC.Outbound
    packageUri::String
    name::String
    kind::String
    uri::String
    line::Int
    column::Int
    code::String
end

@dict_readable struct ConfigureTestRunRequestParams <: JSONRPC.Outbound
    mode::String
    coverageRootUris::Union{Missing,Vector{String}}
    testSetups::Union{Missing,Vector{TestsetupDetails}}
end

@dict_readable struct RunTestItemsRequestParams <: JSONRPC.Outbound
    mode::String
    coverageRootUris::Union{Vector{String},Missing}
    testItems::Vector{RunTestItem}
end

@dict_readable struct StealTestItemsRequestParams <: JSONRPC.Outbound
    testItemIds::Vector{String}
end

@dict_readable struct ActivateEnvParams <: JSONRPC.Outbound
    projectUri::Union{Missing,String}
    packageUri::String
    packageName::String
end

@dict_readable struct StartedParams <: JSONRPC.Outbound
    testItemId::String
end

@dict_readable struct PassedParams <: JSONRPC.Outbound
    testItemId::String
    duration::Float64
    coverage::Union{Missing,Vector{FileCoverage}}
end

@dict_readable struct ErroredParams <: JSONRPC.Outbound
    testItemId::String
    messages::Vector{TestMessage}
    duration::Union{Float64,Missing}
end

@dict_readable struct FailedParams <: JSONRPC.Outbound
    testItemId::String
    messages::Vector{TestMessage}
    duration::Union{Float64,Missing}
end

@dict_readable struct SkippedStolenParams <: JSONRPC.Outbound
    testItemId::String
end

# Messages from the controller to the test process
const testserver_revise_request_type = JSONRPC.RequestType("testserver/revise", Nothing, String)
const testserver_activate_env_request_type = JSONRPC.RequestType("activateEnv", ActivateEnvParams, Nothing)
const configure_testrun_request_type = JSONRPC.RequestType("testserver/ConfigureTestRun", ConfigureTestRunRequestParams, Nothing)
const testserver_run_testitems_batch_request_type = JSONRPC.RequestType("testserver/runTestItems", RunTestItemsRequestParams, Nothing)
const testserver_steal_testitems_request_type = JSONRPC.RequestType("testserver/stealTestItems", StealTestItemsRequestParams, Nothing)
const testserver_shutdown_request_type = JSONRPC.RequestType("testserver/shutdown", Nothing, Nothing)

# Messages from the test process to the controller
const started_notification_type = JSONRPC.NotificationType("started", StartedParams)
const passed_notification_type = JSONRPC.NotificationType("passed", PassedParams)
const errored_notification_type = JSONRPC.NotificationType("errored", ErroredParams)
const failed_notification_type = JSONRPC.NotificationType("failed", FailedParams)
const skipped_stolen_notification_type = JSONRPC.NotificationType("skippedStolen", SkippedStolenParams)

end
