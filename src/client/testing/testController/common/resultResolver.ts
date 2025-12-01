// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { CancellationToken, TestController, TestItem, Uri, TestRun, FileCoverageDetail } from 'vscode';
import { CoveragePayload, DiscoveredTestPayload, ExecutionTestPayload, ITestResultResolver } from './types';
import { TestProvider } from '../../types';
import { traceVerbose } from '../../../logging';
import { TestItemIndex } from './testItemIndex';
import { TestDiscoveryHandler } from './testDiscoveryHandler';
import { TestExecutionHandler } from './testExecutionHandler';
import { TestCoverageHandler } from './testCoverageHandler';

export class PythonResultResolver implements ITestResultResolver {
    testController: TestController;

    testProvider: TestProvider;

    // Per-workspace state managed by TestItemIndex
    private testItemIndex: TestItemIndex;

    public subTestStats: Map<string, { passed: number; failed: number }> = new Map();

    public detailedCoverageMap = new Map<string, FileCoverageDetail[]>();

    // Shared singleton handlers for processing
    private static discoveryHandler: TestDiscoveryHandler = new TestDiscoveryHandler();

    private static executionHandler: TestExecutionHandler = new TestExecutionHandler();

    private static coverageHandler: TestCoverageHandler = new TestCoverageHandler();

    // Expose maps for backward compatibility (WorkspaceTestAdapter and utils.ts access these)
    public get runIdToTestItem(): Map<string, TestItem> {
        return this.testItemIndex.runIdToTestItem;
    }

    public get runIdToVSid(): Map<string, string> {
        return this.testItemIndex.runIdToVSid;
    }

    public get vsIdToRunId(): Map<string, string> {
        return this.testItemIndex.vsIdToRunId;
    }

    constructor(testController: TestController, testProvider: TestProvider, private workspaceUri: Uri) {
        this.testController = testController;
        this.testProvider = testProvider;

        // Create per-workspace TestItemIndex to manage ID mappings
        this.testItemIndex = new TestItemIndex();
    }

    public resolveDiscovery(payload: DiscoveredTestPayload, token?: CancellationToken): void {
        if (!payload) {
            // No test data is available
        } else {
            this._resolveDiscovery(payload as DiscoveredTestPayload, token);
        }
    }

    public _resolveDiscovery(payload: DiscoveredTestPayload, token?: CancellationToken): void {
        // Delegate to the shared discovery handler
        PythonResultResolver.discoveryHandler.processDiscovery(
            payload,
            this.testController,
            this.testItemIndex,
            this.workspaceUri,
            this.testProvider,
            token,
        );
    }

    public resolveExecution(payload: ExecutionTestPayload | CoveragePayload, runInstance: TestRun): void {
        if ('coverage' in payload) {
            // coverage data is sent once per connection
            traceVerbose('Coverage data received.');
            this._resolveCoverage(payload as CoveragePayload, runInstance);
        } else {
            this._resolveExecution(payload as ExecutionTestPayload, runInstance);
        }
    }

    public _resolveCoverage(payload: CoveragePayload, runInstance: TestRun): void {
        // Delegate to the shared coverage handler and store the detailed coverage map
        this.detailedCoverageMap = PythonResultResolver.coverageHandler.processCoverage(payload, runInstance);
    }

    /**
     * Clean up stale test item references from the cache maps.
     * Validates cached items and removes any that are no longer in the test tree.
     */
    public cleanupStaleReferences(): void {
        this.testItemIndex.cleanupStaleReferences(this.testController);
    }

    /**
     * Process test execution results and update VS Code's Test Explorer with outcomes.
     * Uses efficient lookup methods to handle large numbers of test results.
     */
    public _resolveExecution(payload: ExecutionTestPayload, runInstance: TestRun): void {
        // Delegate to the shared execution handler and store subtest stats
        this.subTestStats = PythonResultResolver.executionHandler.processExecution(
            payload,
            runInstance,
            this.testItemIndex,
            this.testController,
        );
    }
}
