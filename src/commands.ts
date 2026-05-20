/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import * as positron from "positron";

import { JuliaRuntimeManager } from "./runtime-manager";
import { LOGGER, getLanguageClient, restartLanguageServer } from "./extension";

const JULIA_LANGUAGE_ID = "julia";
const JULIA_RUN_FILE_COMMAND = "julia.runFile";
const JULIA_RUN_SELECTION_COMMAND = "julia.runSelection";

function isJuliaDocument(document: vscode.TextDocument): boolean {
  return document.languageId === JULIA_LANGUAGE_ID;
}

function escapeForJuliaString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$");
}

async function executeJuliaCode(code: string): Promise<void> {
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
}

async function runActiveFile(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (!isJuliaDocument(document)) {
    vscode.window.showWarningMessage("Active file is not a Julia file");
    return;
  }

  if (document.isUntitled) {
    const code = document.getText();
    if (!code.trim()) {
      vscode.window.showWarningMessage("No code to run in the active file");
      return;
    }
    await executeJuliaCode(code);
    return;
  }

  await document.save();
  const escapedPath = escapeForJuliaString(document.uri.fsPath);
  await executeJuliaCode(`include("${escapedPath}")`);
}

async function runSelection(editor: vscode.TextEditor): Promise<void> {
  const document = editor.document;
  if (!isJuliaDocument(document)) {
    vscode.window.showWarningMessage("Active file is not a Julia file");
    return;
  }

  const code = editor.selection.isEmpty
    ? document.lineAt(editor.selection.active.line).text
    : document.getText(editor.selection);

  if (!code.trim()) {
    vscode.window.showWarningMessage("No code selected to run");
    return;
  }

  await executeJuliaCode(code);
}

/**
 * Registers Julia-specific commands.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  runtimeManager: JuliaRuntimeManager,
): void {
  const runFileCommand = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor");
      return;
    }

    try {
      await runActiveFile(editor);
    } catch (error) {
      LOGGER.error(`Failed to run Julia file: ${error}`);
      vscode.window.showErrorMessage("Failed to run Julia file");
    }
  };

  const runSelectionCommand = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor");
      return;
    }

    try {
      await runSelection(editor);
    } catch (error) {
      LOGGER.error(`Failed to run Julia selection: ${error}`);
      vscode.window.showErrorMessage("Failed to run Julia selection");
    }
  };

  // Create new Julia file
  context.subscriptions.push(
    vscode.commands.registerCommand("julia.createNewFile", async () => {
      const document = await vscode.workspace.openTextDocument({
        language: "julia",
        content: "",
      });
      await vscode.window.showTextDocument(document);
    }),
  );

  // Select Julia interpreter
  context.subscriptions.push(
    vscode.commands.registerCommand("julia.selectInterpreter", async () => {
      // TODO: Implement interpreter selection UI
      LOGGER.info("Julia interpreter selection not yet implemented");
      vscode.window.showInformationMessage(
        "Julia interpreter selection will be available in a future release.",
      );
    }),
  );

  // Run current file
  context.subscriptions.push(
    vscode.commands.registerCommand(JULIA_RUN_FILE_COMMAND, runFileCommand),
  );

  // Run selection (or current line if no selection)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      JULIA_RUN_SELECTION_COMMAND,
      runSelectionCommand,
    ),
  );

  // Restart the Julia Language Server
  context.subscriptions.push(
    vscode.commands.registerCommand("julia.restartLanguageServer", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "Restarting Julia Language Server..." },
        () => restartLanguageServer()
      );
    }),
  );

  // Re-index the Julia Language Server cache
  context.subscriptions.push(
    vscode.commands.registerCommand("julia.refreshLanguageServer", async () => {
      const client = getLanguageClient();
      if (!client?.isRunning()) {
        vscode.window.showWarningMessage("Julia Language Server is not running");
        return;
      }
      await client.sendLSNotification("julia/refreshLanguageServer");
    }),
  );

  // Interrupt a running Julia computation
  context.subscriptions.push(
    vscode.commands.registerCommand("julia.interrupt", async () => {
      const session = runtimeManager.getActiveJuliaSession();
      if (!session) {
        vscode.window.showWarningMessage("No active Julia session");
        return;
      }
      await session.interrupt();
    }),
  );
}
