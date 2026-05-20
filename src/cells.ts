/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as positron from 'positron';

const JULIA_LANGUAGE_ID = 'julia';

const DEFAULT_CELL_DELIMITERS = [
	/^\s?#\s#+/,    // # ## or  # Section
	/^##(?!#)/,     // ## (but not ###)
	/^#(\s?)%%/,    // # %% or #%%
	/^#-/,          // #-
];

function getCellDelimiters(): RegExp[] {
	const configured = vscode.workspace.getConfiguration('julia')
		.get<string[]>('cellDelimiters', []);
	if (configured.length > 0) {
		return configured.map(s => new RegExp(s));
	}
	return DEFAULT_CELL_DELIMITERS;
}

function isCellBorder(line: string, delimiters: RegExp[]): boolean {
	return delimiters.some(r => r.test(line));
}

function currentCellRange(editor: vscode.TextEditor): vscode.Range | null {
	const doc = editor.document;
	const delimiters = getCellDelimiters();
	const currLine = editor.selection.active.line;

	// If cursor is on a delimiter line, treat it as start-of-next-cell
	// by scanning from the line below it
	let startLine = currLine;
	if (isCellBorder(doc.lineAt(currLine).text, delimiters) && currLine + 1 < doc.lineCount) {
		startLine = currLine + 1;
	}

	// Scan backward to find the start of this cell
	while (startLine > 0 && !isCellBorder(doc.lineAt(startLine - 1).text, delimiters)) {
		startLine--;
	}

	// Scan forward to find the end of this cell (stop before next delimiter)
	let endLine = startLine;
	while (endLine + 1 < doc.lineCount && !isCellBorder(doc.lineAt(endLine + 1).text, delimiters)) {
		endLine++;
	}

	const startPos = new vscode.Position(startLine, 0);
	const endPos = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
	return new vscode.Range(startPos, endPos);
}

async function executeCell(shouldMove: boolean): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== JULIA_LANGUAGE_ID) {
		return;
	}

	const range = currentCellRange(editor);
	if (!range) {
		return;
	}

	const code = editor.document.getText(range).trim();
	if (!code) {
		return;
	}

	await positron.runtime.executeCode(
		JULIA_LANGUAGE_ID,
		code,
		false,
		false,
		positron.RuntimeCodeExecutionMode.Interactive,
		positron.RuntimeErrorBehavior.Continue,
		undefined,
		undefined,
	);

	if (shouldMove) {
		// Advance cursor past the next cell delimiter
		const delimiters = getCellDelimiters();
		const doc = editor.document;
		let nextLine = range.end.line + 1;

		// Skip over delimiter lines
		while (nextLine < doc.lineCount && isCellBorder(doc.lineAt(nextLine).text, delimiters)) {
			nextLine++;
		}

		if (nextLine < doc.lineCount) {
			const newPos = new vscode.Position(nextLine, 0);
			editor.selection = new vscode.Selection(newPos, newPos);
			editor.revealRange(new vscode.Range(newPos, newPos));
		}
	}
}

export function registerCellCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('julia.executeCell', () => executeCell(false)),
		vscode.commands.registerCommand('julia.executeCellAndMove', () => executeCell(true)),
	);
}
