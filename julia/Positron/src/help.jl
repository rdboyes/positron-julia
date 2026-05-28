# ---------------------------------------------------------------------------------------------
# Copyright (C) 2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

"""
Help service for Positron.

This module provides the Help pane functionality, displaying documentation
for Julia functions, types, and modules.
"""

using Markdown
using Sockets

const HELP_SERVER_MAX_PAGES = 128
const HELP_METHODS_MAX = 25
const HELP_RESOURCES_DIR = normpath(joinpath(@__DIR__, "..", "resources"))
const JULIA_HELP_KEYWORDS = Set([
    "if",
    "else",
    "elseif",
    "while",
    "for",
    "begin",
    "end",
    "let",
    "in",
    "quote",
    "try",
    "catch",
    "finally",
    "return",
    "break",
    "continue",
    "function",
    "macro",
    "module",
    "baremodule",
    "using",
    "import",
    "export",
    "public",
    "const",
    "local",
    "global",
    "where",
    "struct",
    "mutable",
    "abstract",
    "primitive",
    "type",
    "do",
])
const JULIA_HELP_LITERALS = Set(["true", "false", "nothing", "missing", "undef", "NaN", "Inf"])

"""
The Help service manages the Help pane in Positron.
"""
mutable struct HelpService
    comm::Any  # PositronComm or test mock - using Any for testability
    server::Union{Sockets.TCPServer,Nothing}
    server_task::Union{Task,Nothing}
    server_port::Union{Int,Nothing}
    pages::Dict{String,String}
    page_order::Vector{String}
    pages_lock::ReentrantLock

    function HelpService()
        new(
            nothing,
            nothing,
            nothing,
            nothing,
            Dict{String,String}(),
            String[],
            ReentrantLock(),
        )
    end
end

"""
Initialize the help service with a comm.
"""
function init!(service::HelpService, comm::PositronComm)
    service.comm = comm

    on_msg!(comm, msg -> handle_help_msg(service, msg))
    on_close!(comm, () -> handle_help_close(service))
end

"""
Handle incoming messages on the help comm.
"""
function handle_help_msg(service::HelpService, msg::Dict)
    handle_with_logging("Help", service.comm, msg) do
        request = parse_help_request(msg)

        if request isa HelpShowHelpTopicParams
            handle_show_help_topic(service, request.topic)
        end
    end
end

"""
Handle help comm close.
"""
function handle_help_close(service::HelpService)
    stop_help_server!(service)
    service.comm = nothing
end

"""
Handle show_help_topic request - look up documentation and show it in Help pane.
"""
function handle_show_help_topic(service::HelpService, topic::String)
    if service.comm === nothing
        return
    end

    # Get help content for the topic
    content = get_help_content(topic)

    if content === nothing
        send_error(
            service.comm,
            JsonRpcErrorCode.INVALID_PARAMS,
            "No documentation found for: $topic",
        )
        return
    end

    url = publish_help_page!(service, topic, content)
    if url === nothing
        send_error(
            service.comm,
            JsonRpcErrorCode.INTERNAL_ERROR,
            "Unable to publish documentation for: $topic",
        )
        return
    end

    # Send success result first.
    send_result(service.comm, true)

    # Then send a URL-based show_help event (Positron Help pane expects URL kind).
    params = HelpShowHelpParams(url, ShowHelpKind_Url, true)
    send_event(service.comm, "show_help", params)
end

"""
Get help content for a topic.
"""
function get_help_content(topic::String)::Union{String,Nothing}
    # Try to resolve the symbol
    sym = resolve_symbol(topic)
    if sym === nothing
        return nothing
    end

    # Get documentation
    try
        doc_html = fetch_documentation_html(sym)
        if doc_html === nothing || isempty(doc_html)
            return nothing
        end

        doc_html = strip_internal_ref_links(doc_html)
        methods_html = render_methods_html(sym, topic)
        if methods_html === nothing
            return doc_html
        end

        return string(doc_html, methods_html)
    catch
        # Return nothing if help content can't be retrieved
        return nothing
    end
end

"""
Resolve a topic string to a Julia symbol.
"""
function resolve_symbol(topic::String)
    # Handle module-qualified names like "Base.sort"
    parts = split(topic, ".")

    try
        # Start from Main
        current = Main

        # If the top-level package is not defined in Main, check if it is installed
        # in the environment, and if so, dynamically import it.
        first_sym = Symbol(parts[1])
        if !isdefined(Main, first_sym)
            is_installed = false
            try
                if !isdefined(Main, :Pkg)
                    @eval Main import Pkg
                end
                for dep in values(Main.Pkg.dependencies())
                    if dep.name == parts[1]
                        is_installed = true
                        break
                    end
                end
            catch
            end

            if is_installed
                try
                    @eval Main import $(first_sym)
                catch
                end
            end
        end

        for (i, part) in enumerate(parts)
            sym = Symbol(part)

            if i == length(parts)
                # Final part - could be a function, type, or value
                if isdefined(current, sym)
                    return getfield(current, sym)
                end
            else
                # Intermediate part - should be a module
                if isdefined(current, sym)
                    val = getfield(current, sym)
                    if val isa Module
                        current = val
                    else
                        return nothing
                    end
                else
                    return nothing
                end
            end
        end
    catch
        return nothing
    end

    return nothing
end

"""
Fetch documentation for a symbol.
"""
function fetch_documentation(sym)::Union{String,Nothing}
    try
        # Resolve docs into markdown text so callers can post-process.
        doc = Base.Docs.doc(sym)

        if doc === nothing
            return nothing
        end

        return sprint(show, MIME("text/markdown"), doc)
    catch
        # Return nothing if documentation can't be fetched
        return nothing
    end
end

"""
Render documentation for a symbol as HTML.
"""
function fetch_documentation_html(sym)::Union{String,Nothing}
    try
        doc = Base.Docs.doc(sym)
        if doc === nothing
            return nothing
        end

        return sprint(show, MIME("text/html"), doc)
    catch
        # Fallback to markdown rendering if direct HTML rendering fails.
        md = fetch_documentation(sym)
        if md === nothing
            return nothing
        end
        return markdown_to_html(md)
    end
end

"""
Convert Markdown to HTML.
"""
function markdown_to_html(md_str::String)::String
    try
        # Parse markdown
        md = Markdown.parse(md_str)

        # Convert to HTML
        io = IOBuffer()
        show(io, MIME("text/html"), md)
        return String(take!(io))
    catch e
        # Fall back to plain text wrapped in pre
        return "<pre>$(escape_html(md_str))</pre>"
    end
end

"""
Strip unresolved internal `@ref` links from Julia doc HTML.
"""
function strip_internal_ref_links(html::String)::String
    replace(html, r"<a\s+href=\"@ref[^\"]*\">(.*?)</a>"s => s"\1")
end

"""
Render a compact methods section for function values.
"""
function render_methods_html(sym, topic::String)::Union{String,Nothing}
    if !(sym isa Function)
        return nothing
    end

    method_entries = try
        collect_function_method_entries(sym, topic)
    catch
        return nothing
    end

    total = length(method_entries)
    if total == 0
        return nothing
    end

    shown = min(total, HELP_METHODS_MAX)
    io = IOBuffer()

    print(io, "<section class=\"julia-help-methods\">")
    print(io, "<h2>Methods</h2>")
    method_label = total == 1 ? "method" : "methods"
    print(
        io,
        "<p><code>",
        escape_html(topic),
        "</code> is a function with ",
        total,
        " ",
        method_label,
        ".</p>",
    )
    print(io, "<ol>")

    for i in 1:shown
        sig, location = method_entries[i]

        print(io, "<li><code>", escape_html(sig), "</code>")
        if !isempty(location)
            print(io, render_method_location_html(location))
        end
        print(io, "</li>")
    end

    print(io, "</ol>")
    if shown < total
        print(io, "<p class=\"julia-help-note\">Showing ", shown, " of ", total, " methods.</p>")
    end
    print(io, "</section>")

    return String(take!(io))
end

"""
Split a method display string into signature and location sections.
"""
function split_method_display(method_text::String)::Tuple{String,String}
    parts = split(method_text, " @ ", limit = 2)
    if length(parts) == 2
        return (parts[1], parts[2])
    end
    return (method_text, "")
end

"""
Parse method location strings of the form `<Module> <path>:<line>` and
return `(module_name, file_name_with_line)`.
"""
function parse_method_location(location::String)::Union{Nothing,Tuple{String,String}}
    m = match(r"^([^\s]+)\s+(.+):(\d+)$", strip(location))
    if m === nothing
        return nothing
    end

    module_name = m.captures[1]
    file_path = replace(m.captures[2], "\\" => "/")
    line = m.captures[3]
    file_name = split(file_path, "/")[end]
    return (module_name, string(file_name, ":", line))
end

"""
Format method location HTML using Julia VS Code-like compact location text.
"""
function render_method_location_html(location::String)::String
    parsed = parse_method_location(location)
    if parsed === nothing
        return string(" in <code>", escape_html(location), "</code>")
    end

    module_name, file_name_with_line = parsed
    return string(
        " in <code>",
        escape_html(module_name),
        "</code> at <code>",
        escape_html(file_name_with_line),
        "</code>",
    )
end

"""
Collect method entries for display. Includes keyword-dispatch wrappers to
match Julia VS Code method counts for functions with `; kwargs...`.
"""
function collect_function_method_entries(sym::Function, topic::String)::Vector{Tuple{String,String}}
    entries = Tuple{String,String}[]

    for method in methods(sym)
        push!(entries, split_method_display(sprint(show, method)))
    end

    append!(entries, collect_kwcall_method_entries(sym, topic))
    return entries
end

"""
Collect `kwcall` wrappers for a function and normalize them to `topic(...; kw...)`.
"""
function collect_kwcall_method_entries(sym::Function, topic::String)::Vector{Tuple{String,String}}
    kw_entries = Tuple{String,String}[]
    target_type = typeof(sym)

    for method in methods(Core.kwcall)
        sig_type = Base.unwrap_unionall(method.sig)
        if !(sig_type isa DataType)
            continue
        end

        params = sig_type.parameters
        if length(params) < 3
            continue
        end
        if params[3] !== target_type
            continue
        end

        display_sig, display_location = split_method_display(sprint(show, method))
        normalized_sig = normalize_kwcall_signature(display_sig, topic)
        push!(kw_entries, (normalized_sig, display_location))
    end

    return kw_entries
end

"""
Convert a `kwcall(::NamedTuple, ::typeof(f), args...)` display signature into
`f(args...; kw...)` for user-facing method lists.
"""
function normalize_kwcall_signature(signature::String, topic::String)::String
    m = match(
        r"^kwcall\(::NamedTuple,\s*::typeof\([^)]*\)\s*(?:,\s*)?(.*)\)$",
        signature,
    )
    if m === nothing
        return signature
    end

    args = strip(m.captures[1])
    if isempty(args)
        return string(topic, "(; kw...)")
    end
    return string(topic, "(", args, "; kw...)")
end

"""
Escape HTML special characters.
"""
function escape_html(s::AbstractString)::String
    s = String(s)
    s = replace(s, "&" => "&amp;")
    s = replace(s, "<" => "&lt;")
    s = replace(s, ">" => "&gt;")
    s = replace(s, "\"" => "&quot;")
    s = replace(s, "'" => "&#39;")
    return s
end

"""
Show help for a topic in the Help pane.
"""
function show_help!(service::HelpService, topic::String; focus::Bool = true)
    if service.comm === nothing
        return
    end

    content = get_help_content(topic)
    if content === nothing
        return
    end

    url = publish_help_page!(service, topic, content)
    if url === nothing
        return
    end

    params = HelpShowHelpParams(url, ShowHelpKind_Url, focus)
    send_event(service.comm, "show_help", params)
end

"""
Extract the help topic from a REPL help-mode input (e.g. `?print`).
Returns `nothing` when the code is not a help-mode request.
"""
function extract_help_topic_from_code(code::AbstractString)::Union{String,Nothing}
    stripped = strip(String(code))
    if !startswith(stripped, '?')
        return nothing
    end

    topic = strip(stripped[2:end])
    if isempty(topic)
        return nothing
    end

    newline_index = findfirst(==('\n'), topic)
    first_line = strip(newline_index === nothing ? topic : topic[begin:prevind(topic, newline_index)])
    first_line = strip(first_line, ';')
    return isempty(first_line) ? nothing : first_line
end

"""
Show help for a URL.
"""
function show_help_url!(service::HelpService, url::String; focus::Bool = true)
    if service.comm === nothing
        return
    end

    params = HelpShowHelpParams(url, ShowHelpKind_Url, focus)
    send_event(service.comm, "show_help", params)
end

"""
Create and publish a help page, returning a localhost URL.
"""
function publish_help_page!(
    service::HelpService,
    topic::String,
    html_content::String,
)::Union{String,Nothing}
    origin = ensure_help_server!(service)
    if origin === nothing
        return nothing
    end

    page_path = topic_to_help_path(topic)
    page_title = get_help_page_title(topic)
    page_html = wrap_help_html(page_title, html_content)
    cache_help_page!(service, page_path, page_html)

    return string(origin, page_path)
end

"""
Cache rendered help page HTML by path.
"""
function cache_help_page!(service::HelpService, page_path::String, page_html::String)
    lock(service.pages_lock) do
        service.pages[page_path] = page_html
        filter!(p -> p != page_path, service.page_order)
        push!(service.page_order, page_path)

        while length(service.page_order) > HELP_SERVER_MAX_PAGES
            stale = popfirst!(service.page_order)
            delete!(service.pages, stale)
        end
    end
end

"""
Start the local help HTTP server if needed and return its origin.
"""
function ensure_help_server!(service::HelpService)::Union{String,Nothing}
    if service.server !== nothing && isopen(service.server) && service.server_port !== nothing
        return "http://127.0.0.1:$(service.server_port)"
    end

    local server
    try
        server = Sockets.listen(ip"127.0.0.1", 0)
    catch
        return nothing
    end

    port = get_server_port(server)
    if port === nothing
        try
            close(server)
        catch
        end
        return nothing
    end

    service.server = server
    service.server_port = port
    service.server_task = @async run_help_server!(service, server)
    return "http://127.0.0.1:$port"
end

"""
Stop the local help HTTP server and clear cached pages.
"""
function stop_help_server!(service::HelpService)
    if service.server !== nothing
        try
            close(service.server)
        catch
        end
    end
    service.server = nothing
    service.server_task = nothing
    service.server_port = nothing

    lock(service.pages_lock) do
        empty!(service.pages)
        empty!(service.page_order)
    end
end

"""
Main accept loop for the help HTTP server.
"""
function run_help_server!(service::HelpService, server::Sockets.TCPServer)
    while isopen(server)
        socket = try
            Sockets.accept(server)
        catch
            break
        end

        @async begin
            try
                handle_help_http_client(service, socket)
            catch e
                try
                    bt = catch_backtrace()
                    Base.display_error(stderr, e, bt)
                catch
                end
                try
                    write_http_response(
                        socket,
                        "500 Internal Server Error",
                        "<h1>Internal Server Error</h1>";
                        content_type = "text/html; charset=utf-8",
                    )
                catch
                end
            finally
                try
                    close(socket)
                catch
                end
            end
        end
    end
end

"""
Serve a single HTTP request for a help page.
"""
function handle_help_http_client(service::HelpService, socket::Sockets.TCPSocket)
    request_path = read_request_path(socket)
    if request_path === nothing
        write_http_response(
            socket,
            "400 Bad Request",
            "<h1>Bad Request</h1>";
            content_type = "text/html; charset=utf-8",
        )
        return
    end

    path_only = split(request_path, "?", limit = 2)[1]
    if maybe_serve_help_asset(socket, path_only)
        return
    end

    local page_html = lock(service.pages_lock) do
        get(service.pages, path_only, nothing)
    end

    if page_html === nothing
        page_html = resolve_topic_page!(service, path_only)
    end

    if page_html === nothing
        write_http_response(
            socket,
            "404 Not Found",
            "<h1>Help page not found</h1>";
            content_type = "text/html; charset=utf-8",
        )
        return
    end

    write_http_response(
        socket,
        "200 OK",
        page_html;
        content_type = "text/html; charset=utf-8",
    )
end

"""
Resolve topic-backed help pages on demand from `/help/topic/<encoded-topic>` paths.
"""
function resolve_topic_page!(service::HelpService, path_only::String)::Union{String,Nothing}
    prefix = "/help/topic/"
    if !startswith(path_only, prefix)
        return nothing
    end

    encoded_topic = path_only[length(prefix)+1:end]
    topic = decode_help_topic(encoded_topic)
    if topic === nothing || isempty(topic)
        return nothing
    end

    content = get_help_content(topic)
    if content === nothing
        return nothing
    end

    page_title = get_help_page_title(topic)
    page_html = wrap_help_html(page_title, content)
    cache_help_page!(service, path_only, page_html)
    return page_html
end

"""
Build the title shown in Help navigation/history for a topic.
Example: `Julia: plot`.
"""
function get_help_page_title(topic::String)::String
    topic_label = split(strip(topic), ".")[end]
    if isempty(topic_label)
        return "Julia"
    end
    return string("Julia: ", topic_label)
end

"""
Serve static help assets from package resources.
"""
function maybe_serve_help_asset(socket::Sockets.TCPSocket, path_only::AbstractString)::Bool
    path_only = String(path_only)
    if path_only != "/help/assets/help.css"
        return false
    end

    css = read_help_asset("help.css")
    if css === nothing
        write_http_response(
            socket,
            "404 Not Found",
            "<h1>Asset not found</h1>";
            content_type = "text/html; charset=utf-8",
        )
        return true
    end

    write_http_response(socket, "200 OK", css; content_type = "text/css; charset=utf-8")
    return true
end

"""
Read a static asset from `julia/Positron/resources`.
"""
function read_help_asset(relative_path::String)::Union{String,Nothing}
    if isabspath(relative_path) || any(part -> part == "..", splitpath(relative_path))
        return nothing
    end

    asset_path = normpath(joinpath(HELP_RESOURCES_DIR, relative_path))
    if !isfile(asset_path)
        return nothing
    end

    return try
        read(asset_path, String)
    catch
        nothing
    end
end

"""
Read and parse the HTTP request line and return the URL path.
"""
function read_request_path(socket::Sockets.TCPSocket)::Union{String,Nothing}
    request_line = try
        readline(socket)
    catch
        return nothing
    end

    parts = split(strip(request_line))
    if length(parts) < 2
        return nothing
    end
    request_path = parts[2]

    # Consume headers until blank line.
    while true
        header_line = try
            readline(socket)
        catch
            break
        end
        if isempty(strip(header_line))
            break
        end
    end

    return request_path
end

"""
Build a stable help path for a topic.
"""
function topic_to_help_path(topic::AbstractString)::String
    cleaned = strip(String(topic))
    encoded = encode_help_topic(cleaned)
    return "/help/topic/$encoded"
end

"""
Percent-encode a help topic for URL path usage.
"""
function encode_help_topic(topic::AbstractString)::String
    topic = String(topic)
    isempty(topic) && return "_"
    io = IOBuffer()
    for b in codeunits(topic)
        if (b >= 0x30 && b <= 0x39) || # 0-9
           (b >= 0x41 && b <= 0x5A) || # A-Z
           (b >= 0x61 && b <= 0x7A) || # a-z
           b == 0x2D || b == 0x2E || b == 0x5F || b == 0x7E # - . _ ~
            write(io, UInt8(b))
        else
            write(io, UInt8('%'))
            hex = uppercase(string(b, base = 16, pad = 2))
            write(io, codeunits(hex))
        end
    end
    return String(take!(io))
end

"""
Decode a percent-encoded help topic path segment.
"""
function decode_help_topic(encoded_topic::AbstractString)::Union{String,Nothing}
    encoded_topic = String(encoded_topic)
    encoded_topic == "_" && return ""

    bytes = UInt8[]
    i = firstindex(encoded_topic)
    n = lastindex(encoded_topic)
    while i <= n
        c = encoded_topic[i]
        if c == '%'
            if i + 2 > n
                return nothing
            end
            hex = encoded_topic[i+1:i+2]
            value = tryparse(UInt8, "0x$hex")
            if value === nothing
                return nothing
            end
            push!(bytes, value)
            i += 3
        else
            push!(bytes, UInt8(c))
            i = nextind(encoded_topic, i)
        end
    end

    return try
        String(bytes)
    catch
        nothing
    end
end

"""
Write an HTTP response.
"""
function write_http_response(
    socket::Sockets.TCPSocket,
    status::String,
    body::String;
    content_type::String = "text/plain; charset=utf-8",
)
    content_length = ncodeunits(body)
    response_headers = (
        "HTTP/1.1 $status\r\n" *
        "Content-Type: $content_type\r\n" *
        "Content-Length: $content_length\r\n" *
        "Cache-Control: no-store\r\n" *
        "Connection: close\r\n\r\n"
    )

    write(socket, response_headers)
    write(socket, body)
    flush(socket)
end

"""
Apply server-side transforms for help HTML content.
"""
function preprocess_help_content_html(content_html::String)::String
    with_normalized_links = normalize_url_link_labels(content_html)
    return highlight_code_blocks(with_normalized_links)
end

"""
Rewrite URL-only anchor text to compact labels while preserving full href in `title`.
"""
function normalize_url_link_labels(html::String)::String
    pattern = r"(?is)<a\b([^>]*)>(.*?)</a>"
    return rewrite_matches(html, pattern, m -> begin
        attrs = m.captures[1]
        inner_html = m.captures[2]
        attrs === nothing && return m.match
        inner_html === nothing && return m.match

        href = extract_href(attrs)
        href === nothing && return m.match

        plain_text = normalize_space(strip_html_tags(unescape_html_entities(inner_html)))
        if isempty(plain_text) || !should_shorten_link_label(plain_text, href)
            return m.match
        end

        has_title = occursin(r"(?i)\btitle\s*=", attrs)
        attrs_with_title = has_title ? attrs : string(attrs, " title=\"", escape_html(href), "\"")
        return string("<a", attrs_with_title, ">", escape_html(shorten_url_label(href)), "</a>")
    end)
end

"""
Tokenize Julia code blocks and emit token-class HTML on the server side.
"""
function highlight_code_blocks(html::String)::String
    pattern = r"(?is)<pre>\s*<code([^>]*)>(.*?)</code>\s*</pre>"
    return rewrite_matches(html, pattern, m -> begin
        attrs = m.captures[1]
        code_html = m.captures[2]
        attrs === nothing && return m.match
        code_html === nothing && return m.match

        # Skip if the block already contains nested markup.
        occursin(r"(?is)<[^>]+>", code_html) && return m.match

        class_name = lowercase(extract_class_name(attrs))
        code_text = unescape_html_entities(code_html)
        highlighted = if occursin("language-jldoctest", class_name) ||
                          occursin("language-julia-repl", class_name) ||
                          occursin("language-juliarepl", class_name)
            highlight_julia_repl(code_text)
        elseif occursin("language-julia", class_name)
            highlight_julia(code_text)
        else
            nothing
        end

        highlighted === nothing && return m.match
        return string("<pre><code", attrs, ">", highlighted, "</code></pre>")
    end)
end

function highlight_julia(code_text::String)::String
    lines = split(code_text, '\n', keepempty = true)
    return join((tokenize_julia_line(line) for line in lines), "\n")
end

function highlight_julia_repl(code_text::String)::String
    rendered = String[]
    for line in split(code_text, '\n', keepempty = true)
        if startswith(line, "julia>")
            rest = length(line) > 6 ? line[7:end] : ""
            push!(rendered, string("<span class=\"tok-prompt\">julia&gt;</span>", tokenize_julia_line(rest)))
        else
            push!(rendered, escape_html(line))
        end
    end
    return join(rendered, "\n")
end

function tokenize_julia_line(line::AbstractString)::String
    line = String(line)
    chars = collect(line)
    n = length(chars)
    io = IOBuffer()
    i = 1
    while i <= n
        ch = chars[i]

        if ch == '#'
            write(io, "<span class=\"tok-comment\">", escape_html(String(chars[i:end])), "</span>")
            break
        end

        if i + 2 <= n && chars[i] == '"' && chars[i+1] == '"' && chars[i+2] == '"'
            stop = n
            j = i + 3
            while j + 2 <= n
                if chars[j] == '"' && chars[j+1] == '"' && chars[j+2] == '"'
                    stop = j + 2
                    break
                end
                j += 1
            end
            write(io, "<span class=\"tok-string\">", escape_html(String(chars[i:stop])), "</span>")
            i = stop + 1
            continue
        end

        if ch == '"' || ch == Char(0x27)
            quote_char = ch
            j = i + 1
            while j <= n
                if chars[j] == '\\'
                    j += 2
                    continue
                end
                if chars[j] == quote_char
                    j += 1
                    break
                end
                j += 1
            end
            stop = min(j - 1, n)
            write(io, "<span class=\"tok-string\">", escape_html(String(chars[i:stop])), "</span>")
            i = stop + 1
            continue
        end

        if ch == '@' && i < n && is_identifier_start(chars[i+1])
            j = read_while(chars, i + 1, is_identifier_continue)
            write(io, "<span class=\"tok-macro\">", escape_html(String(chars[i:j-1])), "</span>")
            i = j
            continue
        end

        if isdigit(ch)
            j = read_while(chars, i + 1, is_number_continue)
            write(io, "<span class=\"tok-number\">", escape_html(String(chars[i:j-1])), "</span>")
            i = j
            continue
        end

        if is_identifier_start(ch)
            j = read_while(chars, i + 1, is_identifier_continue)
            ident = String(chars[i:j-1])
            if ident in JULIA_HELP_KEYWORDS
                write(io, "<span class=\"tok-keyword\">", escape_html(ident), "</span>")
            elseif ident in JULIA_HELP_LITERALS
                write(io, "<span class=\"tok-literal\">", escape_html(ident), "</span>")
            else
                write(io, escape_html(ident))
            end
            i = j
            continue
        end

        write(io, escape_html(string(ch)))
        i += 1
    end
    return String(take!(io))
end

is_identifier_start(ch::Char)::Bool = isletter(ch) || ch == '_'

function is_identifier_continue(ch::Char)::Bool
    return isletter(ch) || isdigit(ch) || ch == '_' || ch == '!'
end

function is_number_continue(ch::Char)::Bool
    return isdigit(ch) || ch in ('_', '.', 'e', 'E', 'f', 'F', 'x', 'X', 'a', 'A', 'b', 'B', 'c', 'C', 'd', 'D')
end

function read_while(chars::Vector{Char}, start::Int, predicate::Function)::Int
    i = start
    n = length(chars)
    while i <= n && predicate(chars[i])
        i += 1
    end
    return i
end

function extract_class_name(attrs::AbstractString)::String
    m = match(r"(?is)\bclass\s*=\s*(['\"])(.*?)\1", String(attrs))
    m === nothing && return ""
    return m.captures[2]
end

function extract_href(attrs::AbstractString)::Union{String,Nothing}
    m = match(r"(?is)\bhref\s*=\s*(['\"])(.*?)\1", String(attrs))
    if m !== nothing
        return unescape_html_entities(strip(m.captures[2]))
    end

    m = match(r"(?is)\bhref\s*=\s*([^\s>]+)", String(attrs))
    m === nothing && return nothing
    return unescape_html_entities(strip(m.captures[1]))
end

function should_shorten_link_label(anchor_text::String, href::String)::Bool
    normalized_text = normalize_space(anchor_text)
    normalized_href = strip(href)
    href_no_slash = rstrip(normalized_href, '/')
    decoded_href = decode_percent_sequences(normalized_href)
    decoded_no_slash = rstrip(decoded_href, '/')

    return normalized_text == normalized_href ||
           normalized_text == decoded_href ||
           (!isempty(href_no_slash) && normalized_text == href_no_slash) ||
           (!isempty(decoded_no_slash) && normalized_text == decoded_no_slash)
end

function shorten_url_label(href::AbstractString)::String
    href = String(href)
    m = match(r"(?is)^https?://([^/?#]+)([^?#]*)?(\?[^#]*)?", href)
    if m === nothing
        return truncate_label(href, 60)
    end

    host = m.captures[1]
    path = m.captures[2] === nothing ? "" : m.captures[2]
    query = m.captures[3] === nothing ? "" : m.captures[3]

    label = string(host, path)
    if !isempty(query)
        label *= length(query) > 16 ? "?..." : query
    end
    return truncate_label(label, 60)
end

function truncate_label(text::AbstractString, max_chars::Int)::String
    text = String(text)
    if length(text) <= max_chars
        return text
    end
    if max_chars <= 3
        return first(text, max_chars)
    end
    return string(first(text, max_chars - 3), "...")
end

strip_html_tags(text::AbstractString)::String = replace(String(text), r"(?is)<[^>]+>" => "")

normalize_space(text::AbstractString)::String = replace(strip(String(text)), r"\s+" => " ")

function decode_percent_sequences(text::AbstractString)::String
    text = String(text)
    bytes = UInt8[]
    i = firstindex(text)
    n = lastindex(text)
    while i <= n
        c = text[i]
        if c == '%'
            i1 = nextind(text, i)
            i2 = i1 <= n ? nextind(text, i1) : i1
            if i1 <= n && i2 <= n
                hex = string(text[i1], text[i2])
                value = tryparse(UInt8, "0x$hex")
                if value !== nothing
                    push!(bytes, value)
                    i = nextind(text, i2)
                    continue
                end
            end
        end
        append!(bytes, codeunits(string(c)))
        i = nextind(text, i)
    end

    return try
        String(bytes)
    catch
        text
    end
end

function unescape_html_entities(text::AbstractString)::String
    out = String(text)
    out = replace(out, "&lt;" => "<")
    out = replace(out, "&gt;" => ">")
    out = replace(out, "&quot;" => "\"")
    out = replace(out, "&#39;" => "'")
    out = replace(out, "&amp;" => "&")

    out = rewrite_matches(out, r"(?i)&#x([0-9a-f]+);", m -> begin
        value = try
            parse(Int, m.captures[1], base = 16)
        catch
            nothing
        end
        return decode_html_entity_value(value, m.match)
    end)

    out = rewrite_matches(out, r"&#([0-9]+);", m -> begin
        value = tryparse(Int, m.captures[1])
        return decode_html_entity_value(value, m.match)
    end)
    return out
end

function decode_html_entity_value(value::Union{Int,Nothing}, fallback::AbstractString)::String
    fallback = String(fallback)
    if value === nothing || value < 0 || value > 0x10FFFF
        return fallback
    end
    return try
        string(Char(value))
    catch
        fallback
    end
end

function rewrite_matches(text::String, pattern::Regex, rewriter::Function)::String
    io = IOBuffer()
    cursor = firstindex(text)
    for m in eachmatch(pattern, text)
        start_idx = m.offset
        if cursor < start_idx
            write(io, SubString(text, cursor, prevind(text, start_idx)))
        end
        write(io, rewriter(m))
        cursor = nextind(text, start_idx, length(m.match))
    end
    if cursor <= lastindex(text)
        write(io, SubString(text, cursor, lastindex(text)))
    end
    return String(take!(io))
end

"""
Build a full HTML page around rendered help content.
"""
function wrap_help_html(page_title::String, content_html::String)::String
    safe_title = escape_html(page_title)
    rendered_content = preprocess_help_content_html(content_html)
    return """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>$safe_title</title>
  <link rel="stylesheet" type="text/css" href="/help/assets/help.css">
</head>
<body>
  <main class="julia-help">
$rendered_content
  </main>
</body>
</html>
"""
end

"""
Get the bound port for a TCPServer.
"""
function get_server_port(server::Sockets.TCPServer)::Union{Int,Nothing}
    addr = Sockets.getsockname(server)
    if addr isa Tuple && length(addr) >= 2
        return Int(addr[2])
    end
    if hasproperty(addr, :port)
        return Int(getproperty(addr, :port))
    end
    return nothing
end
