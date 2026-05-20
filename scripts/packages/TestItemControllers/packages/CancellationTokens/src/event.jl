@static if VERSION < v"1.1"
    mutable struct Event
        lock::Base.Threads.Mutex
        q::Vector{Task}
        set::Bool
        # TODO: use a Condition with its paired lock
        Event() = new(Base.Threads.Mutex(), Task[], false)
    end
    
    function Base.wait(e::Event)
        e.set && return
        lock(e.lock)
        while !e.set
            ct = current_task()
            push!(e.q, ct)
            unlock(e.lock)
            try
                wait()
            catch
                filter!(x->x!==ct, e.q)
                rethrow()
            end
            lock(e.lock)
        end
        unlock(e.lock)
        return nothing
    end
    
    function Base.notify(e::Event)
        lock(e.lock)
        if !e.set
            e.set = true
            for t in e.q
                schedule(t)
            end
            empty!(e.q)
        end
        unlock(e.lock)
        return nothing
    end
elseif VERSION < v"1.2"
    using Base.Threads: Event
else
    using Base: Event
end
