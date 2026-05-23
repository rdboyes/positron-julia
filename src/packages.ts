/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as positron from 'positron';

import { LOGGER } from './extension';

const QUERY_TIMEOUT_MS = 2 * 60 * 1000;
const MUTATION_TIMEOUT_MS = 30 * 60 * 1000;

interface JuliaPackageSession {
	execute(
		code: string,
		id: string,
		mode: positron.RuntimeCodeExecutionMode,
		errorBehavior: positron.RuntimeErrorBehavior
	): void;
	interrupt(): Promise<void>;
	onDidReceiveRuntimeMessageRaw: vscode.Event<positron.LanguageRuntimeMessage>;
	suppressRuntimeMessages(executionId: string): vscode.Disposable;
}

export class JuliaPackageManager implements positron.LanguageRuntimePackageManager {
	private readonly _session: JuliaPackageSession;
	private readonly _scriptPath: string;
	private _scriptSourced = false;
	private _scriptSourcing: Promise<void> | undefined;
	// Tracks in-flight Interactive (mutation) commands; Silent commands are
	// already excluded via the suppressed-message stream.
	private _mutationCount = 0;

	private readonly _onDidChangePackages = new vscode.EventEmitter<void>();
	readonly onDidChangePackages: vscode.Event<void> = this._onDidChangePackages.event;

	private _notifyThrottleHandle: NodeJS.Timeout | undefined;
	private _notifyPending = false;
	private static readonly _NOTIFY_THROTTLE_MS = 10_000;

	constructor(session: JuliaPackageSession, extensionPath: string) {
		this._session = session;
		this._scriptPath = path.join(extensionPath, 'scripts', 'packages', 'packages.jl');
	}

	async onRuntimeReady(): Promise<void> {
		this._scriptSourced = false;
		await this.sourcePackagesScript();
	}

	// Called from JuliaSession when an unsuppressed Idle message arrives
	// (i.e. user-executed code finished, not one of our Silent package calls).
	// Throttled to fire at most once per _NOTIFY_THROTTLE_MS, with a trailing
	// fire if any idles arrived during the cooldown.
	notifyRuntimeIdle(): void {
		if (this._mutationCount === 0 && this._scriptSourced) {
			if (this._notifyThrottleHandle) {
				this._notifyPending = true;
				return;
			}
			this._firePackagesChanged();
			this._notifyThrottleHandle = setTimeout(() => {
				this._notifyThrottleHandle = undefined;
				if (this._notifyPending) {
					this._notifyPending = false;
					this._firePackagesChanged();
				}
			}, JuliaPackageManager._NOTIFY_THROTTLE_MS);
		}
	}

	private _firePackagesChanged(): void {
		this._onDidChangePackages.fire();
		// Trigger the packages pane refresh directly via command. This is
		// needed because Positron's packages pane only auto-refreshes on
		// RuntimeState.Ready (startup), not after ordinary console executions.
		vscode.commands.executeCommand('positronPackages.refreshPackages').then(
			undefined,
			() => { /* command unavailable in this Positron version, ignore */ }
		);
	}

	async sourcePackagesScript(): Promise<void> {
		if (this._scriptSourced) {
			return;
		}
		if (this._scriptSourcing) {
			return this._scriptSourcing;
		}

		this._scriptSourcing = (async () => {
			const escapedScriptPath = this._escapeJuliaStringLiteral(this._scriptPath);
			await this._executeAndCapture(
				`include("${escapedScriptPath}")`,
				positron.RuntimeCodeExecutionMode.Silent,
				QUERY_TIMEOUT_MS
			);
			this._scriptSourced = true;
			LOGGER.debug(`Sourced Julia package helper script: ${this._scriptPath}`);
		})()
			.catch((error) => {
				this._scriptSourced = false;
				throw error;
			})
			.finally(() => {
				this._scriptSourcing = undefined;
			});

		return this._scriptSourcing;
	}

	async getPackages(token?: vscode.CancellationToken): Promise<positron.LanguageRuntimePackage[]> {
		await this.sourcePackagesScript();
		const raw = await this._executeAndCapture(
			'_positron_list_packages()',
			positron.RuntimeCodeExecutionMode.Silent,
			QUERY_TIMEOUT_MS,
			token
		);
		return this._parsePackages(raw);
	}

	async installPackages(packages: positron.PackageSpec[], token?: vscode.CancellationToken): Promise<void> {
		await this.sourcePackagesScript();
		const specs = packages
			.filter((pkg) => pkg?.name && pkg.name.trim().length > 0)
			.map((pkg) => pkg.version && pkg.version.trim().length > 0
				? `${pkg.name.trim()}@${pkg.version.trim()}`
				: pkg.name.trim());
		if (specs.length === 0) {
			return;
		}

		const code = `_positron_install_packages(${this._toJuliaStringVector(specs)})`;
		await this._executeAndWait(code, MUTATION_TIMEOUT_MS, token);
	}

	async uninstallPackages(packageNames: string[], token?: vscode.CancellationToken): Promise<void> {
		await this.sourcePackagesScript();
		const names = packageNames.map((name) => name.trim()).filter((name) => name.length > 0);
		if (names.length === 0) {
			return;
		}
		await this._executeAndWait(
			`_positron_uninstall_packages(${this._toJuliaStringVector(names)})`,
			MUTATION_TIMEOUT_MS,
			token
		);
	}

	async updatePackages(packages: positron.PackageSpec[], token?: vscode.CancellationToken): Promise<void> {
		await this.sourcePackagesScript();
		const names = packages
			.filter((pkg) => pkg?.name && pkg.name.trim().length > 0)
			.map((pkg) => pkg.name.trim());
		if (names.length === 0) {
			return;
		}
		await this._executeAndWait(
			`_positron_update_packages(${this._toJuliaStringVector(names)})`,
			MUTATION_TIMEOUT_MS,
			token
		);
	}

	async updateAllPackages(token?: vscode.CancellationToken): Promise<void> {
		await this.sourcePackagesScript();
		await this._executeAndWait('_positron_update_all_packages()', MUTATION_TIMEOUT_MS, token);
	}

	async searchPackages(query: string, token?: vscode.CancellationToken): Promise<positron.LanguageRuntimePackage[]> {
		await this.sourcePackagesScript();
		const escaped = this._escapeJuliaStringLiteral(query);
		const raw = await this._executeAndCapture(
			`_positron_search_packages("${escaped}")`,
			positron.RuntimeCodeExecutionMode.Silent,
			QUERY_TIMEOUT_MS,
			token
		);
		return this._parsePackages(raw);
	}

	async searchPackageVersions(name: string, token?: vscode.CancellationToken): Promise<string[]> {
		await this.sourcePackagesScript();
		const escaped = this._escapeJuliaStringLiteral(name);
		const raw = await this._executeAndCapture(
			`_positron_search_package_versions("${escaped}")`,
			positron.RuntimeCodeExecutionMode.Silent,
			QUERY_TIMEOUT_MS,
			token
		);
		return this._parseStringArray(raw);
	}

	async getPackageMetadata(
		packageNames: string[],
		token?: vscode.CancellationToken
	): Promise<Map<string, Partial<positron.LanguageRuntimePackage>>> {
		const cleaned = packageNames
			.map((name) => name.trim())
			.filter((name) => name.length > 0);
		if (cleaned.length === 0) {
			return new Map();
		}
		await this.sourcePackagesScript();
		const raw = await this._executeAndCapture(
			`_positron_package_metadata(${this._toJuliaStringVector(cleaned)})`,
			positron.RuntimeCodeExecutionMode.Silent,
			QUERY_TIMEOUT_MS,
			token
		);
		return this._parseMetadata(raw);
	}

	private _parsePackages(raw: string): positron.LanguageRuntimePackage[] {
		const parsed = this._parseJsonValue(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed
			.filter((item) => item && typeof item === 'object')
			.map((item) => {
				const record = item as Record<string, unknown>;
				const name = typeof record.name === 'string' ? record.name : '';
				const version = typeof record.version === 'string' ? record.version : '';
				return {
					id: typeof record.id === 'string' ? record.id : `${name}-${version}`,
					name,
					displayName: typeof record.displayName === 'string' ? record.displayName : name,
					version,
					attached: typeof record.attached === 'boolean' ? record.attached : undefined,
				};
			})
			.filter((pkg) => pkg.name.length > 0);
	}

	private _parseStringArray(raw: string): string[] {
		const parsed = this._parseJsonValue(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((item): item is string => typeof item === 'string');
	}

	private _parseMetadata(raw: string): Map<string, Partial<positron.LanguageRuntimePackage>> {
		const result = new Map<string, Partial<positron.LanguageRuntimePackage>>();
		const parsed = this._parseJsonValue(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return result;
		}
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') {
				continue;
			}
			const record = value as Record<string, unknown>;
			const partial: Partial<positron.LanguageRuntimePackage> = {};
			if (typeof record.latestVersion === 'string' && record.latestVersion.length > 0) {
				partial.latestVersion = record.latestVersion;
			}
			if (typeof record.license === 'string' && record.license.length > 0) {
				partial.license = record.license;
			}
			if (typeof record.publishedDate === 'string' && record.publishedDate.length > 0) {
				partial.publishedDate = record.publishedDate;
			}
			result.set(key, partial);
		}
		return result;
	}

	private _parseJsonValue(raw: string): unknown {
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			return [];
		}

		try {
			return JSON.parse(trimmed);
		} catch {
			// In rare cases, extra stream output can surround the JSON payload.
			const candidate = this._extractLikelyJson(trimmed);
			if (candidate) {
				return JSON.parse(candidate);
			}
			throw new Error(`Failed to parse JSON payload from Julia package command: ${trimmed.slice(0, 500)}`);
		}
	}

	private _extractLikelyJson(value: string): string | undefined {
		const arrayStart = value.indexOf('[');
		const arrayEnd = value.lastIndexOf(']');
		if (arrayStart >= 0 && arrayEnd > arrayStart) {
			return value.slice(arrayStart, arrayEnd + 1);
		}

		const objectStart = value.indexOf('{');
		const objectEnd = value.lastIndexOf('}');
		if (objectStart >= 0 && objectEnd > objectStart) {
			return value.slice(objectStart, objectEnd + 1);
		}
		return undefined;
	}

	private _toJuliaStringVector(values: string[]): string {
		return `[${values.map((value) => `"${this._escapeJuliaStringLiteral(value)}"`).join(', ')}]`;
	}

	private _escapeJuliaStringLiteral(value: string): string {
		return value
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\$/g, '\\$')
			.replace(/\r/g, '\\r')
			.replace(/\n/g, '\\n');
	}

	private async _executeAndCapture(
		code: string,
		mode: positron.RuntimeCodeExecutionMode = positron.RuntimeCodeExecutionMode.Silent,
		timeoutMs: number = QUERY_TIMEOUT_MS,
		token?: vscode.CancellationToken
	): Promise<string> {
		// Capture stdout via a temp file rather than the kernel's stream messages.
		// Positron's runtime supervisor surfaces stream output to the console even
		// for Silent executions, which leaked the raw packages JSON to the user.
		// Redirecting stdout into a file inside Julia means the kernel emits no
		// stream messages for these queries at all.
		//
		// We also redirect stderr to a second temp file (not devnull) so that its
		// content is preserved and forwarded to the extension logger rather than
		// being silenced entirely.  Crucially, we flush but do NOT explicitly close
		// the stderr file before the let-block exits: background tasks spawned
		// during the query inherit it as their task-local stderr, and keeping it
		// open means their failure-notice printing always succeeds (IOStream accepts
		// every show method).  This prevents the "SYSTEM: caught exception of type
		// :MethodError while trying to print a failed Task notice; giving up"
		// message — which appears because show(IJuliaStdio, exception) can fail
		// with MethodError for certain exception types — from reaching the user's
		// console.  The GC finalises the file handle after the let-block scope ends.
		const tempFile = path.join(os.tmpdir(), `positron-julia-${crypto.randomUUID()}.txt`);
		const tempFileErr = path.join(os.tmpdir(), `positron-julia-err-${crypto.randomUUID()}.txt`);
		const escapedPath = this._escapeJuliaStringLiteral(tempFile);
		const escapedPathErr = this._escapeJuliaStringLiteral(tempFileErr);
		const wrappedCode =
			`let __positron_io = open("${escapedPath}", "w"), __positron_err = open("${escapedPathErr}", "w")\n` +
			`try\n` +
			`redirect_stdout(__positron_io) do\n` +
			`redirect_stderr(__positron_err) do\n` +
			`${code}\n` +
			`end\n` +
			`end\n` +
			`finally\n` +
			`close(__positron_io)\n` +
			`flush(__positron_err)\n` +
			`end\n` +
			`end`;

		try {
			await this._execute(wrappedCode, mode, timeoutMs, token);
			const [stdout, stderr] = await Promise.all([
				fs.promises.readFile(tempFile, 'utf-8'),
				fs.promises.readFile(tempFileErr, 'utf-8').catch(() => ''),
			]);
			if (stderr.trim()) {
				LOGGER.debug(`Julia package command stderr:\n${stderr.trim()}`);
			}
			return stdout;
		} finally {
			fs.promises.unlink(tempFile).catch(() => { /* ignore cleanup errors */ });
			fs.promises.unlink(tempFileErr).catch(() => { /* ignore cleanup errors */ });
		}
	}

	private async _executeAndWait(
		code: string,
		timeoutMs: number = MUTATION_TIMEOUT_MS,
		token?: vscode.CancellationToken
	): Promise<void> {
		// Increment so notifyRuntimeIdle() doesn't fire the change event for
		// the Idle that ends this mutation — the packages instance already
		// refreshes explicitly after each install/uninstall/update.
		this._mutationCount++;
		try {
			await this._execute(code, positron.RuntimeCodeExecutionMode.Interactive, timeoutMs, token);
		} finally {
			this._mutationCount--;
		}
	}

	private _execute(
		code: string,
		mode: positron.RuntimeCodeExecutionMode,
		timeoutMs: number,
		token?: vscode.CancellationToken
	): Promise<{ stdout: string; stderr: string }> {
		const executionId = crypto.randomUUID();
		let stdout = '';
		let stderr = '';

		return new Promise((resolve, reject) => {
			let settled = false;
			let listenersDisposed = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let listenerForceCleanupHandle: NodeJS.Timeout | undefined;
			let messageDisposable: vscode.Disposable | undefined;
			let suppressDisposable: vscode.Disposable | undefined;
			let cancelDisposable: vscode.Disposable | undefined;

			// Kernel listeners and suppression are torn down only when the
			// kernel reports Idle (or after a hard timeout safety net). This
			// matters because Silent queries that are cancelled mid-flight are
			// not interrupted on the kernel side — keeping the suppression
			// listener alive ensures any output the kernel still produces is
			// silently discarded.
			const disposeListeners = () => {
				if (listenersDisposed) {
					return;
				}
				listenersDisposed = true;
				if (listenerForceCleanupHandle) {
					clearTimeout(listenerForceCleanupHandle);
					listenerForceCleanupHandle = undefined;
				}
				suppressDisposable?.dispose();
				messageDisposable?.dispose();
			};

			const settle = (action: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
					timeoutHandle = undefined;
				}
				cancelDisposable?.dispose();
				cancelDisposable = undefined;
				action();
			};

			if (token?.isCancellationRequested) {
				reject(new vscode.CancellationError());
				return;
			}

			// Safety net used after cancellation and timeout: if the kernel
			// never reports Idle, we still need to tear down the suppression
			// listener so it doesn't survive indefinitely.
			const scheduleForceListenerCleanup = () => {
				if (listenersDisposed || listenerForceCleanupHandle) {
					return;
				}
				listenerForceCleanupHandle = setTimeout(disposeListeners, 30_000);
			};

			cancelDisposable = token?.onCancellationRequested(() => {
				// For Silent (background) queries, do NOT interrupt the kernel.
				// Interrupt is kernel-wide in Jupyter and raises an
				// InterruptException whose error message Positron's supervisor
				// surfaces to the console regardless of our session-level
				// message suppression. Just abandon the awaited result; the
				// listener stays alive until the kernel finishes the query on
				// its own and reports Idle.
				if (mode !== positron.RuntimeCodeExecutionMode.Silent) {
					this._session.interrupt().catch(() => { /* best-effort */ });
				}
				settle(() => reject(new vscode.CancellationError()));
				// settle() has cleared the timeout, so without scheduling
				// another forced cleanup the suppression listener could leak
				// if the kernel never returns to Idle (e.g. a hung registry).
				scheduleForceListenerCleanup();
			});

			timeoutHandle = setTimeout(() => {
				settle(() => reject(new Error(`Timed out waiting for Julia package command to finish (${timeoutMs}ms)`)));
				scheduleForceListenerCleanup();
			}, timeoutMs);

			if (mode === positron.RuntimeCodeExecutionMode.Silent) {
				suppressDisposable = this._session.suppressRuntimeMessages(executionId);
			}

			messageDisposable = this._session.onDidReceiveRuntimeMessageRaw((message) => {
				if (message.parent_id !== executionId) {
					return;
				}

				switch (message.type) {
					case positron.LanguageRuntimeMessageType.Stream: {
						const streamMessage = message as positron.LanguageRuntimeStream;
						if (streamMessage.name === positron.LanguageRuntimeStreamName.Stdout) {
							stdout += streamMessage.text;
						} else {
							stderr += streamMessage.text;
						}
						break;
					}
					case positron.LanguageRuntimeMessageType.Error: {
						const errorMessage = message as positron.LanguageRuntimeError;
						const traceback = errorMessage.traceback?.join('\n') ?? '';
						settle(() => reject(new Error(
							`Julia package command failed: ${errorMessage.name}: ${errorMessage.message}` +
							(traceback ? `\n${traceback}` : '')
						)));
						break;
					}
					case positron.LanguageRuntimeMessageType.State: {
						const stateMessage = message as positron.LanguageRuntimeState;
						if (stateMessage.state === positron.RuntimeOnlineState.Idle) {
							settle(() => resolve({ stdout, stderr }));
							disposeListeners();
						}
						break;
					}
					default:
						break;
				}
			});

			try {
				this._session.execute(
					code,
					executionId,
					mode,
					positron.RuntimeErrorBehavior.Continue
				);
			} catch (error) {
				settle(() => reject(error instanceof Error ? error : new Error(String(error))));
				disposeListeners();
			}
		});
	}
}
