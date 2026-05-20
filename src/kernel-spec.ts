/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

import { JuliaInstallation } from './julia-installation';
import { JupyterKernelSpec } from './positron-supervisor';
import { LOGGER } from './extension';

/**
 * Creates a Jupyter kernel spec for launching Julia with IJulia.
 *
 * @param installation The Julia installation to create a kernel spec for.
 * @param userProjectPath Optional path to the user's Julia project to activate after bootstrapping.
 * @returns A JupyterKernelSpec for the Julia installation.
 */
export function createJuliaKernelSpec(installation: JuliaInstallation, userProjectPath?: string): JupyterKernelSpec {
	// Get the log level from configuration
	const kernelConfig = vscode.workspace.getConfiguration('positron.julia.kernel');
	const logLevel = kernelConfig.get<string>('logLevel', 'warn');

	// Get Julia-specific user settings
	const juliaConfig = vscode.workspace.getConfiguration('julia');
	const numThreadsSetting = juliaConfig.get<number | string | null>('NumThreads', null);
	const numThreads = numThreadsSetting !== null && numThreadsSetting !== undefined
		? String(numThreadsSetting)
		: (process.env.JULIA_NUM_THREADS || 'auto');
	const additionalArgs = juliaConfig.get<string[]>('additionalArgs', []);
	const packageServer = juliaConfig.get<string>('packageServer', '').trim();

	// Build the kernel arguments
	// The {connection_file} and {log_file} placeholders are replaced by the supervisor
	// Note: We use --logfile so the supervisor can find it on restore/reconnect
	const argv = [
		installation.binpath,
		'-i',  // Interactive mode
		'--color=yes',
		...additionalArgs,
		'-e',
		getKernelStartupCode(),
		'{connection_file}',
		'--logfile',
		'{log_file}',  // Log file path for kernel output
	];

	// Build environment variables
	const env: NodeJS.ProcessEnv = {
		// Julia-specific environment variables
		JULIA_NUM_THREADS: numThreads,
		JULIA_COLORS: 'yes',

		// Positron-specific environment variables
		POSITRON: '1',
		POSITRON_VERSION: vscode.version,
		POSITRON_MODE: 'console',

		// Log level for debugging
		JULIA_DEBUG: logLevel === 'trace' || logLevel === 'debug' ? 'all' : '',
	};

	if (packageServer) {
		env['JULIA_PKG_SERVER'] = packageServer;
	}

	if (userProjectPath) {
		env['POSITRON_USER_PROJECT'] = userProjectPath;
	}

	// Add any user-configured environment variables
	const userEnv = kernelConfig.get<Record<string, string>>('env', {});
	Object.assign(env, userEnv);

	LOGGER.debug(`Creating kernel spec for Julia ${installation.version}`);
	LOGGER.debug(`  argv: ${argv.join(' ')}`);

	return {
		argv,
		display_name: `Julia ${installation.version}`,
		language: 'julia',
		interrupt_mode: 'signal',
		env,
		kernel_protocol_version: '5.3',  // IJulia supports Jupyter protocol 5.3
	};
}

/**
 * Returns the Julia code that starts the IJulia kernel.
 *
 * This code:
 * 1. Activates the bundled Positron.jl project
 * 2. Ensures project dependencies are available (instantiates on first run)
 * 3. Loads IJulia and Positron.jl services
 * 4. Starts the kernel with IJulia.run_kernel()
 *
 * The connection file is passed as a command line argument and is
 * automatically read by IJulia.run_kernel().
 *
 */
function getKernelStartupCode(): string {
	const positronPath = path.join(
		__dirname,
		'..',
		'julia',
		'Positron'
	).replace(/\\/g, '/');  // Use forward slashes for Julia

	// Command line args are: connection_file, --logfile, log_file_path
	// We need to set POSITRON_KERNEL_LOG before loading Positron so logging works
	return `
		for i in 1:length(ARGS)-1
			if ARGS[i] == "--logfile"
				ENV["POSITRON_KERNEL_LOG"] = ARGS[i+1];
				break;
			end;
		end;
		using Pkg;
		Pkg.activate("${positronPath}");

		function __positron_bootstrap__()
			local has_ijulia = false
			local has_positron = false

			try
				@eval import IJulia
				has_ijulia = true
			catch e
				println("Julia: IJulia not ready, running bootstrap...");
			end

			try
				@eval using Positron
				has_positron = true
			catch e
				# Positron depends on JSON3/StructTypes/etc from this project.
				# If any are missing, instantiate and retry.
			end

			if !has_ijulia || !has_positron
				println("Julia: Installing Positron kernel dependencies (one-time setup)...");
				Pkg.instantiate();
				Pkg.precompile();

				if !has_ijulia
					@eval import IJulia
				end
				if !has_positron
					@eval using Positron
				end
			end
		end

		__positron_bootstrap__();

		try
			using Positron;
			Positron.start_services!();
		catch e
			@warn "Failed to load Positron.jl services" exception=e;
		end;
		let user_project = get(ENV, "POSITRON_USER_PROJECT", "")
			if !isempty(user_project) && (
				isfile(joinpath(user_project, "Project.toml")) ||
				isfile(joinpath(user_project, "JuliaProject.toml"))
			)
				Pkg.activate(user_project)
			end
		end;
		IJulia.run_kernel();
		exit()
		`.trim();
}
