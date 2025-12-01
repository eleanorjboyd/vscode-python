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

    // Expose maps for backward compatibility (WorkspaceTestAdapter accesses these)
    public get runIdToTestItem(): Map<string, TestItem> {
        return this.testItemIndex.runIdToTestItem;
    }

    public get runIdToVSid(): Map<string, string> {
        return this.testItemIndex.runIdToVSid;
    }

    public get vsIdToRunId(): Map<string, string> {
        return this.testItemIndex.vsIdToRunId;
    }

    public subTestStats: Map<string, { passed: number; failed: number }> = new Map();

    public detailedCoverageMap = new Map<string, FileCoverageDetail[]>();

    // Shared singleton handler instances (stateless, can be shared across all resolvers)
    private static discoveryHandler: TestDiscoveryHandler = new TestDiscoveryHandler();
    private static executionHandler: TestExecutionHandler = new TestExecutionHandler();
    private static coverageHandler: TestCoverageHandler = new TestCoverageHandler();

    constructor(testController: TestController, testProvider: TestProvider, private workspaceUri: Uri) {
        this.testController = testController;
        this.testProvider = testProvider;

        // Create the per-workspace TestItemIndex for ID mappings
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
        // Clear the testItemIndex before discovery handler processes the payload
        // This ensures a clean state for the new discovery results
        this.testItemIndex.clear();

        // Delegate to the stateless discovery handler
        PythonResultResolver.discoveryHandler.processDiscovery(
            payload,
            this.testController,
            this,
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
        // Delegate to the stateless coverage handler
        // Store the returned coverage map for backward compatibility
        this.detailedCoverageMap = PythonResultResolver.coverageHandler.processCoverage(payload, runInstance);
    }

    /**
     * Clean up stale test item references from the cache maps.
     * Delegates to TestItemIndex for the actual cleanup logic.
     */
    public cleanupStaleReferences(): void {
        this.testItemIndex.cleanupStaleReferences(this.testController);
    }

    /**
     * Process test execution results and update VS Code's Test Explorer with outcomes.
     * Delegates to the stateless TestExecutionHandler.
     */
    public _resolveExecution(payload: ExecutionTestPayload, runInstance: TestRun): void {
        // Delegate to the stateless execution handler
        // Store the returned subtest stats for backward compatibility
        this.subTestStats = PythonResultResolver.executionHandler.processExecution(
            payload,
            runInstance,
            this.testItemIndex,
            this.testController,
            this,
        );
    }
}
