if isdefined(Base, :Experimental) && isdefined(Base.Experimental, Symbol("@optlevel"))
    @eval Base.Experimental.@optlevel 1
end

using Core: SimpleVector, CodeInfo, NewvarNode, GotoNode
using Base.Meta: isexpr

const SSAValues = Union{Core.Compiler.SSAValue, JuliaInterpreter.SSAValue}

const structheads = VERSION >= v"1.5.0-DEV.702" ? () : (:struct_type, :abstract_type, :primitive_type)
const trackedheads = (:method, structheads...)
const structdecls = (:_structtype, :_abstracttype, :_primitivetype)

export signature, rename_framemethods!, methoddef!, methoddefs!, bodymethod
export CodeEdges, lines_required, lines_required!, selective_eval!, selective_eval_fromstart!

include("utils.jl")
include("signatures.jl")
include("codeedges.jl")

# precompilation

if ccall(:jl_generating_output, Cint, ()) == 1
    kwdefine = NamedTuple{(:define,),Tuple{Bool}}
    for ct in (Vector{Any}, Set{Any})
        f = methoddef!
        m = which(f, Tuple{Function, ct, Frame, Expr, Int})
        @assert precompile(Tuple{typeof(f), Function, ct, Frame, Expr, Int})
        mbody = bodymethod(m)
        # @assert precompile(Tuple{mbody.sig.parameters[1], Bool, typeof(f), Function, ct, Frame, Expr, Int})
        @assert precompile(Tuple{Core.kwftype(typeof(f)), kwdefine, typeof(f), Function, ct, Frame, Expr, Int})
        f = methoddefs!
        @assert precompile(Tuple{typeof(f), Any, ct, Frame})
        @assert precompile(Tuple{Core.kwftype(typeof(f)), kwdefine, typeof(f), Function, ct, Frame})
    end
    @assert precompile(Tuple{typeof(rename_framemethods!), Any, Frame, Dict{Symbol,MethodInfo},
                             Vector{SelfCall}, Dict{Symbol,Union{Nothing, Bool, Symbol}}})
    @assert precompile(Tuple{typeof(rename_framemethods!), Any, Frame, Dict{Symbol,MethodInfo},
                             Vector{NamedTuple{(:linetop, :linebody, :callee, :caller),Tuple{Int64,Int64,Symbol,Union{Bool, Symbol}}}},
                             Dict{Symbol,Union{Bool, Symbol}}})
    @assert precompile(Tuple{typeof(identify_framemethod_calls), Frame})
    @assert precompile(Tuple{typeof(callchain), Vector{SelfCall}})
    @assert precompile(Tuple{typeof(callchain), Vector{NamedTuple{(:linetop, :linebody, :callee, :caller),Tuple{Int64,Int64,Symbol,Union{Bool, Symbol}}}}})

    @assert precompile(CodeLinks, (Int, Int))
    @assert precompile(CodeEdges, (Int,))
    @assert precompile(CodeEdges, (CodeInfo,))
    @assert precompile(add_links!, (Pair{Union{SSAValue,SlotNumber,NamedVar},Links}, Any, CodeLinks))
    @assert precompile(lines_required!, (Vector{Bool}, Set{NamedVar}, CodeInfo, CodeEdges))

    precompile(Tuple{typeof(setindex!),Dict{Union{GlobalRef, Symbol},Links},Links,Symbol})
    precompile(Tuple{typeof(setindex!),Dict{Union{GlobalRef, Symbol},Variable},Variable,Symbol})
end
