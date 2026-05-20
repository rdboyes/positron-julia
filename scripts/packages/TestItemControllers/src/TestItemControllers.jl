module TestItemControllers

import Sockets, UUIDs

include("../packages/URIParser/src/URIParser.jl")
include("../packages/CoverageTools/src/CoverageTools.jl")
include("../packages/JSON/src/JSON.jl")
include("../packages/CancellationTokens//src/CancellationTokens.jl")

module JSONRPC
    import ..CancellationTokens
    import ..JSON
    import UUIDs
    include("../packages/JSONRPC/src/packagedef.jl")
end

export JSONRPCTestItemController

include("json_protocol.jl")
include("../shared/testserver_protocol.jl")
include("../shared/urihelper.jl")

include("testenvironment.jl")
include("testprocess.jl")
include("testitemcontroller.jl")
include("jsonrpctestitemcontroller.jl")


end # module TestItemControllers
