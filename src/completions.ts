/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime completion provider for Julia.
 *
 * Uses the Jupyter `complete_request` message via `callMethod` on the active
 * Julia session.  This is fully silent (no console output, no history entry)
 * and is the standard Jupyter protocol mechanism for completions.
 */

import * as vscode from 'vscode';
import * as positron from 'positron';
import { LOGGER } from './extension';

/**
 * Provides runtime completions for Julia by querying the active Julia session.
 * This supplements the LSP completions with variables and functions defined in the current session.
 */
export class JuliaRuntimeCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		_context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[] | undefined> {

		if (document.languageId !== 'julia') {
			return undefined;
		}

		// Find an active Julia session that supports callMethod
		const sessions = await positron.runtime.getActiveSessions();
		const juliaSession = sessions.find(
			s => s.runtimeMetadata.languageId === 'julia' && typeof s.callMethod === 'function'
		);
		if (!juliaSession) {
			return undefined;
		}

		// Build the code string up to cursor position
		const lineText = document.lineAt(position.line).text;
		const textBeforeCursor = lineText.substring(0, position.character);

		if (!textBeforeCursor.trim()) {
			return undefined;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			// Use Jupyter complete_request via callMethod — fully silent,
			// does not pollute console or history.
			const reply = await juliaSession.callMethod!(
				'complete_request',
				textBeforeCursor,
				position.character
			);

			if (token.isCancellationRequested) {
				return undefined;
			}

			// Jupyter complete_reply format:
			//   { matches: string[], cursor_start: number, cursor_end: number,
			//     metadata: object, status: 'ok' | 'error' }
			const matches: string[] = reply?.matches ?? [];
			if (matches.length === 0) {
				return undefined;
			}

			// Determine the replacement range from cursor_start/cursor_end
			const cursorStart: number = reply?.cursor_start ?? 0;
			const cursorEnd: number = reply?.cursor_end ?? position.character;
			const replaceRange = new vscode.Range(
				position.line, cursorStart,
				position.line, cursorEnd
			);

			return matches.map(text => {
				const item = new vscode.CompletionItem(text, vscode.CompletionItemKind.Variable);
				item.range = replaceRange;
				item.sortText = ` ${text}`; // Space prefix sorts before LSP items
				item.detail = '(runtime)';
				return item;
			});
		} catch (err) {
			LOGGER.debug(`Runtime completion error: ${err}`);
			return undefined;
		}
	}

	dispose(): void {
		// nothing to clean up
	}
}

/**
 * Registers the Julia runtime completion provider.
 */
export function registerCompletionProvider(context: vscode.ExtensionContext): vscode.Disposable {
	const provider = new JuliaRuntimeCompletionProvider();

	const disposable = vscode.languages.registerCompletionItemProvider(
		[
			{ language: 'julia', scheme: 'file' },
			{ language: 'julia', scheme: 'untitled' },
			{ language: 'julia', scheme: 'inmemory' },
		],
		provider,
		'.', // trigger on dot for field/module member completion
	);

	context.subscriptions.push(disposable);
	context.subscriptions.push(provider);

	LOGGER.info('Julia runtime completion provider registered');

	return disposable;
}

export interface ReplCompletionResult {
	matches: string[];
	cursor_start: number;
	cursor_end: number;
}

/**
 * Queries the active Julia runtime session silently for completions.
 * Used to bridge Language Server completions with the REPL session.
 * Returns null when no session is available or the query is empty.
 */
export async function getRuntimeCompletions(query: string): Promise<ReplCompletionResult | null> {
	if (!query) {
		return null;
	}

	try {
		// Find an active Julia session that supports callMethod
		const sessions = await positron.runtime.getActiveSessions();
		const juliaSession = sessions.find(
			s => s.runtimeMetadata.languageId === 'julia' && typeof s.callMethod === 'function'
		);
		if (!juliaSession) {
			return null;
		}

		// Use Jupyter complete_request via callMethod — fully silent,
		// does not pollute console or history.
		// query is the text up to the cursor, so query.length is the cursor
		// offset within that text — equivalent to position.character in the
		// VSCode provider and correct for the Jupyter complete_request protocol.
		const reply = await juliaSession.callMethod!(
			'complete_request',
			query,
			query.length
		);

		const matches: string[] = Array.isArray(reply?.matches) ? reply.matches : [];
		const cursor_start: number = reply?.cursor_start ?? 0;
		const cursor_end: number = reply?.cursor_end ?? query.length;

		return { matches, cursor_start, cursor_end };
	} catch (err) {
		LOGGER.debug(`Runtime completion error in getRuntimeCompletions: ${err}`);
		return null;
	}
}

