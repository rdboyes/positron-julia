/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	Trace,
	TransportKind
} from 'vscode-languageclient/node';

import { LOGGER } from './extension';
import { JuliaInstallation } from './julia-installation';

/**
 * Manages the Julia Language Server client.
 */
export class JuliaLanguageClient implements vscode.Disposable {

	private _client: LanguageClient | undefined;
	private _installation: JuliaInstallation | undefined;
	private _environmentPath: string | undefined;
	private _extensionPath: string;
	private _outputChannel: vscode.OutputChannel;
	private _isStopping: boolean = false;

	constructor(extensionPath: string) {
		this._extensionPath = extensionPath;
		this._outputChannel = vscode.window.createOutputChannel('Julia Language Server');
	}

	/**
	 * Returns the path to the language server depot for a specific Julia version.
	 * Each Julia minor version gets its own depot to avoid compatibility issues.
	 *
	 * @param installation The Julia installation to get the depot path for
	 */
	private getLsDepotPath(installation: JuliaInstallation): string {
		// Use minor version (1.10, 1.12, etc.) for depot isolation
		const versionMatch = installation.version.match(/^(\d+\.\d+)/);
		const minorVersion = versionMatch ? versionMatch[1] : '1.x';
		return path.join(this._extensionPath, 'lsdepot', `v${minorVersion}`);
	}

	private findNearestProjectDir(startPath: string): string | undefined {
		let dir = startPath;
		try {
			const stat = fs.statSync(startPath);
			if (!stat.isDirectory()) {
				dir = path.dirname(startPath);
			}
		} catch {
			return undefined;
		}

		while (true) {
			if (
				fs.existsSync(path.join(dir, 'Project.toml')) ||
				fs.existsSync(path.join(dir, 'JuliaProject.toml'))
			) {
				return dir;
			}
			const parent = path.dirname(dir);
			if (parent === dir) {
				return undefined;
			}
			dir = parent;
		}
	}

	private resolveEnvironmentPath(
		installation: JuliaInstallation,
		preferredFilePath?: string
	): { path: string; reason: string } {
		const config = vscode.workspace.getConfiguration('positron.julia');
		const configuredPath = config.get<string>('languageServer.environmentPath', '').trim();

		if (configuredPath) {
			const basePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
			const resolvedPath = path.isAbsolute(configuredPath)
				? configuredPath
				: path.resolve(basePath, configuredPath);
			if (fs.existsSync(resolvedPath)) {
				return { path: resolvedPath, reason: 'user setting (positron.julia.languageServer.environmentPath)' };
			}
			LOGGER.warn(`Configured Language Server environment does not exist: ${resolvedPath}`);
		}

		const candidateFile = preferredFilePath
			?? vscode.window.activeTextEditor?.document.uri.fsPath;
		if (candidateFile) {
			const nearest = this.findNearestProjectDir(candidateFile);
			if (nearest) {
				return { path: nearest, reason: `nearest project for ${candidateFile}` };
			}
		}

		const minorVersion = installation.version.match(/^(\d+\.\d+)/)?.[1];
		const home = process.env.HOME || process.env.USERPROFILE || '';
		if (minorVersion && home) {
			const defaultEnv = path.join(home, '.julia', 'environments', `v${minorVersion}`);
			if (fs.existsSync(path.join(defaultEnv, 'Project.toml'))) {
				return { path: defaultEnv, reason: 'default Julia environment' };
			}
		}

		return {
			path: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
			reason: 'workspace root fallback',
		};
	}

	private _buildInitializationOptions(): object {
		const cfg = vscode.workspace.getConfiguration('julia');
		return {
			julialangTestItemProvider: false,
			inlayHints: {
				static: {
					enabled: cfg.get<boolean>('inlayHints.static.enabled', false),
					variableTypes: {
						enabled: cfg.get<boolean>('inlayHints.static.variableTypes.enabled', true),
					},
					parameterNames: {
						enabled: cfg.get<string>('inlayHints.static.parameterNames.enabled', 'literals'),
					},
				},
			},
		};
	}

	/**
	 * Checks if LanguageServer.jl is installed in the depot for this Julia version.
	 */
	private isLanguageServerInstalled(installation: JuliaInstallation): boolean {
		const depotPath = this.getLsDepotPath(installation);
		// Check if the environment directory exists with a Manifest.toml
		const envPath = path.join(depotPath, 'environments', `v${installation.version.match(/^(\d+\.\d+)/)?.[1] || '1.x'}`);
		const manifestPath = path.join(envPath, 'Manifest.toml');
		return fs.existsSync(manifestPath);
	}

	/**
	 * Installs LanguageServer.jl into the extension's depot.
	 */
	private async installLanguageServer(installation: JuliaInstallation): Promise<void> {
		const depotPath = this.getLsDepotPath(installation);

		// Ensure depot directory exists
		fs.mkdirSync(depotPath, { recursive: true });

		const installScript = path.join(
			this._extensionPath,
			'scripts',
			'languageserver',
			'install.jl'
		);

		LOGGER.info(`Installing Julia Language Server to ${depotPath}`);

		return vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Installing Julia Language Server...',
			cancellable: false
		}, async (progress) => {
			progress.report({ message: 'This may take a few minutes on first run' });

			return new Promise<void>((resolve, reject) => {
				const proc = cp.spawn(installation.binpath, [
					'--startup-file=no',
					'--history-file=no',
					'--project=@.',
					installScript
				], {
					env: {
						...process.env,
						JULIA_DEPOT_PATH: depotPath,
					}
				});

				let stdout = '';
				let stderr = '';

				proc.stdout.on('data', (data) => {
					stdout += data.toString();
					LOGGER.debug(`[LS Install] ${data.toString().trim()}`);
				});

				proc.stderr.on('data', (data) => {
					stderr += data.toString();
					LOGGER.debug(`[LS Install stderr] ${data.toString().trim()}`);
				});

				proc.on('close', (code) => {
					if (code === 0) {
						LOGGER.info('Julia Language Server installed successfully');
						resolve();
					} else {
						const error = new Error(`Installation failed with code ${code}: ${stderr}`);
						LOGGER.error(`Failed to install Language Server: ${error.message}`);
						reject(error);
					}
				});

				proc.on('error', (error) => {
					LOGGER.error(`Failed to spawn installation process: ${error.message}`);
					reject(error);
				});
			});
		});
	}

	/**
	 * Starts the language server with the given Julia installation.
	 * Automatically installs LanguageServer.jl if not present.
	 */
	async start(installation: JuliaInstallation, preferredFilePath?: string): Promise<void> {
		if (this._client) {
			LOGGER.info('Language server already running');
			return;
		}

		this._installation = installation;

		// Check if LanguageServer.jl is installed for this Julia version, install if not
		if (!this.isLanguageServerInstalled(installation)) {
			try {
				await this.installLanguageServer(installation);
			} catch (error) {
				LOGGER.error(`Failed to install Language Server: ${error}`);
				vscode.window.showWarningMessage(
					'Failed to install Julia Language Server. Code completion may not be available.'
				);
				return;
			}
		}

		LOGGER.info(`Starting Julia Language Server with ${installation.binpath}`);

		// Path to the language server main script
		const serverScript = path.join(
			this._extensionPath,
			'scripts',
			'languageserver',
			'main.jl'
		);

		// Resolve the best Julia environment for static analysis.
		const resolvedEnvironment = this.resolveEnvironmentPath(installation, preferredFilePath);
		const workspaceFolder = resolvedEnvironment.path;
		this._environmentPath = workspaceFolder;
		LOGGER.info(`Julia Language Server environment: ${workspaceFolder} (${resolvedEnvironment.reason})`);

		// Language server depot path - version-specific to support multiple Julia versions
		const lsDepot = this.getLsDepotPath(installation);

		// Server options - spawn Julia process
		// Build the depot path: lsDepot first, then user's depot path
		// If JULIA_DEPOT_PATH isn't set, include the default depot (~/.julia)
		const userDepot = process.env.JULIA_DEPOT_PATH || path.join(
			process.env.HOME || process.env.USERPROFILE || '',
			'.julia'
		);
		const depotPath = `${lsDepot}${path.delimiter}${userDepot}`;

		// Determine the user's PRIMARY depot directory.
		// This is the depot where user-installed packages (DataFrames, Plots, etc.) reside.
		// It MUST be passed to LanguageServer.jl's runserver() so SymbolServer can
		// find and index user packages.
		// If JULIA_DEPOT_PATH has multiple entries (colon-separated), take the first.
		const userPrimaryDepot = process.env.JULIA_DEPOT_PATH
			? process.env.JULIA_DEPOT_PATH.split(path.delimiter)[0]
			: path.join(process.env.HOME || process.env.USERPROFILE || '', '.julia');

		const juliaLoadPath = ['@', '@v#.#', '@stdlib'].join(path.delimiter);
		LOGGER.info(`Julia Language Server load path: ${juliaLoadPath}`);
		LOGGER.info(`Julia Language Server depot path: ${depotPath}`);
		LOGGER.info(`Julia Language Server user primary depot: ${userPrimaryDepot}`);
		const serverEnv: NodeJS.ProcessEnv = {
			...process.env,
			// Prepend LS depot to user depot path
			// This ensures access to Julia's stdlib, registries, and symbol caches
			JULIA_DEPOT_PATH: depotPath,
			JULIA_LOAD_PATH: juliaLoadPath,
			JULIA_LANGUAGESERVER: '1',
			POSITRON_JULIA_LS: '1',
			// Tell main.jl which depot has user-installed packages
			POSITRON_JULIA_USER_DEPOT: userPrimaryDepot,
		};
		if (process.platform === 'win32' && serverEnv.SSH_KNOWN_HOSTS_FILES === undefined) {
			serverEnv.SSH_KNOWN_HOSTS_FILES = '';
		}

		const serverOptions: ServerOptions = {
			command: installation.binpath,
			args: [
				'--startup-file=no',
				'--history-file=no',
				'--depwarn=no',
				serverScript,
				workspaceFolder
			],
			options: {
				env: serverEnv
			},
			transport: TransportKind.stdio
		};

		// Client options
		const clientOptions: LanguageClientOptions = {
			documentSelector: [
				{ scheme: 'file', language: 'julia' },
				{ scheme: 'untitled', language: 'julia' },
				{ scheme: 'vscode-notebook-cell', language: 'julia' },
				{ scheme: 'inmemory', language: 'julia' },  // Console
			],
			synchronize: {
				fileEvents: [
					vscode.workspace.createFileSystemWatcher('**/*.jl'),
					vscode.workspace.createFileSystemWatcher('**/Project.toml'),
					vscode.workspace.createFileSystemWatcher('**/Manifest.toml'),
				]
			},
			outputChannel: this._outputChannel,
			traceOutputChannel: this._outputChannel,
			// Help the language server find environments in subdirectories
			workspaceFolder: vscode.workspace.workspaceFolders?.[0],
			// Initialization options to configure LanguageServer.jl behavior
			initializationOptions: this._buildInitializationOptions(),
		};

		// Create and start the client
		// Use a unique ID to avoid command conflicts with julia-vscode extension
		this._client = new LanguageClient(
			'positron-julia-ls',
			'Julia Language Server (Positron)',
			serverOptions,
			clientOptions
		);

		// Apply trace level from configuration
		const traceLevel = vscode.workspace.getConfiguration('julia').get<string>('trace.server', 'off');
		if (traceLevel !== 'off') {
			this._client.setTrace(traceLevel === 'verbose' ? Trace.Verbose : Trace.Messages);
		}

		// Remove ExecuteCommandFeature to prevent command registration conflicts
		// The LanguageServer.jl provides commands like 'UpdateDocstringSignature' that may
		// conflict with other extensions or previous LS instances
		const features = (this._client as unknown as { _features: Array<{ constructor: { name: string } }> })._features;
		const filteredFeatures = features.filter(f => f.constructor.name !== 'ExecuteCommandFeature');
		(this._client as unknown as { _features: typeof filteredFeatures })._features = filteredFeatures;

			// Handle unexpected stops.
			// Restart coordination is handled at extension level to avoid
			// multiple concurrent client instances.
			this._client.onDidChangeState((event) => {
				if (event.newState === 1) { // State.Stopped
					if (this._isStopping) {
						LOGGER.debug('Julia Language Server stopped by request');
						return;
					}
					LOGGER.warn('Julia Language Server stopped unexpectedly');
					// Clear the client reference
					this._client = undefined;
					this._environmentPath = undefined;
				}
			});

			try {
				await this._client.start();
				LOGGER.info('Julia Language Server started successfully');
			} catch (error) {
				LOGGER.error(`Failed to start Julia Language Server: ${error}`);
				this._client = undefined;
				throw error;
			}
	}

	/**
	 * Stops the language server.
	 */
	async stop(): Promise<void> {
		if (this._client) {
			LOGGER.info('Stopping Julia Language Server');
			this._isStopping = true;
			try {
				await this._client.stop();
			} finally {
				this._isStopping = false;
				this._client = undefined;
				this._environmentPath = undefined;
			}
		}
	}

	/**
	 * Restarts the language server.
	 */
	async restart(): Promise<void> {
		if (this._installation) {
			await this.stop();
			await this.start(this._installation);
		}
	}

	/**
	 * Ensures the language server uses the best environment for a file path.
	 * Restarts the server if the target environment changed.
	 */
	async refreshEnvironmentForFile(filePath: string): Promise<void> {
		if (!this._installation || !this.isRunning()) {
			return;
		}

		const resolved = this.resolveEnvironmentPath(this._installation, filePath);
		if (resolved.path === this._environmentPath) {
			return;
		}

		// Don't switch away from a project environment to the default environment.
		// The LSP was started with a specific project for a reason (an open .jl file).
		// Only switch when moving TO a project environment (has Project.toml).
		const targetHasProject = fs.existsSync(path.join(resolved.path, 'Project.toml')) ||
			fs.existsSync(path.join(resolved.path, 'JuliaProject.toml'));
		const currentHasProject = this._environmentPath &&
			(fs.existsSync(path.join(this._environmentPath, 'Project.toml')) ||
				fs.existsSync(path.join(this._environmentPath, 'JuliaProject.toml')));

		if (currentHasProject && !targetHasProject) {
			LOGGER.debug(`Keeping current project environment ${this._environmentPath} (not switching to ${resolved.reason})`);
			return;
		}

		LOGGER.info(`Switching Julia Language Server environment to ${resolved.path} (${resolved.reason})`);
		try {
			await this.stop();
		} catch (err) {
			LOGGER.warn(`Error stopping Language Server during environment switch: ${err}`);
			// Force-clear the client so we can restart
			this._client = undefined;
			this._environmentPath = undefined;
		}
		await this.start(this._installation, filePath);
	}

	getEnvironmentPath(): string | undefined {
		return this._environmentPath;
	}

	/**
	 * Returns whether the language server is running.
	 */
	isRunning(): boolean {
		return this._client !== undefined && this._client.isRunning();
	}

	/**
	 * Resolve a help topic for a cursor position via custom LSP request.
	 */
	async getHelpTopic(
		document: vscode.TextDocument,
		position: vscode.Position
	): Promise<string | undefined> {
		if (!this._client || !this._client.isRunning()) {
			return undefined;
		}

		try {
			const result = await this._client.sendRequest('positron/textDocument/helpTopic', {
				textDocument: { uri: document.uri.toString() },
				position: {
					line: position.line,
					character: position.character,
				},
			}) as unknown;

			if (typeof result === 'string') {
				const topic = result.trim();
				return topic.length > 0 ? topic : undefined;
			}

			if (result && typeof result === 'object') {
				const maybeTopic = (result as { topic?: unknown }).topic;
				if (typeof maybeTopic === 'string') {
					const topic = maybeTopic.trim();
					return topic.length > 0 ? topic : undefined;
				}
			}
		} catch (error) {
			// Most servers won't implement this request. Provider will use textual fallback.
			LOGGER.debug(`Help topic request unavailable: ${error}`);
		}

		return undefined;
	}

	/**
	 * Sends a notification to the language server.
	 */
	async sendLSNotification(method: string, params?: object): Promise<void> {
		if (!this._client?.isRunning()) {
			return;
		}
		await this._client.sendNotification(method, params);
	}

	dispose(): void {
		this.stop();
		this._outputChannel.dispose();
	}
}
