/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

// Copied verbatim from julia-vscode/src/testing/testControllerProtocol.ts

import * as rpc from 'vscode-jsonrpc/node';

// Messages from the extension to the controller

export const requestTypeCreateTestRun = new rpc.RequestType<{
    testRunId: string,
    testProfiles: {
        id: string,
        label: string,
        juliaCmd: string,
        juliaArgs: string[],
        juliaNumThreads?: string,
        juliaEnv: { [key: string]: string | null },
        maxProcessCount: number,
        mode: string,
        coverageRootUris?: string[]
    }[],
    testItems: {
        id: string,
        uri: string,
        label: string,
        packageName?: string,
        packageUri?: string,
        projectUri?: string,
        envContentHash?: string,
        useDefaultUsings: boolean,
        testSetups: string[],
        line: number,
        column: number,
        code: string,
        codeLine: number,
        codeColumn: number,
    }[],
    testSetups: {
        packageUri?: string,
        name: string,
        kind: string,
        uri: string,
        line: number,
        column: number
        code: string
    }[],
}, {
    status: string,
    coverage?: { uri: string, coverage: (number | null)[] }[]
}, void>('createTestRun');

export const notificationTypeCancelTestRun = new rpc.NotificationType<{
    testRunId: string
}>('cancelTestRun');

export const requestTypeTerminateTestProcess = new rpc.RequestType<{ testProcessId: string }, void, void>('terminateTestProcess');

// Messages from the controller to the extension

export const notificationTypeTestItemStarted = new rpc.NotificationType<{ testRunId: string, testItemId: string }>('testItemStarted');

export const notificationTypeTestItemErrored = new rpc.NotificationType<{
    testRunId: string,
    testItemId: string,
    messages: {
        message: string,
        expectedOutput?: string,
        actualOutput?: string,
        uri?: string,
        line?: number,
        column?: number
    }[],
    duration?: number
}>('testItemErrored');

export const notificationTypeTestItemFailed = new rpc.NotificationType<{
    testRunId: string,
    testItemId: string,
    messages: {
        message: string,
        expectedOutput?: string,
        actualOutput?: string,
        uri?: string,
        line?: number,
        column?: number
    }[],
    duration?: number
}>('testItemFailed');

export const notificationTypeTestItemPassed = new rpc.NotificationType<{ testRunId: string, testItemId: string, duration: number }>('testItemPassed');

export const notificationTypeTestItemSkipped = new rpc.NotificationType<{ testRunId: string, testItemId: string }>('testItemSkipped');

export const notificationTypeAppendOutput = new rpc.NotificationType<{ testRunId: string, testItemId?: string, output: string }>('appendOutput');

export const notificationTypeTestProcessCreated = new rpc.NotificationType<{ id: string, packageName: string, packageUri?: string, projectUri?: string, coverage: boolean, env: any }>('testProcessCreated');

export const notificationTypeTestProcessTerminated = new rpc.NotificationType<{ id: string }>('testProcessTerminated');

export const notificationTypeTestProcessStatusChanged = new rpc.NotificationType<{ id: string, status: string }>('testProcessStatusChanged');

export const notificationTypeTestProcessOutput = new rpc.NotificationType<{ id: string, output: string }>('testProcessOutput');
