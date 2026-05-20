/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LOGGER } from './extension';
import { JuliaLanguageClient } from './lsp';

interface EnvQuickPickItem extends vscode.QuickPickItem {
	envPath: string;
}

/**
 * Manages the Julia project environment: status bar display and switching.
 */
export class JuliaEnvironmentManager implements vscode.Disposable {
	private readonly _statusBarItem: vscode.StatusBarItem;
	private _currentEnvPath: string | undefined;

	constructor() {
		this._statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100
		);
		this._statusBarItem.command = 'julia.changeCurrentEnvironment';
		this._statusBarItem.tooltip = 'Julia environment — click to change';
	}

	activate(
		context: vscode.ExtensionContext,
		getClient: () => JuliaLanguageClient | undefined,
		getSession: () => positron.LanguageRuntimeSession | undefined
	): void {
		context.subscriptions.push(this);

		// Detect the initial environment from the workspace
		this._currentEnvPath = this._detectDefaultEnvironment();
		this._updateStatusBar();
		this._statusBarItem.show();

		context.subscriptions.push(
			vscode.commands.registerCommand('julia.changeCurrentEnvironment', () =>
				this._changeEnvironment(getClient, getSession)
			)
		);

		// Update status bar when active editor changes to a Julia file
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor?.document.languageId === 'julia') {
					this._statusBarItem.show();
				}
			})
		);
	}

	private async _changeEnvironment(
		getClient: () => JuliaLanguageClient | undefined,
		getSession: () => positron.LanguageRuntimeSession | undefined
	): Promise<void> {
		const items = await this._buildEnvList();
		if (items.length === 0) {
			vscode.window.showInformationMessage('No Julia environments found.');
			return;
		}

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a Julia project environment',
			matchOnDescription: true,
		});

		if (!selected) {
			return;
		}

		await this._switchToPath(selected.envPath, getClient(), getSession());
	}

	private async _buildEnvList(): Promise<EnvQuickPickItem[]> {
		const items: EnvQuickPickItem[] = [];

		// 1. Workspace Project.toml files
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		for (const folder of workspaceFolders) {
			await this._collectProjectFiles(folder.uri.fsPath, items, 3);
		}

		// 2. ~/.julia/environments/v*
		const homeEnvsDir = path.join(os.homedir(), '.julia', 'environments');
		if (fs.existsSync(homeEnvsDir)) {
			try {
				const entries = fs.readdirSync(homeEnvsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const envPath = path.join(homeEnvsDir, entry.name);
						const projFile = path.join(envPath, 'Project.toml');
						if (fs.existsSync(projFile)) {
							items.push({
								label: `$(home) ${entry.name}`,
								description: envPath,
								envPath,
							});
						}
					}
				}
			} catch {
				// Ignore read errors
			}
		}

		return items;
	}

	private async _collectProjectFiles(
		dir: string,
		items: EnvQuickPickItem[],
		depth: number
	): Promise<void> {
		if (depth <= 0) {
			return;
		}
		try {
			const projFile = path.join(dir, 'Project.toml');
			const juliaProjFile = path.join(dir, 'JuliaProject.toml');
			if (fs.existsSync(projFile) || fs.existsSync(juliaProjFile)) {
				const name = path.basename(dir);
				items.push({
					label: `$(folder) ${name}`,
					description: dir,
					envPath: dir,
				});
				return; // Don't descend into a project directory
			}

			if (depth > 1) {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
						await this._collectProjectFiles(path.join(dir, entry.name), items, depth - 1);
					}
				}
			}
		} catch {
			// Ignore permission errors
		}
	}

	private async _switchToPath(
		envPath: string,
		client: JuliaLanguageClient | undefined,
		session: positron.LanguageRuntimeSession | undefined
	): Promise<void> {
		this._currentEnvPath = envPath;
		this._updateStatusBar();

		// Persist the choice as a workspace setting so the LS picks it up on restart
		await vscode.workspace.getConfiguration('positron.julia')
			.update('languageServer.environmentPath', envPath, vscode.ConfigurationTarget.Workspace);

		// Notify the running LS about the new environment
		if (client?.isRunning()) {
			await client.sendLSNotification('julia/activateenvironment', { envPath }).catch(err => {
				LOGGER.warn(`Failed to send environment notification to LS: ${err}`);
			});
		}

		// Activate the new project in the running Julia kernel
		if (session) {
			const escapedPath = envPath
				.replace(/\\/g, '\\\\')
				.replace(/"/g, '\\"')
				.replace(/\$/g, '\\$');
			session.execute(
				`import Pkg; Pkg.activate("${escapedPath}")`,
				`env-switch-${Date.now()}`,
				positron.RuntimeCodeExecutionMode.Silent,
				positron.RuntimeErrorBehavior.Continue
			);
			LOGGER.info(`Sent Pkg.activate to running kernel for ${envPath}`);
		}

		LOGGER.info(`Julia environment switched to ${envPath}`);
	}

	private _detectDefaultEnvironment(): string | undefined {
		// Use the first workspace folder's nearest project
		const activeDoc = vscode.window.activeTextEditor?.document;
		const searchPath = activeDoc?.languageId === 'julia'
			? activeDoc.uri.fsPath
			: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!searchPath) {
			return undefined;
		}

		let dir = fs.existsSync(searchPath) && fs.statSync(searchPath).isDirectory()
			? searchPath
			: path.dirname(searchPath);

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

	private _updateStatusBar(): void {
		const name = this._currentEnvPath
			? path.basename(this._currentEnvPath)
			: 'julia';
		this._statusBarItem.text = `$(julia) ${name}`;
	}

	dispose(): void {
		this._statusBarItem.dispose();
	}
}
