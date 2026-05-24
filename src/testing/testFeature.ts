/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Test Explorer feature for Julia.
//
// Discovery: scans Julia files for @testitem blocks using regex + file watchers,
// following the same pattern as positron-r (no dependency on LS notifications).
// LS notifications (julia/publishTests) are accepted as a supplement/override when
// the installed LanguageServer.jl supports them.
//
// Execution: delegates to TestItemControllers.jl via a JSON-RPC subprocess,
// ported from julia-vscode/src/testing/testFeature.ts.

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import * as rpc from 'vscode-jsonrpc/node';
import * as path from 'path';
import { cpus } from 'os';
import * as fs from 'fs';
import * as vslc from 'vscode-languageclient/node';

import { LOGGER } from '../extension';
import { JuliaRuntimeManager } from '../runtime-manager';
import { juliaRuntimeDiscoverer } from '../provider';
import {
    notificationTypeTestItemStarted,
    notificationTypeTestItemErrored,
    notificationTypeTestItemFailed,
    notificationTypeTestItemPassed,
    notificationTypeTestItemSkipped,
    notificationTypeAppendOutput,
    notificationTypeTestProcessCreated,
    notificationTypeTestProcessOutput,
    notificationTypeTestProcessStatusChanged,
    notificationTypeTestProcessTerminated,
    notificationTypeCancelTestRun,
    requestTypeCreateTestRun,
    requestTypeTerminateTestProcess,
} from './testControllerProtocol';
import * as tlsp from './testLSProtocol';

// Matches: @testitem "label" ...  (double or single quoted labels)
const TESTITEM_RE = /^\s*@testitem\s+"([^"]+)"/;
const TESTITEM_RE_SQ = /^\s*@testitem\s+'([^']+)'/;

function inferJuliaNumThreads(): string {
    const setting = vscode.workspace.getConfiguration('julia').get<number | string | null>('NumThreads', null);
    if (setting !== null && setting !== undefined) { return String(setting); }
    return process.env.JULIA_NUM_THREADS || 'auto';
}

// Per-file test item details (replaces the LS-supplied TestItemDetail for file-based discovery)
interface LocalTestItemDetail {
    id: string;
    label: string;
    line: number;          // 0-based line of the @testitem declaration
    optionDefaultImports: boolean;
    optionSetup: string[];
    optionTags: string[];
}

// ─── JuliaTestProcess ────────────────────────────────────────────────────────

export class JuliaTestProcess {
    private status = 'Created';
    private _onStatusChanged = new vscode.EventEmitter<void>();
    public onStatusChanged = this._onStatusChanged.event;

    constructor(
        public id: string,
        public packageName: string,
        public packageUri: string | undefined,
        public projectUri: string | undefined,
        public coverage: boolean | undefined,
        public env: any,
        private controller: JuliaTestController
    ) { }

    setStatus(s: string) { this.status = s; this._onStatusChanged.fire(); }
    getStatus() { return this.status; }
    kill() { this.controller.killTestProcess(this.id); }
}

// ─── JuliaTestController (subprocess + JSON-RPC) ────────────────────────────

export class JuliaTestController {
    private _onKilled = new vscode.EventEmitter<void>();
    public onKilled = this._onKilled.event;

    private connection: rpc.MessageConnection;
    private process: ChildProcessWithoutNullStreams;
    private testRuns = new Map<string, { testRun: vscode.TestRun, testItems: Map<string, vscode.TestItem> }>();
    private testProcesses = new Map<string, JuliaTestProcess>();

    constructor(
        private testFeature: TestFeature,
        private runtimeManager: JuliaRuntimeManager,
        private context: vscode.ExtensionContext,
        private outputChannel: vscode.OutputChannel
    ) { }

    public ready() { return this.process; }
    kill() { this.process?.kill(); }
    killTestProcess(id: string) { this.connection.sendRequest(requestTypeTerminateTestProcess, { testProcessId: id }); }

    public async start(): Promise<boolean> {
        let binpath: string | undefined = this.runtimeManager.getActiveJuliaSession()?.runtimeMetadata.runtimePath;
        if (!binpath) {
            for await (const inst of juliaRuntimeDiscoverer()) { binpath = inst.binpath; break; }
        }
        if (!binpath) {
            vscode.window.showErrorMessage('No Julia installation found. Cannot run tests.');
            return true;
        }

        this.process = spawn(binpath, [
            '--startup-file=no', '--history-file=no', '--depwarn=no',
            path.join(this.context.extensionPath, 'scripts', 'apps', 'testitemcontroller_main.jl'),
        ], { detached: false });

        this.connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(this.process.stdout),
            new rpc.StreamMessageWriter(this.process.stdin)
        );

        this.connection.onNotification(notificationTypeTestItemStarted, i => {
            const r = this.testRuns.get(i.testRunId);
            const item = r?.testItems.get(i.testItemId);
            if (r && item) { r.testRun.started(item); }
        });
        this.connection.onNotification(notificationTypeTestItemErrored, i => {
            const r = this.testRuns.get(i.testRunId);
            const item = r?.testItems.get(i.testItemId);
            if (!r || !item) { return; }
            r.testRun.errored(item, i.messages.map(m => {
                const msg = new vscode.TestMessage(m.message);
                if (m.uri && m.line && m.column) {
                    msg.location = new vscode.Location(vscode.Uri.parse(m.uri), new vscode.Position(m.line - 1, m.column - 1));
                }
                return msg;
            }), i.duration);
        });
        this.connection.onNotification(notificationTypeTestItemFailed, i => {
            const r = this.testRuns.get(i.testRunId);
            const item = r?.testItems.get(i.testItemId);
            if (!r || !item) { return; }
            r.testRun.failed(item, i.messages.map(m => {
                const msg = new vscode.TestMessage(m.message);
                if (m.actualOutput !== null && m.expectedOutput !== null) {
                    msg.actualOutput = m.actualOutput; msg.expectedOutput = m.expectedOutput;
                }
                if (m.uri && m.line && m.column) {
                    msg.location = new vscode.Location(vscode.Uri.parse(m.uri), new vscode.Position(m.line - 1, m.column - 1));
                }
                return msg;
            }), i.duration);
        });
        this.connection.onNotification(notificationTypeTestItemPassed, i => {
            const r = this.testRuns.get(i.testRunId);
            const item = r?.testItems.get(i.testItemId);
            if (r && item) { r.testRun.passed(item, i.duration); }
        });
        this.connection.onNotification(notificationTypeTestItemSkipped, i => {
            const r = this.testRuns.get(i.testRunId);
            const item = r?.testItems.get(i.testItemId);
            if (r && item) { r.testRun.skipped(item); }
        });
        this.connection.onNotification(notificationTypeAppendOutput, i => {
            const r = this.testRuns.get(i.testRunId);
            if (!r) { return; }
            r.testRun.appendOutput(i.output, undefined, i.testItemId ? r.testItems.get(i.testItemId) : undefined);
        });
        this.connection.onNotification(notificationTypeTestProcessCreated, i => {
            const tp = new JuliaTestProcess(i.id, i.packageName, i.packageUri, i.projectUri, i.coverage, i.env, this);
            this.testProcesses.set(i.id, tp);
        });
        this.connection.onNotification(notificationTypeTestProcessStatusChanged, i => {
            this.testProcesses.get(i.id)?.setStatus(i.status);
        });
        this.connection.onNotification(notificationTypeTestProcessOutput, i => {
            if (!this.testFeature.testProcessOutputChannels.has(i.id)) {
                this.testFeature.testProcessOutputChannels.set(i.id, vscode.window.createOutputChannel(`Julia Test Process ${i.id}`));
            }
            this.testFeature.testProcessOutputChannels.get(i.id)!.append(i.output);
        });
        this.connection.onNotification(notificationTypeTestProcessTerminated, i => {
            this.testProcesses.delete(i.id);
            const ch = this.testFeature.testProcessOutputChannels.get(i.id);
            if (ch) { ch.dispose(); this.testFeature.testProcessOutputChannels.delete(i.id); }
        });

        this.connection.listen();
        this.process.stderr.on('data', d => this.outputChannel.append(String(d)));
        this.process.on('exit', (code) => {
            const hadActiveRuns = this.testRuns.size > 0;
            this.process = undefined;
            if (this.connection) { this.connection.dispose(); this.connection = null; }
            this._onKilled.fire();
            for (const r of this.testRuns.values()) { r.testRun.end(); }
            this.testFeature.testControllerTerminated();
            if (hadActiveRuns) {
                this.outputChannel.show(true);
            }
        });
        this.process.on('error', err => LOGGER.error(`Julia test controller error: ${err.message}`));
        return false;
    }

    public async createTestRun(
        testRun: vscode.TestRun,
        coverageMode: boolean,
        maxProcessCount: number,
        allTests: { testItem: vscode.TestItem, details: LocalTestItemDetail | tlsp.TestItemDetail, testEnv: tlsp.GetTestEnvRequestParamsReturn }[],
        testSetups: { packageUri?: string, name: string, kind: string, uri: string, line: number, column: number, code: string }[]
    ) {
        const juliaCmd = this.runtimeManager.getActiveJuliaSession()?.runtimeMetadata.runtimePath ?? '';
        const testRunId = randomUUID();

        this.testRuns.set(testRunId, {
            testRun,
            testItems: new Map(allTests.map(t => [t.testItem.id, t.testItem])),
        });

        const params = {
            testRunId,
            testProfiles: [{
                id: 'id1', label: 'default',
                juliaCmd, juliaArgs: [] as string[],
                juliaNumThreads: inferJuliaNumThreads(),
                juliaEnv: {} as { [k: string]: string | null },
                maxProcessCount,
                mode: coverageMode ? 'Coverage' : 'Normal',
                coverageRootUris: (!coverageMode || !vscode.workspace.workspaceFolders)
                    ? undefined
                    : vscode.workspace.workspaceFolders.map(f => f.uri.toString()),
            }],
            testItems: allTests.map(t => {
                const d = t.details;
                const line = 'range' in d ? d.range.start.line : (d as LocalTestItemDetail).line;
                const col = 'range' in d ? d.range.start.character : 0;
                const code = 'code' in d ? (d as any).code : '';
                const codeLine = 'codeRange' in d ? (d as any).codeRange.start.line + 1 : line + 2;
                return {
                    id: t.testItem.id,
                    uri: t.testItem.uri!.toString(),
                    label: t.testItem.label,
                    ...t.testEnv,
                    useDefaultUsings: ('optionDefaultImports' in d) ? d.optionDefaultImports : true,
                    testSetups: ('optionSetup' in d) ? d.optionSetup : [],
                    line: line + 1, column: col + 1,
                    code, codeLine, codeColumn: 1,
                };
            }),
            testSetups,
        };

        testRun.token.onCancellationRequested(async () => {
            await this.connection.sendNotification(notificationTypeCancelTestRun, { testRunId });
        });

        const result = await this.connection.sendRequest(requestTypeCreateTestRun, params);

        if (result.coverage && vscode.workspace.workspaceFolders) {
            for (const file of result.coverage) {
                const uri = vscode.Uri.parse(file.uri);
                if (vscode.workspace.workspaceFolders.some(f => file.uri.startsWith(f.uri.toString()))) {
                    const stmts = file.coverage
                        .map((v, i) => v !== null ? new vscode.StatementCoverage(v, new vscode.Position(i, 0)) : null)
                        .filter((v): v is vscode.StatementCoverage => v !== null);
                    testRun.addCoverage(vscode.FileCoverage.fromDetails(uri, stmts));
                }
            }
        }

        testRun.end();
        this.testRuns.delete(testRunId);
    }
}

// ─── TestFeature ─────────────────────────────────────────────────────────────

export class TestFeature implements vscode.Disposable {
    private controller: vscode.TestController;

    // File-based discovery: keyed by uri.toString()
    private fileItems = new Map<string, vscode.TestItem>();
    private localDetails = new WeakMap<vscode.TestItem, LocalTestItemDetail>();

    // LS-based discovery (supplement): keyed by uri.toString()
    private lsDetails = new WeakMap<vscode.TestItem, tlsp.TestItemDetail>();
    private testsetups = new Map<string, tlsp.TestSetupDetail[]>();

    private cpuLength = cpus().length;
    private controllerOutputChannel: vscode.OutputChannel;
    public testProcessOutputChannels = new Map<string, vscode.OutputChannel>();
    private juliaTestController: JuliaTestController | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private runtimeManager: JuliaRuntimeManager,
        private getClient: () => vslc.LanguageClient | undefined
    ) {
        this.controllerOutputChannel = vscode.window.createOutputChannel('Julia Test Item Controller');
        this.controller = vscode.tests.createTestController('juliaTests', 'Julia Tests');

        // resolveHandler: called when the Testing panel opens (item=undefined) or an
        // item is expanded. Mirrors the positron-r pattern — drives initial discovery.
        this.controller.resolveHandler = async (item) => {
            if (!item) {
                await this._discoverAllTests();
            }
        };

        this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run,
            (req, tok) => this._runHandler(req, false, tok), true);

        const covProfile = this.controller.createRunProfile('Run with coverage', vscode.TestRunProfileKind.Coverage,
            (req, tok) => this._runHandler(req, true, tok), false);
        covProfile.loadDetailedCoverage = async (_r, fc) => (fc as any).detailedCoverage ?? [];

        context.subscriptions.push(
            vscode.commands.registerCommand('julia.stopTestProcess', (p: JuliaTestProcess) => p.kill()),
            vscode.commands.registerCommand('julia.stopTestController', () => this.juliaTestController?.kill()),
        );

        // File watcher: re-scan Julia files when they change (same pattern as positron-r)
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.jl');
        watcher.onDidChange(uri => this._scanFile(uri));
        watcher.onDidCreate(uri => this._scanFile(uri));
        watcher.onDidDelete(uri => this._removeFile(uri));
        context.subscriptions.push(watcher);
    }

    // ── File-based discovery ────────────────────────────────────────────────

    private async _discoverAllTests(): Promise<void> {
        LOGGER.info('Julia Test Explorer: scanning workspace for @testitem blocks');
        const files = await vscode.workspace.findFiles('**/*.jl', '{**/node_modules/**,**/.git/**}');
        await Promise.all(files.map(uri => this._scanFile(uri)));
        LOGGER.info(`Julia Test Explorer: discovery complete (${this.fileItems.size} files with tests)`);
    }

    private async _scanFile(uri: vscode.Uri): Promise<void> {
        let text: string;
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            text = doc.getText();
        } catch {
            return;
        }

        const found = this._parseTestItems(text);
        if (found.length === 0) {
            this._removeFile(uri);
            return;
        }

        const uriKey = uri.toString();
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) { return; }

        // Ensure workspace folder node
        let folderItem = this.controller.items.get(workspaceFolder.name);
        if (!folderItem) {
            folderItem = this.controller.createTestItem(workspaceFolder.name, workspaceFolder.name, workspaceFolder.uri);
            this.controller.items.add(folderItem);
        }

        // Ensure file node (relative path as label)
        const relPath = vscode.workspace.asRelativePath(uri.fsPath, false);
        let fileItem = this.fileItems.get(uriKey);
        if (!fileItem) {
            fileItem = this.controller.createTestItem(uriKey, relPath, uri);
            folderItem.children.add(fileItem);
            this.fileItems.set(uriKey, fileItem);
        }

        // Replace children with freshly-parsed test items
        fileItem.children.replace(found.map(f => {
            const id = `${uriKey}::${f.label}`;
            const item = this.controller.createTestItem(id, f.label, uri);
            item.range = new vscode.Range(f.line, 0, f.line, 0);
            this.localDetails.set(item, { id, label: f.label, line: f.line, optionDefaultImports: true, optionSetup: [], optionTags: [] });
            return item;
        }));
    }

    private _parseTestItems(text: string): { label: string, line: number }[] {
        const results: { label: string, line: number }[] = [];
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const dq = TESTITEM_RE.exec(lines[i]);
            if (dq) { results.push({ label: dq[1], line: i }); continue; }
            const sq = TESTITEM_RE_SQ.exec(lines[i]);
            if (sq) { results.push({ label: sq[1], line: i }); }
        }
        return results;
    }

    private _removeFile(uri: vscode.Uri): void {
        const uriKey = uri.toString();
        const fileItem = this.fileItems.get(uriKey);
        if (!fileItem) { return; }
        const parent = fileItem.parent;
        parent?.children.delete(uriKey);
        if (parent && parent.children.size === 0) {
            this.controller.items.delete(parent.id);
        }
        this.fileItems.delete(uriKey);
    }

    // ── LS-based discovery (supplement) ────────────────────────────────────
    // Called when LanguageServer.jl sends julia/publishTests. Overrides file-based
    // discovery for the same file with richer metadata (code ranges, setups, etc.).

    public publishTestsHandler(params: tlsp.PublishTestsParams): void {
        LOGGER.debug(`julia/publishTests: ${params.uri} (${params.testItemDetails.length} items)`);
        const uri = vscode.Uri.parse(params.uri);
        const uriKey = params.uri;
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) { return; }

        if (params.testItemDetails.length === 0 && params.testErrorDetails.length === 0) {
            // LS says no tests → fall back to file-based (don't remove what we found)
            return;
        }

        // Ensure folder + file nodes
        let folderItem = this.controller.items.get(workspaceFolder.name);
        if (!folderItem) {
            folderItem = this.controller.createTestItem(workspaceFolder.name, workspaceFolder.name, workspaceFolder.uri);
            this.controller.items.add(folderItem);
        }

        const relPath = vscode.workspace.asRelativePath(uri.fsPath, false);
        let fileItem = this.fileItems.get(uriKey);
        if (!fileItem) {
            fileItem = this.controller.createTestItem(uriKey, relPath, uri);
            folderItem.children.add(fileItem);
            this.fileItems.set(uriKey, fileItem);
        }

        fileItem.children.replace([
            ...params.testItemDetails.map(d => {
                const item = this.controller.createTestItem(d.id, d.label, uri);
                item.tags = d.optionTags.map(t => new vscode.TestTag(t));
                item.range = new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character);
                this.lsDetails.set(item, d);
                return item;
            }),
            ...params.testErrorDetails.map(d => {
                const item = this.controller.createTestItem(d.id, d.label, uri);
                item.error = d.error;
                item.range = new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character);
                return item;
            }),
        ]);

        this.testsetups.set(uriKey, params.testSetupDetails);
    }

    // ── Test execution ──────────────────────────────────────────────────────

    private _walkTestTree(item: vscode.TestItem, out: vscode.TestItem[]): void {
        if (this.localDetails.has(item) || this.lsDetails.has(item)) {
            out.push(item);
        } else {
            item.children.forEach(c => this._walkTestTree(c, out));
        }
    }

    private _isParentOf(x: vscode.TestItem, y: vscode.TestItem): boolean {
        return y.parent ? (y.parent === x || this._isParentOf(x, y.parent)) : false;
    }

    private async _ensureController(): Promise<boolean> {
        if (!this.juliaTestController?.ready()) {
            this.juliaTestController = new JuliaTestController(this, this.runtimeManager, this.context, this.controllerOutputChannel);
            return await this.juliaTestController.start();
        }
        return false;
    }

    testControllerTerminated(): void {
        this.juliaTestController = undefined;
        for (const ch of this.testProcessOutputChannels.values()) { ch.dispose(); }
        this.testProcessOutputChannels.clear();
    }

    private async _runHandler(request: vscode.TestRunRequest, coverageMode: boolean, token: vscode.CancellationToken): Promise<void> {
        if (await this._ensureController() || token.isCancellationRequested) { return; }

        const testRun = this.controller.createTestRun(request, undefined, true);
        let itemsToRun: vscode.TestItem[] = [];

        if (!request.include) {
            this.controller.items.forEach(i => this._walkTestTree(i, itemsToRun));
        } else {
            request.include.forEach(i => this._walkTestTree(i, itemsToRun));
        }
        if (request.exclude) {
            itemsToRun = itemsToRun.filter(i =>
                !request.exclude!.includes(i) && request.exclude!.every(j => !this._isParentOf(j, i))
            );
        }

        for (const i of itemsToRun) {
            if (i.error) { testRun.errored(i, new vscode.TestMessage(i.error as string)); }
            else { testRun.enqueued(i); }
        }

        // Fetch test environments from LS if available, otherwise use workspace defaults
        const client = this.getClient();
        const uniqueUris = [...new Set(itemsToRun.map(i => i.uri!.toString()))];
        const testEnvPerUri = new Map<string, tlsp.GetTestEnvRequestParamsReturn>();

        for (const uriStr of uniqueUris) {
            if (client?.isRunning()) {
                try {
                    const env = await client.sendRequest(tlsp.requestTypeJuliaGetTestEnv, { uri: uriStr });
                    testEnvPerUri.set(uriStr, env);
                } catch {
                    testEnvPerUri.set(uriStr, this._fallbackTestEnv(uriStr));
                }
            } else {
                testEnvPerUri.set(uriStr, this._fallbackTestEnv(uriStr));
            }
        }

        const allTests = itemsToRun.map(i => ({
            testItem: i,
            details: (this.lsDetails.get(i) ?? this.localDetails.get(i))!,
            testEnv: testEnvPerUri.get(i.uri!.toString())!,
        }));

        // Gather test setups (from LS data; empty for file-based discovery)
        const allSetups: { packageUri?: string, name: string, kind: string, uri: string, line: number, column: number, code: string }[] = [];
        for (const [uri, setups] of this.testsetups) {
            const env = testEnvPerUri.get(uri);
            for (const s of setups) {
                allSetups.push({ packageUri: env?.packageUri, name: s.name, kind: s.kind, uri, line: s.codeRange.start.line + 1, column: s.codeRange.start.character + 1, code: s.code });
            }
        }

        let maxProcessCount = vscode.workspace.getConfiguration('julia').get<number>('numTestProcesses', 0);
        if (maxProcessCount === 0) { maxProcessCount = this.cpuLength; }

        if (token.isCancellationRequested) { testRun.end(); return; }

        try {
            await this.juliaTestController!.createTestRun(testRun, coverageMode, maxProcessCount, allTests, allSetups);
        } catch (err) {
            this.controllerOutputChannel.show(true);
            vscode.window.showErrorMessage(
                `Julia test controller exited unexpectedly. Check the "Julia Test Item Controller" output for details.`
            );
        }
    }

    private _fallbackTestEnv(uriStr: string): tlsp.GetTestEnvRequestParamsReturn {
        // Walk up from the file to find a Project.toml, using that as the project URI
        let dir = path.dirname(vscode.Uri.parse(uriStr).fsPath);
        while (true) {
            if (fs.existsSync(path.join(dir, 'Project.toml')) || fs.existsSync(path.join(dir, 'JuliaProject.toml'))) {
                return { projectUri: vscode.Uri.file(dir).toString() };
            }
            const parent = path.dirname(dir);
            if (parent === dir) { break; }
            dir = parent;
        }
        return {};
    }

    dispose(): void {
        this.controller.dispose();
        this.controllerOutputChannel.dispose();
        this.juliaTestController?.kill();
    }
}
