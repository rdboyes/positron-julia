/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';

import { JuliaRuntimeManager } from './runtime-manager';
import { registerCommands } from './commands';
import { PositronSupervisorApi } from './positron-supervisor';
import { JuliaLanguageClient } from './lsp';
import { juliaRuntimeDiscoverer } from './provider';
import { registerCompletionProvider, getRuntimeCompletions } from './completions';
import { registerStatementRangeProvider } from './statement-range';
import { registerSemanticTokensProvider } from './semantic-highlighting';
import { registerHelpTopicProvider } from './help';
import { registerCellCommands } from './cells';
import { JuliaEnvironmentManager } from './environment';
import { TestFeature } from './testing/testFeature';
import { notifyTypeTextDocumentPublishTests } from './testing/testLSProtocol';
import { registerDebugFeature } from './debugger/debugFeature';

export const LOGGER = vscode.window.createOutputChannel('Julia Language Pack', { log: true });

let languageClient: JuliaLanguageClient | undefined;
let languageServerStarting: Promise<void> | undefined;
let _context: vscode.ExtensionContext | undefined;
let _testFeature: import('./testing/testFeature').TestFeature | undefined;

export function getLanguageClient(): JuliaLanguageClient | undefined {
	return languageClient;
}

export async function restartLanguageServer(): Promise<void> {
	if (!_context) {
		return;
	}
	await disposeLanguageClient();
	await startLanguageServer(_context);
}

async function disposeLanguageClient(): Promise<void> {
	if (!languageClient) {
		return;
	}

	const client = languageClient;
	languageClient = undefined;

	try {
		await client.stop();
	} catch (error) {
		LOGGER.warn(`Error stopping Julia Language Server: ${error}`);
	}

	try {
		client.dispose();
	} catch (error) {
		LOGGER.warn(`Error disposing Julia Language Server client: ${error}`);
	}
}

export async function activate(context: vscode.ExtensionContext) {
	_context = context;
	const onDidChangeLogLevel = (logLevel: vscode.LogLevel) => {
		LOGGER.appendLine(vscode.l10n.t('Log level: {0}', vscode.LogLevel[logLevel]));
	};
	context.subscriptions.push(LOGGER.onDidChangeLogLevel(onDidChangeLogLevel));
	onDidChangeLogLevel(LOGGER.logLevel);

	// Create and register the Julia runtime manager
	const juliaRuntimeManager = new JuliaRuntimeManager(context);
	context.subscriptions.push(
		positron.runtime.registerLanguageRuntimeManager('julia', juliaRuntimeManager)
	);

	// Register commands
	registerCommands(context, juliaRuntimeManager);

	// Register runtime completion provider (uses Jupyter complete_request via callMethod)
	registerCompletionProvider(context);

	// Register statement range provider (Ctrl+Enter multiline support)
	registerStatementRangeProvider(context);

	// Register semantic highlighting provider (token-class highlighting)
	registerSemanticTokensProvider(context);

	// Register help topic provider (F1 / Help pane lookup at cursor)
	context.subscriptions.push(registerHelpTopicProvider(() => languageClient));

	// Register code cell execution commands (# %% / ## delimiters)
	registerCellCommands(context);

	// Environment status bar and switching
	const environmentManager = new JuliaEnvironmentManager();
	environmentManager.activate(context, getLanguageClient, () => juliaRuntimeManager.getActiveJuliaSession());

	// Debug Adapter Protocol — breakpoints, step-through, variable inspection
	registerDebugFeature(context, juliaRuntimeManager);

	// Test Explorer — discovers @testitem blocks via the LS and runs them via a Julia subprocess
	_testFeature = new TestFeature(
		context,
		juliaRuntimeManager,
		() => languageClient?.innerClient
	);
	context.subscriptions.push(_testFeature);

	// Start language server when a Julia file is opened
	// Also check if any Julia files are already open (e.g., after reload)
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(async (document) => {
			if (document.languageId !== 'julia') {
				return;
			}

			if (!languageClient) {
				await startLanguageServer(context, undefined, document.uri.fsPath).catch(error => {
					LOGGER.warn(`Language server not started: ${error.message}`);
				});
				return;
			}

			await languageClient.refreshEnvironmentForFile(document.uri.fsPath).catch(error => {
				LOGGER.warn(`Language server environment refresh failed: ${error.message}`);
			});
		})
	);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(async (editor) => {
			const document = editor?.document;
			if (!document || document.languageId !== 'julia' || !languageClient) {
				return;
			}
			await languageClient.refreshEnvironmentForFile(document.uri.fsPath).catch(error => {
				LOGGER.warn(`Language server environment refresh failed: ${error.message}`);
			});
		})
	);

	// Check if Julia files are already open (handles reload case)
	const openJuliaDocument = vscode.workspace.textDocuments.find(
		doc => doc.languageId === 'julia'
	);
	if (openJuliaDocument) {
		startLanguageServer(context, undefined, openJuliaDocument.uri.fsPath).catch(error => {
			LOGGER.warn(`Language server not started: ${error.message}`);
		});
	}

	// Notify users when kernel-affecting settings change (only take effect on next session)
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			const kernelSettings = ['julia.NumThreads', 'julia.additionalArgs', 'julia.packageServer'];
			if (kernelSettings.some(s => event.affectsConfiguration(s))) {
				vscode.window.showInformationMessage(
					'Julia: Restart the Julia session to apply the updated settings.'
				);
			}
			// Restart LS when inlay hint settings change (they're passed at initialization time)
			const lsInitSettings = [
				'julia.inlayHints.static.enabled',
				'julia.inlayHints.static.variableTypes.enabled',
				'julia.inlayHints.static.parameterNames.enabled',
			];
			if (lsInitSettings.some(s => event.affectsConfiguration(s))) {
				restartLanguageServer().catch(err => {
					LOGGER.warn(`Failed to restart Language Server after settings change: ${err}`);
				});
			}
		})
	);

	LOGGER.info('Positron Julia extension activated');
}

/**
 * Starts the Julia Language Server with a specific Julia installation.
 * If no installation is provided, uses the first available one.
 *
 * @param context Extension context
 * @param installation Optional specific Julia installation to use
 */
async function startLanguageServer(
	context: vscode.ExtensionContext,
	installation?: any,
	preferredFilePath?: string
): Promise<void> {
	// If a start is already in progress, wait for it instead of starting another
	if (languageServerStarting) {
		return languageServerStarting;
	}

	// Check if language server is enabled
	const config = vscode.workspace.getConfiguration('positron.julia');
	if (!config.get<boolean>('languageServer.enabled', true)) {
		LOGGER.info('Julia Language Server is disabled');
		return;
	}

	// If LS is already running, don't start another
	if (languageClient?.isRunning()) {
		LOGGER.debug('Julia Language Server is already running');
		return;
	}

	languageServerStarting = doStartLanguageServer(context, installation, preferredFilePath);
	try {
		await languageServerStarting;
	} finally {
		languageServerStarting = undefined;
	}
}

async function doStartLanguageServer(
	context: vscode.ExtensionContext,
	installation?: any,
	preferredFilePath?: string
): Promise<void> {
	// If no installation provided, find the first available one
	if (!installation) {
		LOGGER.debug('No installation provided, discovering Julia installations...');
		for await (const inst of juliaRuntimeDiscoverer()) {
			installation = inst;
			break;
		}
	}

	if (!installation) {
		LOGGER.warn('No Julia installation found for language server');
		return;
	}

	LOGGER.info(`Starting Julia Language Server with Julia ${installation.version}`);

	// Defensive cleanup in case a stale client instance exists.
	if (languageClient) {
		LOGGER.debug('Disposing stale Julia Language Server client before startup');
		await disposeLanguageClient();
	}

	// Create and start the language client
	languageClient = new JuliaLanguageClient(context.extensionPath);
	context.subscriptions.push(languageClient);

	try {
		await languageClient.start(installation, preferredFilePath, (client) => {
			// Register julia/publishTests BEFORE the client starts so we never
			// miss notifications sent during the initialization phase.
			if (_testFeature) {
				LOGGER.info('Registering julia/publishTests notification handler');
				client.onNotification(notifyTypeTextDocumentPublishTests, params => {
					LOGGER.debug(`julia/publishTests received for ${params.uri} (${params.testItemDetails.length} items)`);
					_testFeature!.publishTestsHandler(params);
				});
			}

			LOGGER.info('Registering repl/getcompletions and repl/getCompletions request handlers');
			const handleGetCompletions = async (params: any) => {
				LOGGER.debug(`LSP repl completion request received with params: ${JSON.stringify(params)}`);
				let query = '';
				if (typeof params === 'string') {
					query = params;
				} else if (params && typeof params === 'object') {
					query = params.query ?? params.text ?? params.line ?? params.code ?? params.word ?? '';
				}
				const completions = await getRuntimeCompletions(query);
				return completions;
			};

			client.onRequest('repl/getcompletions', handleGetCompletions);
			client.onRequest('repl/getCompletions', handleGetCompletions);
		});
		LOGGER.info('Julia Language Server started successfully');
	} catch (error) {
		LOGGER.error(`Failed to start language server: ${error}`);
		languageClient = undefined;
	}
}

export function deactivate() {
	LOGGER.info('Positron Julia extension deactivated');
	return disposeLanguageClient();
}

export async function supervisorApi(): Promise<PositronSupervisorApi> {
	const ext = vscode.extensions.getExtension('positron.positron-supervisor');
	if (!ext) {
		throw new Error('Positron Supervisor extension not found');
	}

	if (!ext.isActive) {
		await ext.activate();
	}

	return ext?.exports as PositronSupervisorApi;
}

/**
 * Ensures the Language Server is running with the specified Julia version.
 * Restarts the LS if it's running with a different version.
 * Called when creating or restoring a session to ensure version compatibility.
 */
export async function ensureLanguageServerForVersion(
	installation: any,
	context: vscode.ExtensionContext
): Promise<void> {
	// If a start is already in progress, wait for it
	if (languageServerStarting) {
		await languageServerStarting;
	}

	// If no LS is running, start it with this version
	if (!languageClient || !languageClient.isRunning()) {
		LOGGER.info(`Language Server not running, starting for Julia ${installation.version}`);
		const activeDocument = vscode.window.activeTextEditor?.document;
		const preferredFilePath = activeDocument?.languageId === 'julia' ? activeDocument.uri.fsPath : undefined;
		await startLanguageServer(context, installation, preferredFilePath);
		return;
	}

	// If LS is running with a different Julia version, restart it
	// Access private _installation field (TypeScript limitation)
	const currentInstallation = (languageClient as unknown as { _installation?: { version: string } })._installation;
	const currentVersion = currentInstallation?.version;
	if (currentVersion && currentVersion !== installation.version) {
		LOGGER.info(`Restarting Language Server: switching from Julia ${currentVersion} to ${installation.version}`);
		await disposeLanguageClient();
		const activeDocument = vscode.window.activeTextEditor?.document;
		const preferredFilePath = activeDocument?.languageId === 'julia' ? activeDocument.uri.fsPath : undefined;
		await startLanguageServer(context, installation, preferredFilePath);
	} else {
		LOGGER.debug(`Language Server already running with Julia ${currentVersion}`);
		const activeDocument = vscode.window.activeTextEditor?.document;
		if (activeDocument?.languageId === 'julia') {
			await languageClient.refreshEnvironmentForFile(activeDocument.uri.fsPath);
		}
	}
}
