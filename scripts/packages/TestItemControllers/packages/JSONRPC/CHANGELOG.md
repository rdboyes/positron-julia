# Version v2.0.0
## Breaking changes
- All typed request handlers must accept a final `token` argument from the CancellationTokens package
- Static dispatch handlers no longer receive the endpoint as the first argument
- `get_next_message` and iterating over and endpoint returns a new `Request` instance
