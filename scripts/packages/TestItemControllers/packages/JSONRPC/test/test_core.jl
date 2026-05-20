@testitem "Core" begin
    @test sprint(showerror, JSONRPC.JSONRPCError(-32700, "FOO", "BAR")) == "ParseError: FOO (BAR)"
    @test sprint(showerror, JSONRPC.JSONRPCError(-32600, "FOO", "BAR")) == "InvalidRequest: FOO (BAR)"
    @test sprint(showerror, JSONRPC.JSONRPCError(-32601, "FOO", "BAR")) == "MethodNotFound: FOO (BAR)"
    @test sprint(showerror, JSONRPC.JSONRPCError(-32602, "FOO", "BAR")) == "InvalidParams: FOO (BAR)"
    @test sprint(showerror, JSONRPC.JSONRPCError(-32603, "FOO", "BAR")) == "InternalError: FOO (BAR)"
    @test sprint(showerror, JSONRPC.JSONRPCError(-32002, "FOO", "BAR")) == "ServerNotInitialized: FOO (BAR)"
    @test sprint(showerror, JSONRPC.JSONRPCError(-32001, "FOO", "BAR")) == "UnknownErrorCode: FOO (BAR)"
    @test sprint(showerror, JSONRPC.JSONRPCError(1, "FOO", "BAR")) == "Unknown: FOO (BAR)"
end
