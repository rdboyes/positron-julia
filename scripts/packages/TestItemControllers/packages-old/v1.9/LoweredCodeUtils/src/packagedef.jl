if isdefined(Base, :Experimental) && isdefined(Base.Experimental, Symbol("@optlevel"))
    @eval Base.Experimental.@optlevel 1
end

using Core: SimpleVector
using Core.IR
using Base.Meta: isexpr

const SSAValues = Union{Core.Compiler.SSAValue, JuliaInterpreter.SSAValue}

const trackedheads = (:method,)
const structdecls = (:_structtype, :_abstracttype, :_primitivetype)

export signature, rename_framemethods!, methoddef!, methoddefs!, bodymethod
export CodeEdges, lines_required, lines_required!, selective_eval!, selective_eval_fromstart!

include("utils.jl")
include("signatures.jl")
include("codeedges.jl")
if Base.VERSION < v"1.10"
    include("domtree.jl")
else
    const construct_domtree = Core.Compiler.construct_domtree
    const construct_postdomtree = Core.Compiler.construct_postdomtree
    const postdominates = Core.Compiler.postdominates
    const nearest_common_dominator = Core.Compiler.nearest_common_dominator
end

# precompilation

if ccall(:jl_generating_output, Cint, ()) == 1
    ex = :(f(x; color::Symbol=:green) = 2x)
    lwr = Meta.lower(@__MODULE__, ex)
    frame = Frame(@__MODULE__, lwr.args[1])
    rename_framemethods!(frame)
    ex = quote
        s = 0
        k = 5
        for i = 1:3
            global s, k
            s += rand(1:5)
            k += i
        end
    end
    lwr = Meta.lower(@__MODULE__, ex)
    src = lwr.args[1]
    edges = CodeEdges(@__MODULE__, src)
    isrequired = lines_required(GlobalRef(@__MODULE__, :s), src, edges)
    lines_required(GlobalRef(@__MODULE__, :s), src, edges; norequire=())
    lines_required(GlobalRef(@__MODULE__, :s), src, edges; norequire=exclude_named_typedefs(src, edges))
    for isreq in (isrequired, convert(Vector{Bool}, isrequired))
        lines_required!(isreq, src, edges; norequire=())
        lines_required!(isreq, src, edges; norequire=exclude_named_typedefs(src, edges))
    end
    frame = Frame(@__MODULE__, src)
    # selective_eval_fromstart!(frame, isrequired, true)
    precompile(selective_eval_fromstart!, (typeof(frame), typeof(isrequired), Bool))  # can't @eval during precompilation
    print_with_code(Base.inferencebarrier(devnull)::IO, src, edges)
    print_with_code(Base.inferencebarrier(devnull)::IO, src, isrequired)
end
