# ---------------------------------------------------------------------------------------------
# Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

import Pkg

function _positron_json_string(value::AbstractString)::String
    return "\"" * escape_string(value) * "\""
end

function _positron_print_json_string_array(values::Vector{String})
    print("[")
    for (index, value) in pairs(values)
        index > 1 && print(",")
        print(_positron_json_string(value))
    end
    print("]")
end

function _positron_print_json_packages(packages)
    print("[")
    for (index, package) in pairs(packages)
        index > 1 && print(",")
        print("{")
        print("\"id\":", _positron_json_string(package.id), ",")
        print("\"name\":", _positron_json_string(package.name), ",")
        print("\"displayName\":", _positron_json_string(package.displayName), ",")
        print("\"version\":", _positron_json_string(package.version), ",")
        print("\"attached\":", package.attached ? "true" : "false")
        print("}")
    end
    print("]")
end

function _positron_explicitly_loaded_names()
    # Modules explicitly `using`-ed into Main (excludes transitive deps).
    # Wrapped in try-catch since module_usings is an internal API.
    loaded = try
        Set{String}(
            string(nameof(m))
            for m in Base.module_usings(Main)
            if m !== Base && m !== Core
        )
    catch
        Set{String}()
    end

    # Modules explicitly `import`-ed (bound by name in Main, not via using).
    for sym in names(Main; imported=true)
        isdefined(Main, sym) || continue
        val = try; getfield(Main, sym); catch; continue; end
        val isa Module || continue
        val === Main && continue
        val === Base && continue
        val === Core && continue
        push!(loaded, string(sym))
    end

    return loaded
end

function _positron_list_packages(direct_only::Bool=true)
    explicitly_loaded = _positron_explicitly_loaded_names()
    packages = NamedTuple{(:id, :name, :displayName, :version, :attached), Tuple{String,String,String,String,Bool}}[]
    for package_info in values(Pkg.dependencies())
        if direct_only && !package_info.is_direct_dep
            continue
        end
        name = package_info.name
        version = string(package_info.version)
        push!(packages, (
            id = "$(name)-$(version)",
            name = name,
            displayName = name,
            version = version,
            attached = name in explicitly_loaded,
        ))
    end
    sort!(packages, by = package -> lowercase(package.name))
    _positron_print_json_packages(packages)
end

function _positron_install_packages(specs::Vector{String})
    package_specs = Pkg.PackageSpec[]
    for spec in specs
        pieces = split(spec, "@"; limit=2)
        name = String(strip(pieces[1]))
        isempty(name) && continue
        if length(pieces) == 2 && !isempty(strip(pieces[2]))
            push!(package_specs, Pkg.PackageSpec(name=name, version=String(strip(pieces[2]))))
        else
            push!(package_specs, Pkg.PackageSpec(name=name))
        end
    end
    isempty(package_specs) || Pkg.add(package_specs)
    return nothing
end

function _positron_uninstall_packages(names::Vector{String})
    cleaned = filter(name -> !isempty(strip(name)), strip.(names))
    isempty(cleaned) || Pkg.rm(cleaned)
    return nothing
end

function _positron_update_packages(names::Vector{String})
    cleaned = filter(name -> !isempty(strip(name)), strip.(names))
    isempty(cleaned) || Pkg.update(cleaned)
    return nothing
end

function _positron_update_all_packages()
    Pkg.update()
    return nothing
end

function _positron_latest_registry_version(entry)
    info = Pkg.Registry.registry_info(entry)
    isempty(info.version_info) && return "0"
    return string(maximum(keys(info.version_info)))
end

function _positron_search_packages(query::String)
    query = lowercase(strip(query))
    if isempty(query)
        _positron_print_json_packages(NamedTuple{(:id, :name, :displayName, :version, :attached), Tuple{String,String,String,String,Bool}}[])
        return
    end

    by_name = Dict{String, String}()

    for registry in Pkg.Registry.reachable_registries()
        for entry in values(registry.pkgs)
            package_name = entry.name
            occursin(query, lowercase(package_name)) || continue

            version = try
                _positron_latest_registry_version(entry)
            catch
                "0"
            end

            previous = get(by_name, package_name, nothing)
            if previous === nothing
                by_name[package_name] = version
            elseif previous != version
                try
                    if previous == "0" || VersionNumber(version) > VersionNumber(previous)
                        by_name[package_name] = version
                    end
                catch
                    # Keep the existing version if parsing fails.
                end
            end
        end
    end

    packages = NamedTuple{(:id, :name, :displayName, :version, :attached), Tuple{String,String,String,String,Bool}}[]
    for (name, version) in by_name
        push!(packages, (
            id = "$(name)-$(version)",
            name = name,
            displayName = name,
            version = version,
            attached = false,
        ))
    end
    sort!(packages, by = package -> lowercase(package.name))
    _positron_print_json_packages(packages)
end

function _positron_print_json_metadata(by_name::Dict{String,String})
    print("{")
    first = true
    for (name, version) in by_name
        first || print(",")
        first = false
        print(_positron_json_string(lowercase(name)), ":{")
        print("\"latestVersion\":", _positron_json_string(version))
        print("}")
    end
    print("}")
end

function _positron_package_metadata(names::Vector{String})
    # Match registry entries case-insensitively so callers can pass either
    # canonical (`Revise`) or lower-cased (`revise`) package names.
    targets = Set{String}()
    for raw in names
        cleaned = strip(raw)
        isempty(cleaned) || push!(targets, lowercase(String(cleaned)))
    end
    by_name = Dict{String,String}()

    if isempty(targets)
        _positron_print_json_metadata(by_name)
        return
    end

    for registry in Pkg.Registry.reachable_registries()
        for entry in values(registry.pkgs)
            lowercase(entry.name) in targets || continue

            version = try
                _positron_latest_registry_version(entry)
            catch
                "0"
            end

            previous = get(by_name, entry.name, nothing)
            if previous === nothing
                by_name[entry.name] = version
            elseif previous != version
                try
                    if previous == "0" || VersionNumber(version) > VersionNumber(previous)
                        by_name[entry.name] = version
                    end
                catch
                    # Keep the existing version if parsing fails.
                end
            end
        end
    end

    _positron_print_json_metadata(by_name)
end

function _positron_search_package_versions(name::String)
    target = lowercase(strip(name))
    versions = Set{VersionNumber}()

    if isempty(target)
        _positron_print_json_string_array(String[])
        return
    end

    for registry in Pkg.Registry.reachable_registries()
        for entry in values(registry.pkgs)
            lowercase(entry.name) == target || continue
            info = try
                Pkg.Registry.registry_info(entry)
            catch
                continue
            end
            union!(versions, keys(info.version_info))
        end
    end

    sorted_versions = sort!(collect(versions); rev=true)
    _positron_print_json_string_array(string.(sorted_versions))
end
