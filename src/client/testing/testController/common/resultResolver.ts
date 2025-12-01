// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationToken,
    TestController,
    TestItem,
    Uri,
    TestRun,
    TestCoverageCount,
    FileCoverage,
    FileCoverageDetail,
    StatementCoverage,
    Range,
} from 'vscode';
import {
    CoveragePayload,
    DiscoveredTestPayload,
    ExecutionTestPayload,
    FileCoverageMetrics,
    ITestResultResolver,
} from './types';
import { TestProvider } from '../../types';
import { traceVerbose } from '../../../logging';
import { TestItemIndex } from './testItemIndex';
import { TestDiscoveryHandler } from './testDiscoveryHandler';
import { TestExecutionHandler } from './testExecutionHandler';

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
        if (payload.result === undefined) {
            return;
        }
        for (const [key, value] of Object.entries(payload.result)) {
            const fileNameStr = key;
            const fileCoverageMetrics: FileCoverageMetrics = value;
            const linesCovered = fileCoverageMetrics.lines_covered ? fileCoverageMetrics.lines_covered : []; // undefined if no lines covered
            const linesMissed = fileCoverageMetrics.lines_missed ? fileCoverageMetrics.lines_missed : []; // undefined if no lines missed
            const executedBranches = fileCoverageMetrics.executed_branches;
            const totalBranches = fileCoverageMetrics.total_branches;

            const lineCoverageCount = new TestCoverageCount(
                linesCovered.length,
                linesCovered.length + linesMissed.length,
            );
            let fileCoverage: FileCoverage;
            const uri = Uri.file(fileNameStr);
            if (totalBranches === -1) {
                // branch coverage was not enabled and should not be displayed
                fileCoverage = new FileCoverage(uri, lineCoverageCount);
            } else {
                const branchCoverageCount = new TestCoverageCount(executedBranches, totalBranches);
                fileCoverage = new FileCoverage(uri, lineCoverageCount, branchCoverageCount);
            }
            runInstance.addCoverage(fileCoverage);

            // create detailed coverage array for each file (only line coverage on detailed, not branch)
            const detailedCoverageArray: FileCoverageDetail[] = [];
            // go through all covered lines, create new StatementCoverage, and add to detailedCoverageArray
            for (const line of linesCovered) {
                // line is 1-indexed, so we need to subtract 1 to get the 0-indexed line number
                // true value means line is covered
                const statementCoverage = new StatementCoverage(
                    true,
                    new Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
                );
                detailedCoverageArray.push(statementCoverage);
            }
            for (const line of linesMissed) {
                // line is 1-indexed, so we need to subtract 1 to get the 0-indexed line number
                // false value means line is NOT covered
                const statementCoverage = new StatementCoverage(
                    false,
                    new Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER),
                );
                detailedCoverageArray.push(statementCoverage);
            }

            this.detailedCoverageMap.set(uri.fsPath, detailedCoverageArray);
        }
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
