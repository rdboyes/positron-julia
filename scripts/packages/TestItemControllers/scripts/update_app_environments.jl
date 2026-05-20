julia_versions = [
    "1.0",
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "1.5",
    "1.6",
    "1.7",
    "1.8",
    "1.9",
    "1.10",
    "1.11",
    "1.12"
]

for i in julia_versions
    version_path = normpath(joinpath(@__DIR__, "../testprocess/environments/v$i"))
    mkpath(version_path)

    run(Cmd(`julia +$i --project=. -e 'using Pkg; Pkg.develop(PackageSpec(path="../../TestItemServer"))'`, dir=version_path))
end

version_path = normpath(joinpath(@__DIR__, "../testprocess/environments/fallback"))
mkpath(version_path)
run(Cmd(`julia +nightly --project=. -e 'using Pkg; Pkg.develop(PackageSpec(path="../../TestItemServer"))'`, dir=version_path))

function replace_backslash_in_manifest(version)
    filename = joinpath(@__DIR__, "../testprocess/environments/v$version/Manifest.toml")
    manifest_content = read(filename, String)

    new_content = replace(manifest_content, "\\\\"=>'/')

    write(filename, new_content)
end

replace_backslash_in_manifest("1.0")
replace_backslash_in_manifest("1.1")
