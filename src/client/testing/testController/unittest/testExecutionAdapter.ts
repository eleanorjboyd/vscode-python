// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import { TestRun, Uri } from 'vscode';
import * as net from 'net';
import { IConfigurationService, ITestOutputChannel } from '../../../common/types';
import { createDeferred, Deferred } from '../../../common/utils/async';
import { EXTENSION_ROOT_DIR } from '../../../constants';
import {
    DataReceivedEvent,
    ExecutionTestPayload,
    ITestExecutionAdapter,
    ITestResultResolver,
    ITestServer,
    TestCommandOptions,
    TestExecutionCommand,
} from '../common/types';
import { traceLog, traceError } from '../../../logging';
import { startTestIdServer } from '../common/utils';

/**
 * Wrapper Class for unittest test execution. This is where we call `runTestCommand`?
 */

export class UnittestTestExecutionAdapter implements ITestExecutionAdapter {
    private promiseMap: Map<string, Deferred<ExecutionTestPayload | undefined>> = new Map();

    private cwd: string | undefined;

    constructor(
        public testServer: ITestServer,
        public configSettings: IConfigurationService,
        private readonly outputChannel: ITestOutputChannel,
        private readonly resultResolver?: ITestResultResolver,
    ) {}

    public async runTests(
        uri: Uri,
        testIds: string[],
        debugBool?: boolean,
        runInstance?: TestRun,
    ): Promise<ExecutionTestPayload> {
        const disposable = this.testServer.onRunDataReceived((e: DataReceivedEvent) => {
            if (runInstance) {
                this.resultResolver?.resolveExecution(JSON.parse(e.data), runInstance);
            }
        });
        try {
            await this.runTestsNew(uri, testIds, debugBool);
        } finally {
            disposable.dispose();
            // confirm with testing that this gets called (it must clean this up)
        }
        const executionPayload: ExecutionTestPayload = { cwd: uri.fsPath, status: 'success', error: '' };
        return executionPayload;
    }

    private async runTestsNew(uri: Uri, testIds: string[], debugBool?: boolean): Promise<ExecutionTestPayload> {
        const settings = this.configSettings.getSettings(uri);
        const { unittestArgs } = settings.testing;

        const command = buildExecutionCommand(unittestArgs);
        this.cwd = uri.fsPath;
        const uuid = this.testServer.createUUID(uri.fsPath);

        const options: TestCommandOptions = {
            workspaceFolder: uri,
            command,
            cwd: this.cwd,
            uuid,
            debugBool,
            testIds,
            outChannel: this.outputChannel,
        };

        const deferred = createDeferred<ExecutionTestPayload>();
        this.promiseMap.set(uuid, deferred);

        traceLog(`Running UNITTEST execution for the following test ids: ${testIds}`);

        let runTestIdsPort: string | undefined;
        await startTestIdServer(testIds)
            .then((assignedPort) => {
                traceLog(`Server started and listening on port ${assignedPort}`);
                runTestIdsPort = assignedPort.toString();
                // Send test command to server.
                // Server fire onDataReceived event once it gets response.
            })
            .catch((error) => {
                traceError('Error starting server:', error);
            });

        await this.testServer.sendCommand(options, runTestIdsPort, () => {
            // disposable.dispose();
            deferred.resolve();
        });
        // return deferred.promise;
        const executionPayload: ExecutionTestPayload = { cwd: uri.fsPath, status: 'success', error: '' };
        return executionPayload;
    }
}

function buildExecutionCommand(args: string[]): TestExecutionCommand {
    const executionScript = path.join(EXTENSION_ROOT_DIR, 'pythonFiles', 'unittestadapter', 'execution.py');

    return {
        script: executionScript,
        args: ['--udiscovery', ...args],
    };
}
