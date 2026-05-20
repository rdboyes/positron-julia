/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Statement range provider for Julia.
 *
 * Detects multiline statement boundaries so that Ctrl+Enter / Cmd+Enter
 * sends the full statement to the console and advances the cursor.
 *
 * Handles:
 *  - keyword…end blocks (function, if, for, while, begin, let, struct,
 *    mutable struct, module, baremodule, macro, try, quote, do, abstract type)
 *  - Unclosed parentheses / brackets / braces
 *  - Continuation operators at end-of-line (|>, +, -, *, &&, ||, etc.)
 *  - Triple-quoted strings
 *  - Comments and blank lines (skip to next statement)
 */

import * as vscode from 'vscode';
import * as positron from 'positron';

// ── Julia block keywords ────────────────────────────────────────────────
//
// Keywords that open a new block requiring a matching `end`.
// Order matters for the regex: longer alternatives first (e.g. "mutable struct"
// before "struct", "baremodule" before "module").
//
// We use word-boundary checks to avoid false positives (e.g. the word
// "forest" containing "for").

/** Pattern that matches a Julia block-opening keyword at the start of a statement. */
const BLOCK_OPENERS = /\b(?:function|macro|mutable\s+struct|struct|abstract\s+type|primitive\s+type|module|baremodule|if|for|while|let|begin|try|quote|do)\b/;

/** Pattern for `end` at word boundary */
const END_KW = /\bend\b/;

/** Continuation operators at end of line — the statement continues on the next line. */
const CONTINUATION_RE = /(?:\|\>|&&|\|\||\\|,|\+|-|\*|\/|÷|%|\^|&|\||<<|>>|>>>|~|<:|>:|<:|=>|\.\.\.)\s*$/;

/** Line is entirely blank or whitespace */
const BLANK_RE = /^\s*$/;

/** Line is a comment (possibly with leading whitespace) */
const COMMENT_RE = /^\s*#/;

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Strip comments and string literals from a line so that bracket / keyword
 * counting is not confused by them.  We intentionally leave the structure
 * (indentation, keywords outside strings/comments) intact.
 */
function stripStringsAndComments(line: string): string {
    let result = '';
    let i = 0;
    while (i < line.length) {
        // Triple-quoted string — skip entirely, but this won't span lines
        // (caller handles multi-line triple-quotes separately).
        if (line[i] === '"' && line.substring(i, i + 3) === '"""') {
            // Find the closing triple-quote on the same line
            const close = line.indexOf('"""', i + 3);
            if (close >= 0) {
                i = close + 3;
            } else {
                // Triple-quote continues on the next line — return what we have
                return result;
            }
            continue;
        }
        // Regular string
        if (line[i] === '"') {
            i++;
            while (i < line.length && line[i] !== '"') {
                if (line[i] === '\\') { i++; } // skip escaped char
                i++;
            }
            i++; // skip closing quote
            continue;
        }
        // Char literal
        if (line[i] === "'" && i + 2 < line.length) {
            // Julia char literals: 'x', '\n', etc.
            // But ' is also used in transposes — we only skip short patterns.
            if (line[i + 1] === '\\' && i + 3 < line.length && line[i + 3] === "'") {
                i += 4;
                continue;
            }
            if (line[i + 2] === "'") {
                i += 3;
                continue;
            }
        }
        // Line comment — discard the rest of the line
        if (line[i] === '#') {
            return result;
        }
        result += line[i];
        i++;
    }
    return result;
}

/**
 * Count NET bracket depth change for a single (stripped) line.
 * Positive = more openers than closers.
 */
function bracketDelta(stripped: string): number {
    let depth = 0;
    for (const ch of stripped) {
        if (ch === '(' || ch === '[' || ch === '{') { depth++; }
        if (ch === ')' || ch === ']' || ch === '}') { depth--; }
    }
    return depth;
}

/**
 * Count the block-keyword depth change for a stripped line.
 *
 * A simple heuristic: count openers (function, if, for, …) and subtract
 * occurrences of `end`.  This handles one-liners like `if x; y; end`.
 */
function blockDelta(stripped: string): number {
    let delta = 0;
    // Count openers
    const openerRe = /\b(?:function|macro|mutable\s+struct|struct|abstract\s+type|primitive\s+type|module|baremodule|if|for|while|let|begin|try|quote|do)\b/g;
    let m: RegExpExecArray | null;
    while ((m = openerRe.exec(stripped)) !== null) {
        delta++;
    }
    // Count closers
    const endRe = /\bend\b/g;
    while ((m = endRe.exec(stripped)) !== null) {
        delta--;
    }
    return delta;
}

/**
 * Check whether a line is inside a multi-line triple-quoted string.
 * Scans from the top of the document to determine triple-quote parity
 * at the given line.
 */
function isInsideTripleQuote(document: vscode.TextDocument, targetLine: number): boolean {
    let inTriple = false;
    for (let i = 0; i < targetLine; i++) {
        const text = document.lineAt(i).text;
        let j = 0;
        while (j < text.length) {
            if (text[j] === '\\') { j += 2; continue; }
            if (text.substring(j, j + 3) === '"""') {
                inTriple = !inTriple;
                j += 3;
                continue;
            }
            // Skip regular strings when not inside triple-quote
            if (!inTriple && text[j] === '"') {
                j++;
                while (j < text.length && text[j] !== '"') {
                    if (text[j] === '\\') { j++; }
                    j++;
                }
                j++; // closing "
                continue;
            }
            j++;
        }
    }
    return inTriple;
}

/**
 * Find the end of a triple-quoted string starting at `startLine`.
 * Returns the line number of the closing `"""`.
 */
function findTripleQuoteEnd(document: vscode.TextDocument, startLine: number): number {
    for (let i = startLine; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        // For the start line, skip past the opening """ to look for closing
        const searchFrom = (i === startLine) ? text.indexOf('"""') + 3 : 0;
        const closeIdx = text.indexOf('"""', searchFrom);
        if (closeIdx >= 0) {
            return i;
        }
    }
    // Unterminated triple-quote — extend to end of document
    return document.lineCount - 1;
}

// ── Main provider ───────────────────────────────────────────────────────

export class JuliaStatementRangeProvider implements positron.StatementRangeProvider {

    provideStatementRange(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
    ): positron.StatementRange | undefined {

        const lineCount = document.lineCount;

        // ── 1. Skip blank/comment lines to find the start of the next statement ─
        let startLine = position.line;
        while (startLine < lineCount) {
            const text = document.lineAt(startLine).text;
            if (!BLANK_RE.test(text) && !COMMENT_RE.test(text)) {
                break;
            }
            startLine++;
        }
        if (startLine >= lineCount) {
            return undefined; // nothing below cursor
        }

        // ── 2. If we're inside a triple-quoted string, extend to its end ────────
        if (isInsideTripleQuote(document, startLine)) {
            const tripleEnd = findTripleQuoteEnd(document, startLine);
            return this.makeResult(document, startLine, tripleEnd);
        }

        // ── 3. Walk forward to find the end of the current statement ────────────
        let bracketDepth = 0;
        let blockDepth = 0;
        let endLine = startLine;
        let foundFirstCodeLine = false;

        for (let i = startLine; i < lineCount; i++) {
            const rawLine = document.lineAt(i).text;

            // Skip blank/comment lines in the middle of a statement only if
            // we're already inside brackets or blocks
            if (BLANK_RE.test(rawLine) || COMMENT_RE.test(rawLine)) {
                if (bracketDepth > 0 || blockDepth > 0) {
                    endLine = i;
                    continue;
                }
                // Not inside anything — statement ended on the previous code line
                if (foundFirstCodeLine) {
                    break;
                }
                continue;
            }

            const stripped = stripStringsAndComments(rawLine);

            // Check for triple-quoted strings that span lines
            if (this.hasUnmatchedTripleQuote(rawLine)) {
                const tripleEnd = findTripleQuoteEnd(document, i);
                endLine = tripleEnd;
                // After the triple-quote block, update bracket/block depth for
                // the closing line and continue analysis
                i = tripleEnd;
                foundFirstCodeLine = true;
                continue;
            }

            // Update depths
            bracketDepth += bracketDelta(stripped);
            if (bracketDepth < 0) { bracketDepth = 0; } // safety clamp
            blockDepth += blockDelta(stripped);
            if (blockDepth < 0) { blockDepth = 0; } // safety clamp

            endLine = i;
            foundFirstCodeLine = true;

            // Check if statement is complete:
            // - All brackets closed
            // - All blocks closed
            // - Line doesn't end with a continuation operator
            if (bracketDepth === 0 && blockDepth === 0 && !CONTINUATION_RE.test(stripped)) {
                break;
            }
        }

        return this.makeResult(document, startLine, endLine);
    }

    /**
     * Check if a line has an unmatched triple-quote (opening without closing).
     */
    private hasUnmatchedTripleQuote(line: string): boolean {
        let count = 0;
        let i = 0;
        while (i < line.length) {
            if (line[i] === '\\') { i += 2; continue; }
            if (line.substring(i, i + 3) === '"""') {
                count++;
                i += 3;
                continue;
            }
            // Skip regular strings
            if (line[i] === '"') {
                i++;
                while (i < line.length && line[i] !== '"') {
                    if (line[i] === '\\') { i++; }
                    i++;
                }
                i++;
                continue;
            }
            i++;
        }
        return count % 2 !== 0; // odd = unmatched
    }

    /**
     * Build the StatementRange result. For multiline code, appends
     * a trailing newline so the REPL processes it correctly.
     */
    private makeResult(
        document: vscode.TextDocument,
        startLine: number,
        endLine: number,
    ): positron.StatementRange {
        const range = new vscode.Range(
            startLine, 0,
            endLine, document.lineAt(endLine).text.length,
        );

        // For multiline statements, extract the code and add a trailing newline
        if (startLine !== endLine) {
            const code = document.getText(range) + '\n';
            return { range, code };
        }

        return { range };
    }
}

/**
 * Registers the Julia statement range provider.
 */
export function registerStatementRangeProvider(
    context: vscode.ExtensionContext,
): vscode.Disposable {
    const provider = new JuliaStatementRangeProvider();
    const disposable = positron.languages.registerStatementRangeProvider(
        'julia',
        provider,
    );
    context.subscriptions.push(disposable);
    return disposable;
}
