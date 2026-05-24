/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

import { LOGGER } from '../extension';
import { JuliaRuntimeManager } from '../runtime-manager';
import { juliaRuntimeDiscoverer } from '../provider';
import { JuliaInstallation } from '../julia-installation';

function generatePipeName(id: string, prefix: string): string {
	if (process.platform === 'win32') {
		return `\\\\.\\pipe\\${prefix}-${id}`;
	} else {
		return path.join(os.tmpdir(), `${prefix}-${id}.sock`);
	}
}

class JuliaDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration
	): vscode.DebugConfiguration {
		if (!config.type && !config.request && !config.name) {
			config.type = 'julia';
			config.request = 'launch';
			config.name = 'Launch Julia';
			config.program = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
			config.cwd = '${workspaceFolder}';
		}
		if (!config.request) {
			config.request = 'launch';
		}
		if (!config.stopOnEntry) {
			config.stopOnEntry = false;
		}
		if (!config.cwd && config.request !== 'attach') {
			config.cwd = '${workspaceFolder}';
		}
		if (!config.juliaAdditionalArgs) {
			config.juliaAdditionalArgs = [];
		}
		if (!config.internalConsoleOptions) {
			config.internalConsoleOptions = 'neverOpen';
		}
		return config;
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly runtimeManager: JuliaRuntimeManager
	) {}

	async createDebugAdapterDescriptor(
		session: vscode.DebugSession
	): Promise<vscode.DebugAdapterDescriptor> {
		const installation = await this.getInstallation();

		const dap_pn = generatePipeName(randomUUID(), 'vsc-jl-dbg');
		const ready_pn = generatePipeName(randomUUID(), 'vsc-jl-ready');

		await new Promise<void>((resolve, reject) => {
			const server = net.createServer((socket) => {
				socket.once('data', () => {
					server.close();
					resolve();
				});
			});
			server.on('error', reject);
			server.listen(ready_pn, () => {
				const numThreads = vscode.workspace.getConfiguration('julia').get<number | string | null>('NumThreads', null);
				const additionalArgs = session.configuration.juliaAdditionalArgs as string[] ?? [];
				const jlArgs = [
					'--startup-file=no',
					'--history-file=no',
					'--color=yes',
					...(numThreads !== null ? [`--threads=${numThreads}`] : []),
					...additionalArgs,
					path.join(this.context.extensionPath, 'scripts', 'debugger', 'run_debugger.jl'),
					ready_pn,
					dap_pn,
					'',  // crash reporting pipe (unused in positron-julia)
				];

				const positronJuliaConfig = vscode.workspace.getConfiguration('positron.julia');
				const envPath =
					positronJuliaConfig.get<string>('languageServer.environmentPath') ||
					vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				const spawnEnv = envPath
					? { ...process.env, JULIA_PROJECT: envPath }
					: process.env;

				LOGGER.info(`Spawning Julia debugger: ${installation.binpath} ${jlArgs.join(' ')}`);
				const proc = spawn(installation.binpath, jlArgs, { detached: false, env: spawnEnv });
				proc.on('error', (err) => {
					server.close();
					reject(new Error(`Failed to spawn Julia debugger: ${err.message}`));
				});
				proc.stderr.on('data', (data: Buffer) => {
					LOGGER.warn(`Julia debugger stderr: ${data.toString().trim()}`);
				});
			});
		});

		return new vscode.DebugAdapterNamedPipeServer(dap_pn);
	}

	private async getInstallation(): Promise<JuliaInstallation> {
		const active = this.runtimeManager.getActiveJuliaSession();
		if (active) {
			return active.installation;
		}
		for await (const inst of juliaRuntimeDiscoverer()) {
			return inst;
		}
		throw new Error('No Julia installation found for debugging');
	}
}

export function registerDebugFeature(
	context: vscode.ExtensionContext,
	runtimeManager: JuliaRuntimeManager
): void {
	const provider = new JuliaDebugConfigurationProvider();
	const factory = new InlineDebugAdapterFactory(context, runtimeManager);

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('julia', provider),
		vscode.debug.registerDebugAdapterDescriptorFactory('julia', factory)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('julia.runEditorContents', async (resource?: vscode.Uri) => {
			const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
			if (!uri) {
				vscode.window.showInformationMessage('No active Julia file.');
				return;
			}
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			const success = await vscode.debug.startDebugging(folder, {
				type: 'julia',
				name: 'Run Julia File',
				request: 'launch',
				program: uri.fsPath,
				noDebug: true,
			});
			if (!success) {
				vscode.window.showErrorMessage('Could not run Julia file.');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('julia.debugEditorContents', async (resource?: vscode.Uri) => {
			const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
			if (!uri) {
				vscode.window.showInformationMessage('No active Julia file.');
				return;
			}
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			const success = await vscode.debug.startDebugging(folder, {
				type: 'julia',
				name: 'Debug Julia File',
				request: 'launch',
				program: uri.fsPath,
			});
			if (!success) {
				vscode.window.showErrorMessage('Could not debug Julia file.');
			}
		})
	);
}
