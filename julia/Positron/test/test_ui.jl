# ---------------------------------------------------------------------------------------------
# Copyright (C) 2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

using Test

@testset "UI Service Tests" begin
    @testset "alias_home" begin
        home = homedir()

        @test Positron.alias_home("") == ""
        @test Positron.alias_home(home) == "~"

        child = joinpath(home, "positron-julia-test")
        aliased_child = Positron.alias_home(child)
        @test startswith(aliased_child, "~")
        @test startswith(aliased_child, "~" * Base.Filesystem.path_separator)
        @test endswith(aliased_child, "positron-julia-test")

        outside = joinpath(splitdrive(homedir())[1] * Base.Filesystem.path_separator, "outside-home")
        @test Positron.alias_home(outside) == outside
    end

    @testset "init!" begin
        service = Positron.UIService()
        comm = Positron.PositronComm("ui")
        service.working_directory = "stale-directory"
        Positron.init!(service, comm)

        @test service.comm === comm
        @test service.working_directory === nothing
    end

    @testset "poll_working_directory!" begin
        service = Positron.UIService()

        old_cwd = pwd()
        try
            Positron.poll_working_directory!(service)
            @test service.working_directory == pwd()

            # Working directory should not change when cwd has not changed.
            current = service.working_directory
            Positron.poll_working_directory!(service)
            @test service.working_directory == current

            mktempdir() do dir
                cd(dir)
                Positron.poll_working_directory!(service)
                @test realpath(service.working_directory) == realpath(dir)
            end
        finally
            cd(old_cwd)
        end
    end
end
