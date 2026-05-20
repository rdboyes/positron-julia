/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LOGGER } from './extension';

type TokenTypeName =
	| 'struct'
	| 'typeParameter'
	| 'parameter'
	| 'variable'
	| 'property'
	| 'function'
	| 'macro'
	| 'keyword'
	| 'comment'
	| 'string'
	| 'number'
	| 'regexp'
	| 'operator';

type TokenModifierName =
	| 'declaration'
	| 'definition'
	| 'modification'
	| 'documentation'
	| 'defaultLibrary';

interface CandidateToken {
	line: number;
	start: number;
	length: number;
	type: number;
	modifiers: number;
	priority: number;
}

interface ProtectedRange {
	start: number;
	end: number;
	kind: 'comment' | 'string';
}

interface LineScanState {
	blockCommentDepth: number;
	inTripleString: boolean;
}

const TOKEN_TYPES: TokenTypeName[] = [
	'struct',
	'typeParameter',
	'parameter',
	'variable',
	'property',
	'function',
	'macro',
	'keyword',
	'comment',
	'string',
	'number',
	'regexp',
	'operator',
];

const TOKEN_MODIFIERS: TokenModifierName[] = [
	'declaration',
	'definition',
	'modification',
	'documentation',
	'defaultLibrary',
];

const TOKEN_TYPE_INDEX = new Map<TokenTypeName, number>(
	TOKEN_TYPES.map((tokenType, index) => [tokenType, index])
);

const TOKEN_MODIFIER_MASK = new Map<TokenModifierName, number>(
	TOKEN_MODIFIERS.map((modifier, index) => [modifier, 1 << index])
);

const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

const JULIA_KEYWORDS = [
	'abstract',
	'baremodule',
	'begin',
	'break',
	'catch',
	'const',
	'continue',
	'do',
	'else',
	'elseif',
	'end',
	'export',
	'false',
	'finally',
	'for',
	'function',
	'global',
	'if',
	'import',
	'let',
	'local',
	'macro',
	'module',
	'mutable',
	'nothing',
	'primitive',
	'quote',
	'return',
	'struct',
	'true',
	'try',
	'type',
	'using',
	'where',
	'while',
] as const;

const KEYWORD_SET = new Set<string>(JULIA_KEYWORDS);
const KEYWORD_REGEX = new RegExp(`\\b(?:${JULIA_KEYWORDS.join('|')})\\b`, 'g');
const NUMBER_REGEX = /(?<![\w.])(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])/g;
const MACRO_REGEX = /@([A-Za-z_][A-Za-z0-9_]*)\b/g;
const PROPERTY_REGEX = /\.(\s*)([A-Za-z_][A-Za-z0-9_]*)\b/g;
const OPERATOR_REGEX = /(?:==|!=|<=|>=|=>|::|&&|\|\||[+\-*/%^=<>!&|?:])/g;
const STRUCT_DECL_REGEX = /\b(?:mutable\s+struct|struct|abstract\s+type|primitive\s+type)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
const FUNCTION_DECL_REGEX = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;
const SHORT_FUNCTION_REGEX = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(([^)]*)\)\s*(?:::[^=]+)?\s*=(?!=)/;
const LOCAL_DECL_REGEX = /\b(?:local|global|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
const ASSIGNMENT_DECL_REGEX = /(^|[,(;\s])([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g;
const TYPE_PARAMETER_REGEX = /\b([A-Z][A-Za-z0-9_]*)\b/g;

class TokenCollector {
	private readonly _tokensByLine = new Map<number, CandidateToken[]>();

	add(
		line: number,
		start: number,
		length: number,
		tokenType: TokenTypeName,
		modifiers: TokenModifierName[] = [],
		priority: number = 10
	): void {
		if (length <= 0 || start < 0 || line < 0) {
			return;
		}

		const type = TOKEN_TYPE_INDEX.get(tokenType);
		if (type === undefined) {
			return;
		}

		let modifierMask = 0;
		for (const modifier of modifiers) {
			modifierMask |= TOKEN_MODIFIER_MASK.get(modifier) ?? 0;
		}

		const candidate: CandidateToken = {
			line,
			start,
			length,
			type,
			modifiers: modifierMask,
			priority,
		};

		const existing = this._tokensByLine.get(line);
		if (existing) {
			existing.push(candidate);
		} else {
			this._tokensByLine.set(line, [candidate]);
		}
	}

	pushResolvedTo(builder: vscode.SemanticTokensBuilder): void {
		const lines = Array.from(this._tokensByLine.keys()).sort((a, b) => a - b);
		for (const line of lines) {
			const candidates = this._tokensByLine.get(line);
			if (!candidates || candidates.length === 0) {
				continue;
			}

			// Prefer higher-confidence classes (comments/strings/declarations) when
			// multiple token rules overlap, then emit in lexical order for LSP encoding.
			const selected: CandidateToken[] = [];
			const byPriority = [...candidates].sort((left, right) =>
				right.priority - left.priority || right.length - left.length || left.start - right.start
			);

			for (const token of byPriority) {
				const overlaps = selected.some((existing) =>
					token.start < existing.start + existing.length &&
					existing.start < token.start + token.length
				);
				if (!overlaps) {
					selected.push(token);
				}
			}

			selected.sort((left, right) => left.start - right.start || left.length - right.length);
			for (const token of selected) {
				builder.push(token.line, token.start, token.length, token.type, token.modifiers);
			}
		}
	}
}

export class JuliaSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider, vscode.Disposable {
	private readonly _onDidChangeSemanticTokens = new vscode.EventEmitter<void>();
	readonly onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

	refresh(): void {
		this._onDidChangeSemanticTokens.fire();
	}

	provideDocumentSemanticTokens(
		document: vscode.TextDocument,
		cancellationToken: vscode.CancellationToken
	): vscode.ProviderResult<vscode.SemanticTokens> {
		const config = vscode.workspace.getConfiguration('positron.julia');
		const enabled = config.get<boolean>('semanticHighlighting.enabled', true);
		const stringSemanticEnabled = config.get<boolean>('semanticHighlighting.string.enabled', false);
		if (!enabled) {
			return new vscode.SemanticTokens(new Uint32Array());
		}

		const builder = new vscode.SemanticTokensBuilder(LEGEND);
		const collector = new TokenCollector();
		const scanState: LineScanState = {
			blockCommentDepth: 0,
			inTripleString: false,
		};

		for (let line = 0; line < document.lineCount; line++) {
			if (cancellationToken.isCancellationRequested) {
				break;
			}

			const text = document.lineAt(line).text;
			const protectedRanges = computeProtectedRanges(text, scanState);
			for (const range of protectedRanges) {
				if (range.kind === 'comment') {
					collector.add(line, range.start, range.end - range.start, 'comment', [], 100);
				} else if (stringSemanticEnabled) {
					collector.add(line, range.start, range.end - range.start, 'string', [], 100);
				}
			}

			collectCodeTokens(line, text, protectedRanges, collector);
		}

		collector.pushResolvedTo(builder);
		return builder.build();
	}

	dispose(): void {
		this._onDidChangeSemanticTokens.dispose();
	}
}

function collectCodeTokens(
	line: number,
	text: string,
	protectedRanges: ProtectedRange[],
	collector: TokenCollector
): void {
	const isAvailable = (start: number, length: number) =>
		isRangeUnprotected(start, length, protectedRanges);

	for (const match of text.matchAll(MACRO_REGEX)) {
		const start = match.index ?? -1;
		if (start >= 0 && isAvailable(start, match[0].length)) {
			collector.add(line, start, match[0].length, 'macro', [], 45);
		}
	}

	for (const match of text.matchAll(STRUCT_DECL_REGEX)) {
		const name = match[1];
		if (!name) {
			continue;
		}
		const start = (match.index ?? -1) + match[0].lastIndexOf(name);
		if (start >= 0 && isAvailable(start, name.length)) {
			collector.add(line, start, name.length, 'struct', ['declaration', 'definition'], 60);
		}
		collectTypeParameters(line, text, match.index ?? 0, protectedRanges, collector);
	}

	for (const match of text.matchAll(FUNCTION_DECL_REGEX)) {
		const name = match[1];
		if (!name) {
			continue;
		}
		const start = (match.index ?? -1) + match[0].lastIndexOf(name);
		if (start >= 0 && isAvailable(start, name.length)) {
			collector.add(line, start, name.length, 'function', ['declaration', 'definition'], 60);
		}
		collectTypeParameters(line, text, match.index ?? 0, protectedRanges, collector);

		const openParenIndex = text.indexOf('(', (match.index ?? 0) + match[0].length);
		if (openParenIndex !== -1) {
			const closeParenIndex = findMatchingParen(text, openParenIndex);
			if (closeParenIndex !== -1) {
				collectParameters(line, text, openParenIndex + 1, closeParenIndex, protectedRanges, collector);
			}
		}
	}

	const shortFunctionMatch = SHORT_FUNCTION_REGEX.exec(text);
	if (shortFunctionMatch && shortFunctionMatch[1]) {
		const fullName = shortFunctionMatch[1];
		const start = (shortFunctionMatch.index ?? 0) + shortFunctionMatch[0].indexOf(fullName);
		if (isAvailable(start, fullName.length)) {
			collector.add(line, start, fullName.length, 'function', ['declaration', 'definition'], 60);
		}

		const openParenIndex = text.indexOf('(', start + fullName.length);
		if (openParenIndex !== -1) {
			const closeParenIndex = findMatchingParen(text, openParenIndex);
			if (closeParenIndex !== -1) {
				collectParameters(line, text, openParenIndex + 1, closeParenIndex, protectedRanges, collector);
			}
		}
		collectTypeParameters(line, text, start, protectedRanges, collector);
	}

	for (const match of text.matchAll(LOCAL_DECL_REGEX)) {
		const name = match[1];
		if (!name) {
			continue;
		}
		const start = (match.index ?? -1) + match[0].lastIndexOf(name);
		if (start >= 0 && isAvailable(start, name.length)) {
			collector.add(line, start, name.length, 'variable', ['declaration'], 50);
		}
	}

	for (const match of text.matchAll(ASSIGNMENT_DECL_REGEX)) {
		const name = match[2];
		if (!name || KEYWORD_SET.has(name)) {
			continue;
		}
		const start = (match.index ?? -1) + match[0].lastIndexOf(name);
		if (start >= 0 && isAvailable(start, name.length)) {
			collector.add(line, start, name.length, 'variable', ['declaration'], 40);
		}
	}

	for (const match of text.matchAll(PROPERTY_REGEX)) {
		const propertyName = match[2];
		if (!propertyName) {
			continue;
		}
		const start = (match.index ?? -1) + match[0].lastIndexOf(propertyName);
		if (start >= 0 && isAvailable(start, propertyName.length)) {
			collector.add(line, start, propertyName.length, 'property', [], 35);
		}
	}

	for (const match of text.matchAll(KEYWORD_REGEX)) {
		const start = match.index ?? -1;
		if (start >= 0 && isAvailable(start, match[0].length)) {
			collector.add(line, start, match[0].length, 'keyword', [], 30);
		}
	}

	for (const match of text.matchAll(NUMBER_REGEX)) {
		const start = match.index ?? -1;
		if (start >= 0 && isAvailable(start, match[0].length)) {
			collector.add(line, start, match[0].length, 'number', [], 28);
		}
	}

	for (const match of text.matchAll(OPERATOR_REGEX)) {
		const start = match.index ?? -1;
		if (start >= 0 && isAvailable(start, match[0].length)) {
			collector.add(line, start, match[0].length, 'operator', [], 10);
		}
	}
}

function collectTypeParameters(
	line: number,
	text: string,
	searchFrom: number,
	protectedRanges: ProtectedRange[],
	collector: TokenCollector
): void {
	const braceStart = text.indexOf('{', searchFrom);
	if (braceStart === -1 || !isRangeUnprotected(braceStart, 1, protectedRanges)) {
		return;
	}

	const braceEnd = text.indexOf('}', braceStart + 1);
	if (braceEnd === -1) {
		return;
	}

	const inner = text.slice(braceStart + 1, braceEnd);
	for (const match of inner.matchAll(TYPE_PARAMETER_REGEX)) {
		const start = braceStart + 1 + (match.index ?? 0);
		if (isRangeUnprotected(start, match[0].length, protectedRanges)) {
			collector.add(line, start, match[0].length, 'typeParameter', ['declaration'], 52);
		}
	}
}

function collectParameters(
	line: number,
	text: string,
	startInclusive: number,
	endExclusive: number,
	protectedRanges: ProtectedRange[],
	collector: TokenCollector
): void {
	if (endExclusive <= startInclusive) {
		return;
	}

	const paramsText = text.slice(startInclusive, endExclusive);
	const parameterRegex = /(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
	for (const match of paramsText.matchAll(parameterRegex)) {
		const name = match[1];
		if (!name || KEYWORD_SET.has(name)) {
			continue;
		}
		const absoluteStart = startInclusive + (match.index ?? 0) + match[0].lastIndexOf(name);
		if (isRangeUnprotected(absoluteStart, name.length, protectedRanges)) {
			collector.add(line, absoluteStart, name.length, 'parameter', ['declaration'], 55);
		}
	}
}

function computeProtectedRanges(text: string, state: LineScanState): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		if (state.blockCommentDepth > 0) {
			const start = cursor;
			cursor = consumeBlockComment(text, cursor, state);
			ranges.push({ start, end: cursor, kind: 'comment' });
			continue;
		}

		if (state.inTripleString) {
			const start = cursor;
			const end = text.indexOf('"""', cursor);
			if (end === -1) {
				ranges.push({ start, end: text.length, kind: 'string' });
				cursor = text.length;
			} else {
				ranges.push({ start, end: end + 3, kind: 'string' });
				cursor = end + 3;
				state.inTripleString = false;
			}
			continue;
		}

		if (text.startsWith('#=', cursor)) {
			const start = cursor;
			state.blockCommentDepth = 1;
			cursor = consumeBlockComment(text, cursor + 2, state);
			ranges.push({ start, end: cursor, kind: 'comment' });
			continue;
		}

		if (text.startsWith('"""', cursor)) {
			const start = cursor;
			const end = text.indexOf('"""', cursor + 3);
			if (end === -1) {
				ranges.push({ start, end: text.length, kind: 'string' });
				cursor = text.length;
				state.inTripleString = true;
			} else {
				ranges.push({ start, end: end + 3, kind: 'string' });
				cursor = end + 3;
			}
			continue;
		}

		if (text[cursor] === '#') {
			ranges.push({ start: cursor, end: text.length, kind: 'comment' });
			break;
		}

		if (text[cursor] === '"') {
			const start = cursor;
			cursor = consumeString(text, cursor + 1);
			ranges.push({ start, end: cursor, kind: 'string' });
			continue;
		}

		cursor += 1;
	}

	return ranges;
}

function consumeBlockComment(text: string, start: number, state: LineScanState): number {
	let cursor = start;
	while (cursor < text.length && state.blockCommentDepth > 0) {
		if (text.startsWith('#=', cursor)) {
			state.blockCommentDepth += 1;
			cursor += 2;
			continue;
		}
		if (text.startsWith('=#', cursor)) {
			state.blockCommentDepth -= 1;
			cursor += 2;
			continue;
		}
		cursor += 1;
	}
	return cursor;
}

function consumeString(text: string, start: number): number {
	let cursor = start;
	while (cursor < text.length) {
		if (text[cursor] === '\\') {
			cursor += 2;
			continue;
		}
		if (text[cursor] === '"') {
			cursor += 1;
			break;
		}
		cursor += 1;
	}
	return Math.min(cursor, text.length);
}

function findMatchingParen(text: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		const char = text[i];
		if (char === '(') {
			depth += 1;
		} else if (char === ')') {
			depth -= 1;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

function isRangeUnprotected(start: number, length: number, protectedRanges: ProtectedRange[]): boolean {
	const end = start + length;
	return !protectedRanges.some((range) =>
		start < range.end && range.start < end
	);
}

export function registerSemanticTokensProvider(context: vscode.ExtensionContext): vscode.Disposable {
	const provider = new JuliaSemanticTokensProvider();
	const documentSelector: vscode.DocumentSelector = [
		{ language: 'julia', scheme: 'file' },
		{ language: 'julia', scheme: 'untitled' },
		{ language: 'julia', scheme: 'vscode-notebook-cell' },
		{ language: 'julia', scheme: 'inmemory' },
	];

	const disposable = vscode.languages.registerDocumentSemanticTokensProvider(
		documentSelector,
		provider,
		LEGEND
	);
	const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
		if (
			event.affectsConfiguration('positron.julia.semanticHighlighting.enabled') ||
			event.affectsConfiguration('positron.julia.semanticHighlighting.string.enabled')
		) {
			provider.refresh();
		}
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(configChangeDisposable);
	context.subscriptions.push(provider);
	LOGGER.info('Julia semantic tokens provider registered');
	return disposable;
}
