/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import * as positron from 'positron';

import { LOGGER } from './extension';

const QUERY_TIMEOUT_MS = 2 * 60 * 1000;
const MUTATION_TIMEOUT_MS = 30 * 60 * 1000;

export interface JuliaPackageSpec {
	name: string;
	version?: string;
}

export interface JuliaLanguageRuntimePackage {
	id: string;
	name: string;
	displayName: string;
	version: string;
}

interface JuliaPackageSession {
	execute(
		code: string,
		id: string,
		mode: positron.RuntimeCodeExecutionMode,
		errorBehavior: positron.RuntimeErrorBehavior
	): void;
	onDidReceiveRuntimeMessageRaw: vscode.Event<positron.LanguageRuntimeMessage>;
	suppressRuntimeMessages(executionId: string): vscode.Disposable;
}

export class JuliaPackageManager {
	private readonly _session: JuliaPackageSession;
	private readonly _scriptPath: string;
	private _scriptSourced = false;
	private _scriptSourcing: Promise<void> | undefined;

	constructor(session: JuliaPackageSession, extensionPath: string) {
		this._session = session;
		this._scriptPath = path.join(extensionPath, 'scripts', 'packages', 'packages.jl');
	}

	async onRuntimeReady(): Promise<void> {
		this._scriptSourced = false;
		await this.sourcePackagesScript();
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

	async getPackages(): Promise<JuliaLanguageRuntimePackage[]> {
		await this.sourcePackagesScript();
		const raw = await this._executeAndCapture('_positron_list_packages()', positron.RuntimeCodeExecutionMode.Silent, QUERY_TIMEOUT_MS);
		return this._parsePackages(raw);
	}

	async installPackages(packages: JuliaPackageSpec[]): Promise<void> {
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
		await this._executeAndWait(code, MUTATION_TIMEOUT_MS);
	}

	async uninstallPackages(packageNames: string[]): Promise<void> {
		await this.sourcePackagesScript();
		const names = packageNames.map((name) => name.trim()).filter((name) => name.length > 0);
		if (names.length === 0) {
			return;
		}
		await this._executeAndWait(
			`_positron_uninstall_packages(${this._toJuliaStringVector(names)})`,
			MUTATION_TIMEOUT_MS
		);
	}

	async updatePackages(packages: JuliaPackageSpec[]): Promise<void> {
		await this.sourcePackagesScript();
		const names = packages
			.filter((pkg) => pkg?.name && pkg.name.trim().length > 0)
			.map((pkg) => pkg.name.trim());
		if (names.length === 0) {
			return;
		}
		await this._executeAndWait(
			`_positron_update_packages(${this._toJuliaStringVector(names)})`,
			MUTATION_TIMEOUT_MS
		);
	}

	async updateAllPackages(): Promise<void> {
		await this.sourcePackagesScript();
		await this._executeAndWait('_positron_update_all_packages()', MUTATION_TIMEOUT_MS);
	}

	async searchPackages(query: string): Promise<JuliaLanguageRuntimePackage[]> {
		await this.sourcePackagesScript();
		const escaped = this._escapeJuliaStringLiteral(query);
		const raw = await this._executeAndCapture(
			`_positron_search_packages("${escaped}")`,
			positron.RuntimeCodeExecutionMode.Silent,
			QUERY_TIMEOUT_MS
		);
		return this._parsePackages(raw);
	}

	async searchPackageVersions(name: string): Promise<string[]> {
		await this.sourcePackagesScript();
		const escaped = this._escapeJuliaStringLiteral(name);
		const raw = await this._executeAndCapture(
			`_positron_search_package_versions("${escaped}")`,
			positron.RuntimeCodeExecutionMode.Silent,
			QUERY_TIMEOUT_MS
		);
		return this._parseStringArray(raw);
	}

	private _parsePackages(raw: string): JuliaLanguageRuntimePackage[] {
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
		timeoutMs: number = QUERY_TIMEOUT_MS
	): Promise<string> {
		const result = await this._execute(code, mode, timeoutMs);
		return result.stdout;
	}

	private async _executeAndWait(code: string, timeoutMs: number = MUTATION_TIMEOUT_MS): Promise<void> {
		await this._execute(code, positron.RuntimeCodeExecutionMode.Interactive, timeoutMs);
	}

	private _execute(
		code: string,
		mode: positron.RuntimeCodeExecutionMode,
		timeoutMs: number
	): Promise<{ stdout: string; stderr: string }> {
		const executionId = crypto.randomUUID();
		let stdout = '';
		let stderr = '';

		return new Promise((resolve, reject) => {
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let messageDisposable: vscode.Disposable | undefined;
			let suppressDisposable: vscode.Disposable | undefined;

			const cleanup = () => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				suppressDisposable?.dispose();
				messageDisposable?.dispose();
			};

			const finishResolve = () => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve({ stdout, stderr });
			};

			const finishReject = (error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			};

			timeoutHandle = setTimeout(() => {
				finishReject(new Error(`Timed out waiting for Julia package command to finish (${timeoutMs}ms)`));
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
						finishReject(new Error(
							`Julia package command failed: ${errorMessage.name}: ${errorMessage.message}` +
							(traceback ? `\n${traceback}` : '')
						));
						break;
					}
					case positron.LanguageRuntimeMessageType.State: {
						const stateMessage = message as positron.LanguageRuntimeState;
						if (stateMessage.state === positron.RuntimeOnlineState.Idle) {
							finishResolve();
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
				finishReject(error);
			}
		});
	}
}
