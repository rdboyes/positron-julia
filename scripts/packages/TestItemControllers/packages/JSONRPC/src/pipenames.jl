function generate_pipe_name()
    if Sys.iswindows()
        return "\\\\.\\pipe\\jl-$(UUIDs.uuid4())"
    else
        return tempname()
    end
end
