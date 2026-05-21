/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';

import { LOGGER, supervisorApi } from './extension';
import { JuliaInstallation } from './julia-installation';
import { JupyterLanguageRuntimeSession, JupyterKernelSpec } from './positron-supervisor';
import { JuliaPackageManager } from './packages';

interface RuntimeResourceUsage {
	[key: string]: unknown;
}

/**
 * Represents a Julia runtime session.
 */
export class JuliaSession implements positron.LanguageRuntimeSession, vscode.Disposable {

	/** The underlying Jupyter session */
	private _kernel?: JupyterLanguageRuntimeSession;
	private readonly _packageManager: JuliaPackageManager;
	private readonly _suppressedExecutionIds = new Set<string>();

	/** Dynamic state of the session */
	public dynState: positron.LanguageRuntimeDynState;

	/** Runtime info (available after start) */
	public runtimeInfo: positron.LanguageRuntimeInfo = {
		banner: 'Julia',
		implementation_version: '',
		language_version: '',
	};

	/** Event emitters */
	private readonly _rawMessageEmitter = new vscode.EventEmitter<positron.LanguageRuntimeMessage>();
	private readonly _messageEmitter = new vscode.EventEmitter<positron.LanguageRuntimeMessage>();
	private readonly _stateEmitter = new vscode.EventEmitter<positron.RuntimeState>();
	private readonly _exitEmitter = new vscode.EventEmitter<positron.LanguageRuntimeExit>();
	private readonly _resourceUsageEmitter = new vscode.EventEmitter<RuntimeResourceUsage>();

	/** Events */
	onDidReceiveRuntimeMessageRaw: vscode.Event<positron.LanguageRuntimeMessage>;
	onDidReceiveRuntimeMessage: vscode.Event<positron.LanguageRuntimeMessage>;
	onDidChangeRuntimeState: vscode.Event<positron.RuntimeState>;
	onDidEndSession: vscode.Event<positron.LanguageRuntimeExit>;
	onDidUpdateResourceUsage: vscode.Event<RuntimeResourceUsage>;

	get installation(): JuliaInstallation {
		return this._installation;
	}

	constructor(
		readonly runtimeMetadata: positron.LanguageRuntimeMetadata,
		readonly metadata: positron.RuntimeSessionMetadata,
		private readonly _installation: JuliaInstallation,
		private readonly _extensionPath: string,
		readonly kernelSpec?: JupyterKernelSpec,
		sessionName?: string
	) {
		this.dynState = {
			inputPrompt: 'julia>',
			continuationPrompt: '      ',
			sessionName: sessionName || runtimeMetadata.runtimeName,
		};

		this.onDidReceiveRuntimeMessageRaw = this._rawMessageEmitter.event;
		this.onDidReceiveRuntimeMessage = this._messageEmitter.event;
		this.onDidChangeRuntimeState = this._stateEmitter.event;
		this.onDidEndSession = this._exitEmitter.event;
		this.onDidUpdateResourceUsage = this._resourceUsageEmitter.event;
		this._packageManager = new JuliaPackageManager(this, this._extensionPath);
	}

	private getDenseAsciiArtLines(juliaVersionLabel: string): string[] {
		return [
			'               _',
			'   _       _ _(_)_     |  Documentation: https://docs.julialang.org',
			'  (_)     | (_) (_)    |',
			'   _ _   _| |_  __ _   |  Type "?" for help, "]?" for Pkg help.',
			'  | | | | | | |/ _` |  |',
			`  | | |_| | | | (_| |  |  Version ${juliaVersionLabel}`,
			' _/ |\\__\'_|_|_|\\__\'_|  |  Official https://julialang.org release',
			'|__/                   |',
		];
	}

	private buildJuliaStartupBanner(info: positron.LanguageRuntimeInfo): string {
		const juliaVersion = info.language_version || this._installation.version;
		const juliaReleaseDate = this._installation.releaseDate;
		const juliaVersionLabel = juliaReleaseDate
			? `${juliaVersion} (${juliaReleaseDate})`
			: juliaVersion;
		const ijuliaVersion = info.implementation_version
			? `IJulia ${info.implementation_version}`
			: 'IJulia';
		// Preserve fixed-width spacing in ASCII banner lines in HTML output rendering.
		const preserveSpaces = (text: string): string => text.replace(/ /g, '\u00a0');

		const banner = [
			'Julia: A fresh approach to technical computing.',
			`${ijuliaVersion} -- Jupyter kernel for Julia.`,
			preserveSpaces(this.getDenseAsciiArtLines(juliaVersionLabel).join('\n')),
		].join('\n').trimEnd();

		// Use two trailing newlines to reliably render exactly one blank line before the prompt.
		return `${banner}\n\n`;
	}

	private _loadReviseIfEnabled(): void {
		if (!vscode.workspace.getConfiguration('julia').get<boolean>('useRevise', true)) {
			return;
		}
		if (!this._kernel) {
			return;
		}

		const executionId = `revise-autoload-${Date.now()}`;
		const suppressDisposable = this.suppressRuntimeMessages(executionId);

		let idleListener: vscode.Disposable | undefined;
		let timeoutHandle: NodeJS.Timeout | undefined;
		const cleanup = () => {
			idleListener?.dispose();
			idleListener = undefined;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = undefined;
			}
			suppressDisposable.dispose();
		};

		idleListener = this.onDidReceiveRuntimeMessageRaw((msg) => {
			if (msg.parent_id !== executionId) {
				return;
			}
			if (msg.type === positron.LanguageRuntimeMessageType.State) {
				const stateMsg = msg as positron.LanguageRuntimeState;
				if (stateMsg.state === positron.RuntimeOnlineState.Idle) {
					cleanup();
				}
			}
		});

		// Safety net in case Idle never arrives (precompilation can take a while).
		timeoutHandle = setTimeout(cleanup, 10 * 60 * 1000);

		// redirect_stderr/redirect_stdout silence the `[ Info: Precompiling ...]`
		// noise and any SYSTEM task-error printing that Julia emits while loading
		// Revise. Without this the messages reach IJulia's captured streams and
		// surface in the console even though the execution is Silent.
		try {
			this._kernel.execute(
				`try; redirect_stderr(devnull) do; redirect_stdout(devnull) do; @eval import Revise; end; end; catch; end`,
				executionId,
				positron.RuntimeCodeExecutionMode.Silent,
				positron.RuntimeErrorBehavior.Continue
			);
			LOGGER.debug('Revise.jl auto-load attempted');
		} catch (error) {
			// If the kernel rejects the execute call synchronously (e.g. the
			// session ended during startup), tear down the suppression entry
			// and listeners immediately so they don't linger for the full
			// 10-minute safety window.
			cleanup();
			LOGGER.warn(`Revise.jl auto-load failed to dispatch: ${error}`);
		}
	}

	dispose(): void {
		this._rawMessageEmitter.dispose();
		this._messageEmitter.dispose();
		this._stateEmitter.dispose();
		this._exitEmitter.dispose();
		this._resourceUsageEmitter.dispose();
	}

	suppressRuntimeMessages(executionId: string): vscode.Disposable {
		this._suppressedExecutionIds.add(executionId);
		return new vscode.Disposable(() => {
			this._suppressedExecutionIds.delete(executionId);
		});
	}

	/**
	 * Starts the Julia session.
	 */
	async start(): Promise<positron.LanguageRuntimeInfo> {
		LOGGER.info(`Starting Julia session ${this.metadata.sessionId}`);

		// Get the supervisor API
		const supervisor = await supervisorApi();

		// Create or restore the session via the supervisor
		if (this.kernelSpec) {
			// We have a kernel spec, so create a new session
			LOGGER.info(`Creating new Julia session with kernel spec`);
			this._kernel = await supervisor.createSession(
				this.runtimeMetadata,
				this.metadata,
				this.kernelSpec,
				this.dynState
			);
		} else {
			// We don't have a kernel spec, so restore (reconnect) an existing session
			LOGGER.info(`Restoring existing Julia session`);
			this._kernel = await supervisor.restoreSession(
				this.runtimeMetadata,
				this.metadata,
				this.dynState
			);
		}

		// Forward events from the Jupyter session
		this._kernel.onDidReceiveRuntimeMessage((msg: positron.LanguageRuntimeMessage) => {
			this._rawMessageEmitter.fire(msg);
			if (!this._suppressedExecutionIds.has(msg.parent_id)) {
				this._messageEmitter.fire(msg);
				// Silent package commands are excluded by _suppressedExecutionIds,
				// so any unsuppressed Idle here is user-executed code.
				if (msg.type === positron.LanguageRuntimeMessageType.State) {
					const stateMsg = msg as positron.LanguageRuntimeState;
					if (stateMsg.state === positron.RuntimeOnlineState.Idle) {
						this._packageManager.notifyRuntimeIdle();
					}
				}
			}
		});

		this._kernel.onDidChangeRuntimeState((state: positron.RuntimeState) => {
			this._stateEmitter.fire(state);
			if (state === positron.RuntimeState.Ready) {
				this._packageManager.onRuntimeReady().catch((error) => {
					LOGGER.warn(`Failed to initialize Julia package helpers: ${error}`);
				});
				this._loadReviseIfEnabled();
			}
		});

		this._kernel.onDidEndSession((exit: positron.LanguageRuntimeExit) => {
			this._exitEmitter.fire(exit);
		});

		// Positron may provide resource usage updates from supervisor sessions.
		const kernelWithResourceUsage = this._kernel as unknown as {
			onDidUpdateResourceUsage?: (listener: (usage: RuntimeResourceUsage) => void) => void;
		};
		if (typeof kernelWithResourceUsage.onDidUpdateResourceUsage === 'function') {
			kernelWithResourceUsage.onDidUpdateResourceUsage((usage: RuntimeResourceUsage) => {
				this._resourceUsageEmitter.fire(usage);
			});
		}

		// Start the session
		const info = await this._kernel.start();
		this.runtimeInfo = {
			...info,
			banner: this.buildJuliaStartupBanner(info),
		};
		// Fallback for restored sessions where a Ready transition may have already occurred.
		this._packageManager.sourcePackagesScript().catch((error) => {
			LOGGER.warn(`Failed to source Julia package helper script: ${error}`);
		});
		return this.runtimeInfo;
	}

	execute(
		code: string,
		id: string,
		mode: positron.RuntimeCodeExecutionMode,
		errorBehavior: positron.RuntimeErrorBehavior
	): void {
		if (!this._kernel) {
			throw new Error('Session not started');
		}
		this._kernel.execute(code, id, mode, errorBehavior);
	}

	isCodeFragmentComplete(code: string): Thenable<positron.RuntimeCodeFragmentStatus> {
		if (!this._kernel) {
			return Promise.resolve(positron.RuntimeCodeFragmentStatus.Unknown);
		}
		return this._kernel.isCodeFragmentComplete(code);
	}

	createClient(id: string, type: positron.RuntimeClientType, params: any, metadata?: any): Thenable<void> {
		if (!this._kernel) {
			throw new Error('Session not started');
		}
		return this._kernel.createClient(id, type, params, metadata);
	}

	listClients(type?: positron.RuntimeClientType): Thenable<Record<string, string>> {
		if (!this._kernel) {
			return Promise.resolve({});
		}
		return this._kernel.listClients(type);
	}

	removeClient(id: string): void {
		if (!this._kernel) {
			return;
		}
		this._kernel.removeClient(id);
	}

	sendClientMessage(clientId: string, messageId: string, message: any): void {
		if (!this._kernel) {
			throw new Error('Session not started');
		}
		this._kernel.sendClientMessage(clientId, messageId, message);
	}

	replyToPrompt(id: string, reply: string): void {
		if (!this._kernel) {
			throw new Error('Session not started');
		}
		this._kernel.replyToPrompt(id, reply);
	}

	async interrupt(): Promise<void> {
		if (!this._kernel) {
			return;
		}
		return this._kernel.interrupt();
	}

	async restart(workingDirectory?: string): Promise<void> {
		LOGGER.info(`Restarting Julia session ${this.metadata.sessionId}`);
		if (!this._kernel) {
			throw new Error('Cannot restart; kernel not started');
		}
		return this._kernel.restart(workingDirectory);
	}

	async shutdown(exitReason = positron.RuntimeExitReason.Shutdown): Promise<void> {
		LOGGER.info(`Shutting down Julia session ${this.metadata.sessionId}`);
		if (!this._kernel) {
			throw new Error('Cannot shutdown; kernel not started');
		}
		return this._kernel.shutdown(exitReason);
	}

	async forceQuit(): Promise<void> {
		LOGGER.info(`Force quitting Julia session ${this.metadata.sessionId}`);
		if (!this._kernel) {
			throw new Error('Cannot force quit; kernel not started');
		}
		return this._kernel.forceQuit();
	}

	showOutput(channel?: positron.LanguageRuntimeSessionChannel): void {
		if (this._kernel) {
			this._kernel.showOutput(channel);
		}
	}

	async showProfile(): Promise<void> {
		LOGGER.info('Profiler not yet implemented for Julia');
	}

	openResource(_resource: vscode.Uri | string): Thenable<boolean> {
		// TODO: Implement resource handling (help URIs, etc.)
		return Promise.resolve(false);
	}

	getDynState(): Thenable<positron.LanguageRuntimeDynState> {
		return Promise.resolve(this.dynState);
	}

	async debug(_request: positron.DebugProtocolRequest): Promise<positron.DebugProtocolResponse> {
		throw new Error('Debugging is not yet supported for Julia sessions');
	}

	callMethod(method: string, ...args: any[]): Thenable<any> {
		if (!this._kernel) {
			throw new Error('Session not started');
		}
		return this._kernel.callMethod(method, ...args);
	}

	async setWorkingDirectory(dir: string): Promise<void> {
		if (!this._kernel) {
			throw new Error(`Cannot set working directory to ${dir}; kernel not started`);
		}
		// Escape the directory path for Julia
		const escapedDir = dir
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\$/g, '\\$');
		this._kernel.execute(
			`cd("${escapedDir}")`,
			'setwd-' + Date.now(),
			positron.RuntimeCodeExecutionMode.Interactive,
			positron.RuntimeErrorBehavior.Continue
		);
	}

	getPackageManager(): positron.LanguageRuntimePackageManager {
		return this._packageManager;
	}

	updateSessionName(name: string): void {
		this.dynState.sessionName = name;
	}
}
