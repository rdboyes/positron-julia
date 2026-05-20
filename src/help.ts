/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';

import { JuliaLanguageClient } from './lsp';

type LanguageClientGetter = () => JuliaLanguageClient | undefined;

const HELP_TOPIC_SELECTOR: vscode.DocumentSelector = [
	{ language: 'julia', scheme: 'file' },
	{ language: 'julia', scheme: 'untitled' },
	{ language: 'julia', scheme: 'vscode-notebook-cell' },
	{ language: 'julia', scheme: 'inmemory' },
];

class JuliaHelpTopicProvider implements positron.HelpTopicProvider {
	constructor(private readonly _getLanguageClient: LanguageClientGetter) { }

	async provideHelpTopic(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): Promise<string> {
		if (token.isCancellationRequested || document.languageId !== 'julia') {
			return '';
		}

		const client = this._getLanguageClient();
		if (client?.isRunning()) {
			const lspTopic = await client.getHelpTopic(document, position);
			if (typeof lspTopic === 'string' && lspTopic.length > 0) {
				return lspTopic;
			}
		}

		return this._getTopicFromText(document, position) ?? '';
	}

	private _getTopicFromText(
		document: vscode.TextDocument,
		position: vscode.Position
	): string | undefined {
		const lineText = document.lineAt(position.line).text;
		if (!lineText) {
			return undefined;
		}

		const indices = this._candidateIndices(lineText, position.character);
		for (const index of indices) {
			const maybeTopic = this._extractTopicAt(lineText, index);
			if (maybeTopic) {
				return maybeTopic;
			}
		}

		return undefined;
	}

	private _candidateIndices(lineText: string, character: number): number[] {
		if (lineText.length === 0) {
			return [];
		}

		const clamped = Math.max(0, Math.min(character, lineText.length - 1));
		const prev = Math.max(0, clamped - 1);
		return clamped === prev ? [clamped] : [clamped, prev];
	}

	private _extractTopicAt(lineText: string, index: number): string | undefined {
		if (index < 0 || index >= lineText.length) {
			return undefined;
		}

		const isTopicChar = (value: string) => /[A-Za-z0-9_@.!?]/.test(value);
		if (!isTopicChar(lineText[index])) {
			return undefined;
		}

		let start = index;
		while (start > 0 && isTopicChar(lineText[start - 1])) {
			start--;
		}

		let end = index + 1;
		while (end < lineText.length && isTopicChar(lineText[end])) {
			end++;
		}

		let topic = lineText.slice(start, end).trim();
		topic = topic.replace(/^@+/, '').replace(/^\.+|\.+$/g, '');

		if (topic.length === 0 || !/[A-Za-z_]/.test(topic)) {
			return undefined;
		}

		return topic;
	}
}

export function registerHelpTopicProvider(
	getLanguageClient: LanguageClientGetter
): vscode.Disposable {
	return positron.languages.registerHelpTopicProvider(
		HELP_TOPIC_SELECTOR,
		new JuliaHelpTopicProvider(getLanguageClient)
	);
}
