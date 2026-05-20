# CancellationTokens

A Julia implementation of .Net's Cancellation Framework. See [here](https://devblogs.microsoft.com/pfxteam/net-4-cancellation-framework/) and [here](https://docs.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads) for details.

The package is currently _not_ thread safe, so it should only be used with single threaded tasks for now.
