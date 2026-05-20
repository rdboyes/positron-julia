/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';
import * as semver from 'semver';

import { LOGGER, supervisorApi, ensureLanguageServerForVersion } from './extension';
import { juliaRuntimeDiscoverer } from './provider';
import { JuliaSession } from './session';
import { JuliaInstallation, ReasonDiscovered } from './julia-installation';
import { createJuliaRuntimeMetadata, getJuliaRuntimeIconBase64 } from './runtime';
import { createJuliaKernelSpec } from './kernel-spec';

/**
 * Extra runtime data stored in Julia runtime metadata.
 */
interface JuliaExtraRuntimeData {
	homepath: string;
	arch: string;
	releaseDate?: string;
}

/**
 * Manages Julia runtimes for Positron.
 */
export class JuliaRuntimeManager implements positron.LanguageRuntimeManager {

	private readonly _context: vscode.ExtensionContext;

	/** Map of runtime ID to Julia installation */
	private readonly _installations = new Map<string, JuliaInstallation>();

	/** Map of session ID to active JuliaSession (for interrupt etc.) */
	private readonly _activeSessions = new Map<string, JuliaSession>();

	getActiveJuliaSession(): JuliaSession | undefined {
		for (const session of this._activeSessions.values()) {
			return session;
		}
		return undefined;
	}

	/** Recommended runtime for the current workspace */
	private _recommendedRuntime: positron.LanguageRuntimeMetadata | undefined;

	/**
	 * Returns the recommended runtime for the current workspace.
	 */
	recommendedWorkspaceRuntime(): Thenable<positron.LanguageRuntimeMetadata | undefined> {
		return Promise.resolve(this._recommendedRuntime);
	}

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
	}

	/**
	 * Gets a Julia installation from the cache or reconstructs it from runtime metadata.
	 * This is needed because session restoration may happen before runtime discovery completes.
	 */
	private getOrReconstructInstallation(
		runtimeMetadata: positron.LanguageRuntimeMetadata
	): JuliaInstallation {
		// First, try to get from the cache
		const cached = this._installations.get(runtimeMetadata.runtimeId);
		if (cached) {
			return cached;
		}

		// Otherwise, reconstruct from runtime metadata
		const extraData = runtimeMetadata.extraRuntimeData as JuliaExtraRuntimeData;
		if (!extraData?.homepath) {
			throw new Error(`Cannot reconstruct Julia installation: missing extraRuntimeData`);
		}

		LOGGER.debug(`Reconstructing Julia installation from metadata for ${runtimeMetadata.runtimeName}`);
		const parsedVersion = semver.parse(runtimeMetadata.languageVersion);
		if (!parsedVersion) {
			throw new Error(`Cannot parse Julia version: ${runtimeMetadata.languageVersion}`);
		}
		return {
			binpath: runtimeMetadata.runtimePath,
			homepath: extraData.homepath,
			version: runtimeMetadata.languageVersion,
			semVersion: parsedVersion,
			arch: extraData.arch || process.arch,
			releaseDate: extraData.releaseDate,
			current: false,
			reasonDiscovered: ReasonDiscovered.PATH,
		};
	}

	/**
	 * Discovers all available Julia runtimes on the system.
	 */
	async* discoverAllRuntimes(): AsyncGenerator<positron.LanguageRuntimeMetadata> {
		LOGGER.info('Discovering Julia runtimes...');

		for await (const installation of juliaRuntimeDiscoverer()) {
			const metadata = createJuliaRuntimeMetadata(installation, this._context.extensionPath);
			this._installations.set(metadata.runtimeId, installation);
			LOGGER.info(`Discovered Julia ${installation.version} at ${installation.binpath}`);
			yield metadata;
		}
	}

	/**
	 * Creates a new Julia session for the given runtime.
	 */
	async createSession(
		runtimeMetadata: positron.LanguageRuntimeMetadata,
		sessionMetadata: positron.RuntimeSessionMetadata
	): Promise<positron.LanguageRuntimeSession> {
		const installation = this.getOrReconstructInstallation(runtimeMetadata);

		// Ensure Language Server is running with the correct Julia version
		// This handles switching between Julia versions gracefully
		await ensureLanguageServerForVersion(installation, this._context);

		// Resolve the user's Julia project path: prefer an explicitly saved config
		// value (set when the user switches environments via the status bar), then
		// fall back to the first workspace folder so Julia can auto-detect a
		// Project.toml there.
		const positronJuliaConfig = vscode.workspace.getConfiguration('positron.julia');
		const userProjectPath =
			positronJuliaConfig.get<string>('languageServer.environmentPath') ||
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		// Create the kernel spec for a new session
		const kernelSpec = createJuliaKernelSpec(installation, userProjectPath);

		LOGGER.info(`Creating Julia session for ${runtimeMetadata.runtimeName}`);
		const session = new JuliaSession(
			runtimeMetadata,
			sessionMetadata,
			installation,
			this._context.extensionPath,
			kernelSpec
		);
		this._activeSessions.set(sessionMetadata.sessionId, session);
		session.onDidEndSession(() => this._activeSessions.delete(sessionMetadata.sessionId));
		return session;
	}

	/**
	 * Restores an existing Julia session.
	 * When restoring, we don't pass a kernel spec so the session reconnects
	 * to the existing kernel rather than starting a new one.
	 */
	async restoreSession(
		runtimeMetadata: positron.LanguageRuntimeMetadata,
		sessionMetadata: positron.RuntimeSessionMetadata,
		sessionName: string
	): Promise<positron.LanguageRuntimeSession> {
		const installation = this.getOrReconstructInstallation(runtimeMetadata);

		// Ensure Language Server is running when restoring a session
		// This handles the case where Positron was reloaded and the LS needs to be started
		await ensureLanguageServerForVersion(installation, this._context);

		LOGGER.info(`Restoring Julia session for ${runtimeMetadata.runtimeName}`);
		// Don't pass kernelSpec so the session will reconnect to the existing kernel
		const session = new JuliaSession(
			runtimeMetadata,
			sessionMetadata,
			installation,
			this._context.extensionPath,
			undefined,  // No kernel spec for restore
			sessionName
		);
		this._activeSessions.set(sessionMetadata.sessionId, session);
		session.onDidEndSession(() => this._activeSessions.delete(sessionMetadata.sessionId));
		return session;
	}

	/**
	 * Validates an existing session to check if it can be restored.
	 *
	 * @param sessionId The session ID to validate
	 * @returns True if the session is valid and can be restored, false otherwise
	 */
	async validateSession(sessionId: string): Promise<boolean> {
		const api = await supervisorApi();
		return await api.validateSession(sessionId);
	}

	/**
	 * Validates session metadata to check if a session can be restored.
	 */
	async validateMetadata(
		metadata: positron.LanguageRuntimeMetadata
	): Promise<positron.LanguageRuntimeMetadata> {
		return {
			...metadata,
			base64EncodedIconSvg: getJuliaRuntimeIconBase64(this._context.extensionPath),
		};
	}
}
