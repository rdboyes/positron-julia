struct TestEnvironment
    project_uri:: Union{Nothing,String}
    package_uri::String
    package_name::String
    juliaCmd::String
    juliaArgs::Vector{String}
    juliaNumThreads::Union{Missing,String}
    mode::String
    env::Dict{String,Union{String,Nothing}}
end

Base.hash(x::TestEnvironment, h::UInt) = hash(x.env, hash(x.mode, hash(x.juliaNumThreads, hash(x.juliaArgs, hash(x.juliaCmd, hash(x.package_name, hash(x.package_uri, hash(x.project_uri, hash(:TestEnvironment, h)))))))))
Base.:(==)(a::TestEnvironment, b::TestEnvironment) = a.project_uri == b.project_uri && a.package_uri == b.package_uri && a.package_name == b.package_name && a.juliaCmd == b.juliaCmd && a.juliaArgs == b.juliaArgs && a.juliaNumThreads == b.juliaNumThreads && a.mode == b.mode && a.env == b.env
Base.isequal(a::TestEnvironment, b::TestEnvironment) = isequal(a.project_uri, b.project_uri) && isequal(a.package_uri, b.package_uri) && isequal(a.package_name, b.package_name) && isequal(a.juliaCmd, b.juliaCmd) && isequal(a.juliaArgs, b.juliaArgs) && isequal(a.juliaNumThreads, b.juliaNumThreads) && isequal(a.mode, b.mode) && isequal(a.env, b.env)
