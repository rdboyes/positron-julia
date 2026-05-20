using Test: get_test_counts
using CancellationTokens
using Test

@testset "CancellationTokens" begin

    src = CancellationTokenSource()
    cancel(src)
    wait(get_token(src))

    src = CancellationTokenSource()
    @async begin
        sleep(0.1)
        cancel(src)
    end
    wait(get_token(src))

    src = CancellationTokenSource(0.1)
    wait(get_token(src))

    src = CancellationTokenSource()
    @async begin
        sleep(0.1)
        cancel(src)
    end
    wait(get_token(src))

    src = CancellationTokenSource()
    sleep(0.1, get_token(src))

    src = CancellationTokenSource()
    @async begin
        sleep(0.1)
        cancel(src)
    end
    @test_throws OperationCanceledException sleep(20.0, get_token(src))
end
