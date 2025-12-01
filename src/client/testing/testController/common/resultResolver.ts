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

    /**
     * Per-workspace instance that manages all ID mappings.
     * This is the only stateful component that bridges discovery and execution.
     */
    private testItemIndex: TestItemIndex;

    /**
     * Shared singleton handler for discovery processing.
     * Stateless - can be safely shared across all resolvers.
     */
    private static discoveryHandler: TestDiscoveryHandler = new TestDiscoveryHandler();

    /**
     * Shared singleton handler for execution processing.
     * Stateless - can be safely shared across all resolvers.
     */
    private static executionHandler: TestExecutionHandler = new TestExecutionHandler();

    /**
     * Shared singleton handler for coverage processing.
     * Stateless - can be safely shared across all resolvers.
     */
    private static coverageHandler: TestCoverageHandler = new TestCoverageHandler();

    /**
     * Expose runIdToTestItem for backward compatibility.
     * Delegates to the internal TestItemIndex.
     */
    public get runIdToTestItem(): Map<string, TestItem> {
        return this.testItemIndex.runIdToTestItem;
    }

    /**
     * Expose runIdToVSid for backward compatibility.
     * Delegates to the internal TestItemIndex.
     */
    public get runIdToVSid(): Map<string, string> {
        return this.testItemIndex.runIdToVSid;
    }

    /**
     * Expose vsIdToRunId for backward compatibility.
     * Delegates to the internal TestItemIndex.
     */
    public get vsIdToRunId(): Map<string, string> {
        return this.testItemIndex.vsIdToRunId;
    }

    public subTestStats: Map<string, { passed: number; failed: number }> = new Map();

    public detailedCoverageMap = new Map<string, FileCoverageDetail[]>();

    constructor(testController: TestController, testProvider: TestProvider, private workspaceUri: Uri) {
        this.testController = testController;
        this.testProvider = testProvider;

        // Create the per-workspace TestItemIndex instance
        this.testItemIndex = new TestItemIndex();
    }

    public resolveDiscovery(payload: DiscoveredTestPayload, token?: CancellationToken): void {
        if (!payload) {
            // No test data is available
        } else {
            this._resolveDiscovery(payload as DiscoveredTestPayload, token);
        }
    }

    /**
     * Process discovery payload by delegating to the stateless TestDiscoveryHandler.
     */
    public _resolveDiscovery(payload: DiscoveredTestPayload, token?: CancellationToken): void {
        PythonResultResolver.discoveryHandler.processDiscovery(
            payload,
            this.testController,
            this.testItemIndex,
            this.workspaceUri,
            this.testProvider,
            this, // Pass this resolver for backward compatibility with populateTestTree
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

    /**
     * Process coverage payload by delegating to the stateless TestCoverageHandler.
     * Merges returned detailed coverage into this resolver's detailedCoverageMap.
     */
    public _resolveCoverage(payload: CoveragePayload, runInstance: TestRun): void {
        const newCoverage = PythonResultResolver.coverageHandler.processCoverage(payload, runInstance);

        // Merge the returned coverage data into our persistent map
        newCoverage.forEach((details, filePath) => {
            this.detailedCoverageMap.set(filePath, details);
        });
    }

    /**
     * Clean up stale test item references from the cache maps.
     * Delegates to TestItemIndex.cleanupStaleReferences() for the cleanup logic.
     */
    public cleanupStaleReferences(): void {
        this.testItemIndex.cleanupStaleReferences(this.testController);
    }

    /**
     * Process test execution results by delegating to the stateless TestExecutionHandler.
     * Merges returned subtest statistics into this resolver's subTestStats map.
     */
    public _resolveExecution(payload: ExecutionTestPayload, runInstance: TestRun): void {
        const newStats = PythonResultResolver.executionHandler.processExecution(
            payload,
            runInstance,
            this.testItemIndex,
            this.testController,
        );

        // Merge the returned subtest stats into our persistent map
        newStats.forEach((stats, parentId) => {
            const existing = this.subTestStats.get(parentId);
            if (existing) {
                existing.passed += stats.passed;
                existing.failed += stats.failed;
            } else {
                this.subTestStats.set(parentId, stats);
            }
        });
    }
}
