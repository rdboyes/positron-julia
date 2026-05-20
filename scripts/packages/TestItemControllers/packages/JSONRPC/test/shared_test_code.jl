@testmodule TestStructs begin
    using JSONRPC: @dict_readable, Outbound

    export Foo, Foo2

    @dict_readable struct Foo <: Outbound
        fieldA::Int
        fieldB::String
        fieldC::Union{Missing,String}
        fieldD::Union{String,Missing}
    end

    @dict_readable struct Foo2 <: Outbound
        fieldA::Union{Nothing,Int}
        fieldB::Vector{Int}
    end

    Base.:(==)(a::Foo2,b::Foo2) = a.fieldA == b.fieldA && a.fieldB == b.fieldB

end
