"""
    JSONRPCError

An object representing a JSON-RPC Error.

Fields:
 * code::Int
 * msg::AbstractString
 * data::Any

See Section 5.1 of the JSON RPC 2.0 specification for more information.
"""
struct JSONRPCError <: Exception
    code::Int
    msg::AbstractString
    data::Any
end

"""
    SERVER_ERROR_END

The end of the range of server-reserved errors.

These are JSON-RPC server errors that are free for the taking
for JSON-RPC server implementations. Applications making use of
this library should NOT define new errors in this range.
"""
const SERVER_ERROR_END = -32000

"""
    SERVER_ERROR_START

The start of the range of server-reserved errors.

These are JSON-RPC server errors that are free for the taking
for JSON-RPC server implementations. Applications making use of
this library should NOT define new errors in this range.
"""
const SERVER_ERROR_START = -32099

"""
    PARSE_ERROR

Invalid JSON was received by the server.
An error occurred on the server while parsing the JSON text.
"""
const PARSE_ERROR = -32700

"""
    INVALID_REQUEST

The JSON sent is not a valid Request object.
"""
const INVALID_REQUEST = -32600

"""
    METHOD_NOT_FOUND

The method does not exist / is not available.
"""
const METHOD_NOT_FOUND = -32601

"""
    INVALID_PARAMS

Invalid method parameter(s).
"""
const INVALID_PARAMS = -32602

"""
    INTERNAL_ERROR

Internal JSON-RPC error.
"""
const INTERNAL_ERROR = -32603

"""
   RPCErrorStrings

A `Base.IdDict` containing the mapping of JSON-RPC error codes to a short, descriptive string.

Use this to hook into `showerror(io::IO, ::JSONRPCError)` for display purposes. A default fallback to `"Unknown"` exists.
"""
const RPCErrorStrings = Base.IdDict(
    PARSE_ERROR => "ParseError",
    INVALID_REQUEST => "InvalidRequest",
    METHOD_NOT_FOUND => "MethodNotFound",
    INVALID_PARAMS => "InvalidParams",
    INTERNAL_ERROR => "InternalError",
    [ i => "ServerError" for i in SERVER_ERROR_START:SERVER_ERROR_END]...,
    -32002 => "ServerNotInitialized",
    -32001 => "UnknownErrorCode",
)

function Base.showerror(io::IO, ex::JSONRPCError)
    error_code_as_string = get(RPCErrorStrings, ex.code, "Unknown")

    print(io, error_code_as_string)
    print(io, ": ")
    print(io, ex.msg)
    if ex.data !== nothing
        print(io, " (")
        print(io, ex.data)
        print(io, ")")
    end
end

struct Request
    method::String
    params::Union{Nothing,Dict{String,Any},Vector{Any}}
    id::Union{Nothing,String,Int}
    token::Union{CancellationTokens.CancellationToken,Nothing}
end

mutable struct JSONRPCEndpoint{IOIn <: IO,IOOut <: IO}
    pipe_in::IOIn
    pipe_out::IOOut

    out_msg_queue::Channel{Any}
    in_msg_queue::Channel{Request}

    outstanding_requests::Dict{String,Channel{Any}} # These are requests sent where we are waiting for a response
    cancellation_sources::Dict{Union{String,Int},CancellationTokens.CancellationTokenSource} # These are the cancellation sources for requests that are not finished processing
    no_longer_needed_cancellation_sources::Channel{Union{String,Int}}

    err_handler::Union{Nothing,Function}

    status::Symbol

    read_task::Union{Nothing,Task}
    write_task::Union{Nothing,Task}
end

JSONRPCEndpoint(pipe_in, pipe_out, err_handler = nothing) =
    JSONRPCEndpoint(
        pipe_in,
        pipe_out,
        Channel{Any}(Inf),
        Channel{Request}(Inf),
        Dict{String,Channel{Any}}(),
        Dict{Union{String,Int},CancellationTokens.CancellationTokenSource}(),
        Channel{Union{String,Int}}(Inf),
        err_handler,
        :idle,
        nothing,
        nothing)

function write_transport_layer(stream, response)
    response_utf8 = transcode(UInt8, response)
    n = length(response_utf8)
    write(stream, "Content-Length: $n\r\n\r\n")
    write(stream, response_utf8)
    flush(stream)
end

function read_transport_layer(stream)
    try
        header_dict = Dict{String,String}()
        line = chomp(readline(stream))
        # Check whether the socket was closed
        if line == ""
            return nothing
        end
        while length(line) > 0
            h_parts = split(line, ":")
            header_dict[chomp(h_parts[1])] = chomp(h_parts[2])
            line = chomp(readline(stream))
        end
        message_length = parse(Int, header_dict["Content-Length"])
        message_str = String(read(stream, message_length))
        return message_str
    catch err
        if err isa Base.IOError
            return nothing
        end

        rethrow(err)
    end
end

Base.isopen(x::JSONRPCEndpoint) = x.status != :closed && isopen(x.pipe_in) && isopen(x.pipe_out)

function Base.run(x::JSONRPCEndpoint)
    x.status == :idle || error("Endpoint is not idle.")

    x.write_task = @async try
        try
            for msg in x.out_msg_queue
                if isopen(x.pipe_out)
                    write_transport_layer(x.pipe_out, msg)
                else
                    # TODO Reconsider at some point whether this should be treated as an error.
                    break
                end
            end
        finally
            close(x.out_msg_queue)
        end
    catch err
        bt = catch_backtrace()
        if x.err_handler !== nothing
            x.err_handler(err, bt)
        else
            Base.display_error(stderr, err, bt)
        end
    end

    x.read_task = @async try
        while true
            # First we delete any cancellation sources that are no longer needed. We do it this way to avoid a lock
            while isready(x.no_longer_needed_cancellation_sources)
                no_longer_needed_cs_id = take!(x.no_longer_needed_cancellation_sources)
                delete!(x.cancellation_sources, no_longer_needed_cs_id)
            end

            # Now handle new messages
            message = read_transport_layer(x.pipe_in)

            if message === nothing || x.status == :closed
                break
            end

            message_dict = JSON.parse(message)

            if haskey(message_dict, "method")
                method_name = message_dict["method"]
                params = get(message_dict, "params", nothing)
                id = get(message_dict, "id", nothing)
                cancel_source = id === nothing ? nothing : CancellationTokens.CancellationTokenSource()
                cancel_token = cancel_source === nothing ? nothing : CancellationTokens.get_token(cancel_source)

                if method_name == "\$/cancelRequest"
                    id_of_cancelled_request = params["id"]
                    cs = get(x.cancellation_sources, id_of_cancelled_request, nothing) # We might have sent the response already
                    if cs !== nothing
                        CancellationTokens.cancel(cs)
                    end
                else
                    if id !== nothing
                        x.cancellation_sources[id] = cancel_source
                    end

                    request = Request(
                        method_name,
                        params,
                        id,
                        cancel_token
                    )

                    try
                        put!(x.in_msg_queue, request)
                    catch err
                        if err isa InvalidStateException
                            break
                        else
                            rethrow(err)
                        end
                    end
                end
            else
                # This must be a response
                id_of_request = message_dict["id"]

                channel_for_response = x.outstanding_requests[id_of_request]
                put!(channel_for_response, message_dict)
            end
        end
        
        close(x.in_msg_queue)

        for i in values(x.outstanding_requests)
            close(i)
        end

        x.status = :closed
    catch err
        bt = catch_backtrace()
        if x.err_handler !== nothing
            x.err_handler(err, bt)
        else
            Base.display_error(stderr, err, bt)
        end
    end

    x.status = :running
end

function send_notification(x::JSONRPCEndpoint, method::AbstractString, params)
    check_dead_endpoint!(x)

    message = Dict("jsonrpc" => "2.0", "method" => method, "params" => params)

    message_json = JSON.json(message)

    put!(x.out_msg_queue, message_json)

    return nothing
end

function send_request(x::JSONRPCEndpoint, method::AbstractString, params)
    check_dead_endpoint!(x)

    id = string(UUIDs.uuid4())
    message = Dict("jsonrpc" => "2.0", "method" => method, "params" => params, "id" => id)

    response_channel = Channel{Any}(1)
    x.outstanding_requests[id] = response_channel

    message_json = JSON.json(message)

    put!(x.out_msg_queue, message_json)

    response = take!(response_channel)

    if haskey(response, "result")
        return response["result"]
    elseif haskey(response, "error")
        error_code = response["error"]["code"]
        error_msg = response["error"]["message"]
        error_data = get(response["error"], "data", nothing)
        throw(JSONRPCError(error_code, error_msg, error_data))
    else
        throw(JSONRPCError(0, "ERROR AT THE TRANSPORT LEVEL", nothing))
    end
end

function get_next_message(endpoint::JSONRPCEndpoint)
    check_dead_endpoint!(endpoint)

    msg = take!(endpoint.in_msg_queue)

    return msg
end

function Base.iterate(endpoint::JSONRPCEndpoint, state = nothing)
    check_dead_endpoint!(endpoint)

    try
        return take!(endpoint.in_msg_queue), nothing
    catch err
        if err isa InvalidStateException
            return nothing
        else
            rethrow(err)
        end
    end
end

function send_success_response(endpoint, original_request::Request, result)
    check_dead_endpoint!(endpoint)

    original_request.id === nothing && error("Cannot send a response to a notification.")

    put!(endpoint.no_longer_needed_cancellation_sources, original_request.id)

    response = Dict("jsonrpc" => "2.0", "id" => original_request.id, "result" => result)

    response_json = JSON.json(response)

    put!(endpoint.out_msg_queue, response_json)
end

function send_error_response(endpoint, original_request::Request, code, message, data)
    check_dead_endpoint!(endpoint)

    original_request.id === nothing && error("Cannot send a response to a notification.")

    put!(endpoint.no_longer_needed_cancellation_sources, original_request.id)

    response = Dict("jsonrpc" => "2.0", "id" => original_request.id, "error" => Dict("code" => code, "message" => message, "data" => data))

    response_json = JSON.json(response)

    put!(endpoint.out_msg_queue, response_json)
end

function Base.close(endpoint::JSONRPCEndpoint)
    endpoint.status == :closed && return

    flush(endpoint)

    endpoint.status = :closed
    isopen(endpoint.in_msg_queue) && close(endpoint.in_msg_queue)
    isopen(endpoint.out_msg_queue) && close(endpoint.out_msg_queue)

    fetch(endpoint.write_task)
    # TODO we would also like to close the read Task
    # But unclear how to do that without also closing
    # the socket, which we don't want to do
    # fetch(endpoint.read_task)
end

function Base.flush(endpoint::JSONRPCEndpoint)
    check_dead_endpoint!(endpoint)

    while isready(endpoint.out_msg_queue)
        yield()
    end
end

function check_dead_endpoint!(endpoint)
    status = endpoint.status
    status === :running && return
    error("Endpoint is not running, the current state is $(status).")
end
