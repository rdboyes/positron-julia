#!/usr/bin/env julia

using Pkg

# Install required packages if missing
Pkg.add([
    "DataFrames",
    "Plots"
])

using DataFrames
using Plots

# Create a basic DataFrame
df = DataFrame(
    x=1:10,
    y=rand(10)
)

println("DataFrame:")
println(df)

# Make a simple plot
plot(
    df.x,
    df.y,
    xlabel="x",
    ylabel="y",
    title="Basic Plot",
    legend=false
)

# Save the plot
savefig("basic_plot.png")
println("Plot saved to basic_plot.png")
