@testitem "Dynamic message dispatcher" setup=[TestStructs] begin
    using Sockets
    using .TestStructs: Foo, Foo2

    global_socket_name1 = JSONRPC.generate_pipe_name()

    request1_type = JSONRPC.RequestType("request1", Foo, String)
    request2_type = JSONRPC.RequestType("request2", Nothing, String)
    notify1_type = JSONRPC.NotificationType("notify1", Vector{String})

    global g_var = ""

    server_is_up = Base.Condition()

    server_task = @async try
        server = listen(global_socket_name1)
        notify(server_is_up)
        sock = accept(server)
        global conn = JSONRPC.JSONRPCEndpoint(sock, sock)
        global msg_dispatcher = JSONRPC.MsgDispatcher()

        msg_dispatcher[request1_type] = (conn, params, token) -> begin
            @test JSONRPC.is_currently_handling_msg(msg_dispatcher)
            params.fieldA == 1 ? "YES" : "NO"
        end
        msg_dispatcher[request2_type] = (conn, params, token) -> JSONRPC.JSONRPCError(-32600, "Our message", nothing)
        msg_dispatcher[notify1_type] = (conn, params) -> global g_var = params[1]

        run(conn)

        for msg in conn
            @info "Got a message, now dispatching" msg
            JSONRPC.dispatch_msg(conn, msg_dispatcher, msg)
            @info "Finished dispatching"
        end
    catch err
        Base.display_error(stderr, err, catch_backtrace())
        Base.flush(stderr)
    end

    wait(server_is_up)

    sock2 = connect(global_socket_name1)
    conn2 = JSONRPCEndpoint(sock2, sock2)

    run(conn2)

    JSONRPC.send(conn2, notify1_type, ["TEST"])

    res = JSONRPC.send(conn2, request1_type, Foo(fieldA=1, fieldB="FOO"))

    @test res == "YES"
    @test g_var == "TEST"

    @test_throws JSONRPC.JSONRPCError(-32600, "Our message", nothing) JSONRPC.send(conn2, request2_type, nothing)

    close(conn2)
    close(sock2)
    close(conn)

    fetch(server_task)

    # Now we test a faulty server

    global_socket_name2 = JSONRPC.generate_pipe_name()

    server_is_up = Base.Condition()

    server_task2 = @async try
        server = listen(global_socket_name2)
        notify(server_is_up)
        sock = accept(server)
        global conn = JSONRPC.JSONRPCEndpoint(sock, sock)
        global msg_dispatcher = JSONRPC.MsgDispatcher()

        msg_dispatcher[request2_type] = (conn, params, token)->34 # The request type requires a `String` return, so this tests whether we get an error.

        run(conn)

        for msg in conn
            @test_throws ErrorException("The handler for the 'request2' request returned a value of type $Int, which is not a valid return type according to the request definition.") JSONRPC.dispatch_msg(conn, msg_dispatcher, msg)
        end
    catch err
        Base.display_error(stderr, err, catch_backtrace())
        Base.flush(stderr)
    end

    wait(server_is_up)

    sock2 = connect(global_socket_name2)
    conn2 = JSONRPCEndpoint(sock2, sock2)

    run(conn2)

    @test_throws JSONRPC.JSONRPCError(-32603, "The handler for the 'request2' request returned a value of type $Int, which is not a valid return type according to the request definition.", nothing) JSONRPC.send(conn2, request2_type, nothing)

    close(conn2)
    close(sock2)
    close(conn)

    fetch(server_task)

end

@testitem "check response type" begin
    using JSONRPC: typed_res
    
    @test typed_res(nothing, Nothing) isa Nothing
    @test typed_res([1,"2",3], Vector{Any}) isa Vector{Any}
    @test typed_res([1,2,3], Vector{Int}) isa Vector{Int}
    @test typed_res([1,2,3], Vector{Float64}) isa Vector{Float64}
    @test typed_res(['f','o','o'], String) isa String
    @test typed_res("foo", String) isa String
end

@testitem "Static message dispatcher" setup=[TestStructs] begin
    using Sockets
    using .TestStructs: Foo, Foo2
    
    global_socket_name1 = JSONRPC.generate_pipe_name()

    request1_type = JSONRPC.RequestType("request1", Foo, String)
    request2_type = JSONRPC.RequestType("request2", Nothing, String)
    notify1_type = JSONRPC.NotificationType("notify1", Vector{String})

    global g_var = ""

    server_is_up = Base.Condition()

    JSONRPC.@message_dispatcher my_dispatcher begin
        request1_type => (params, token) -> begin
            params.fieldA == 1 ? "YES" : "NO"
        end
        request2_type => (params, token) -> JSONRPC.JSONRPCError(-32600, "Our message", nothing)
        notify1_type => (params) -> global g_var = params[1]
    end

    server_task = @async try
        server = listen(global_socket_name1)
        notify(server_is_up)
        sock = accept(server)
        global conn = JSONRPC.JSONRPCEndpoint(sock, sock)
        global msg_dispatcher = JSONRPC.MsgDispatcher()

        run(conn)

        for msg in conn
            my_dispatcher(conn, msg)
        end
    catch err
        Base.display_error(stderr, err, catch_backtrace())
    end

    wait(server_is_up)

    sock2 = connect(global_socket_name1)
    conn2 = JSONRPCEndpoint(sock2, sock2)

    run(conn2)

    JSONRPC.send(conn2, notify1_type, ["TEST"])

    res = JSONRPC.send(conn2, request1_type, Foo(fieldA=1, fieldB="FOO"))

    @test res == "YES"
    @test g_var == "TEST"

    @test_throws JSONRPC.JSONRPCError(-32600, "Our message", nothing) JSONRPC.send(conn2, request2_type, nothing)

    close(conn2)
    close(sock2)
    close(conn)

    fetch(server_task)

    # Now we test a faulty server

    global_socket_name2 = JSONRPC.generate_pipe_name()

    server_is_up = Base.Condition()

    JSONRPC.@message_dispatcher my_dispatcher2 begin
        request2_type => (params, token) -> 34 # The request type requires a `String` return, so this tests whether we get an error.
    end

    server_task2 = @async try
        server = listen(global_socket_name2)
        notify(server_is_up)
        sock = accept(server)
        global conn = JSONRPC.JSONRPCEndpoint(sock, sock)
        global msg_dispatcher = JSONRPC.MsgDispatcher()

        run(conn)

        for msg in conn
            @test_throws ErrorException("The handler for the 'request2' request returned a value of type $Int, which is not a valid return type according to the request definition.") my_dispatcher2(conn, msg)
        end
    catch err
        Base.display_error(stderr, err, catch_backtrace())
    end

    wait(server_is_up)

    sock2 = connect(global_socket_name2)
    conn2 = JSONRPCEndpoint(sock2, sock2)

    run(conn2)

    @test_throws JSONRPC.JSONRPCError(-32603, "The handler for the 'request2' request returned a value of type $Int, which is not a valid return type according to the request definition.", nothing) JSONRPC.send(conn2, request2_type, nothing)

    close(conn2)
    close(sock2)
    close(conn)

    fetch(server_task)

end
