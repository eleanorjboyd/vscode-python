// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    CancellationToken,
    TestController,
    TestItem,
    Uri,
    TestMessage,
    Location,
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
import { clearAllChildren } from './testItemUtilities';
import { splitLines } from '../../../common/stringUtils';
import { splitTestNameWithRegex } from './utils';
import { TestItemIndex } from './testItemIndex';
import { TestDiscoveryHandler } from './testDiscoveryHandler';

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
     * Find a test item efficiently using cached maps with fallback strategies.
     * Delegates to TestItemIndex.getTestItem() for the actual lookup logic.
     */
    private findTestItemByIdEfficient(keyTemp: string): TestItem | undefined {
        return this.testItemIndex.getTestItem(keyTemp, this.testController);
    }

    /**
     * Clean up stale test item references from the cache maps.
     * Delegates to TestItemIndex.cleanupStaleReferences() for the cleanup logic.
     */
    public cleanupStaleReferences(): void {
        this.testItemIndex.cleanupStaleReferences(this.testController);
    }

    /**
     * Handle test items that errored during execution.
     * Extracts error details, finds the corresponding TestItem, and reports the error to VS Code's Test Explorer.
     */
    private handleTestError(keyTemp: string, testItem: any, runInstance: TestRun): void {
        const rawTraceback = testItem.traceback ?? '';
        const traceback = splitLines(rawTraceback, {
            trim: false,
            removeEmptyEntries: true,
        }).join('\r\n');
        const text = `${testItem.test} failed with error: ${testItem.message ?? testItem.outcome}\r\n${traceback}`;
        const message = new TestMessage(text);

        const foundItem = this.findTestItemByIdEfficient(keyTemp);

        if (foundItem?.uri) {
            if (foundItem.range) {
                message.location = new Location(foundItem.uri, foundItem.range);
            }
            runInstance.errored(foundItem, message);
        }
    }

    /**
     * Handle test items that failed during execution
     */
    private handleTestFailure(keyTemp: string, testItem: any, runInstance: TestRun): void {
        const rawTraceback = testItem.traceback ?? '';
        const traceback = splitLines(rawTraceback, {
            trim: false,
            removeEmptyEntries: true,
        }).join('\r\n');

        const text = `${testItem.test} failed: ${testItem.message ?? testItem.outcome}\r\n${traceback}`;
        const message = new TestMessage(text);

        const foundItem = this.findTestItemByIdEfficient(keyTemp);

        if (foundItem?.uri) {
            if (foundItem.range) {
                message.location = new Location(foundItem.uri, foundItem.range);
            }
            runInstance.failed(foundItem, message);
        }
    }

    /**
     * Handle test items that passed during execution
     */
    private handleTestSuccess(keyTemp: string, runInstance: TestRun): void {
        const grabTestItem = this.runIdToTestItem.get(keyTemp);

        if (grabTestItem !== undefined) {
            const foundItem = this.findTestItemByIdEfficient(keyTemp);
            if (foundItem?.uri) {
                runInstance.passed(grabTestItem);
            }
        }
    }

    /**
     * Handle test items that were skipped during execution
     */
    private handleTestSkipped(keyTemp: string, runInstance: TestRun): void {
        const grabTestItem = this.runIdToTestItem.get(keyTemp);

        if (grabTestItem !== undefined) {
            const foundItem = this.findTestItemByIdEfficient(keyTemp);
            if (foundItem?.uri) {
                runInstance.skipped(grabTestItem);
            }
        }
    }

    /**
     * Handle subtest failures
     */
    private handleSubtestFailure(keyTemp: string, testItem: any, runInstance: TestRun): void {
        const [parentTestCaseId, subtestId] = splitTestNameWithRegex(keyTemp);
        const parentTestItem = this.runIdToTestItem.get(parentTestCaseId);

        if (parentTestItem) {
            const subtestStats = this.subTestStats.get(parentTestCaseId);
            if (subtestStats) {
                subtestStats.failed += 1;
            } else {
                this.subTestStats.set(parentTestCaseId, {
                    failed: 1,
                    passed: 0,
                });
                clearAllChildren(parentTestItem);
            }

            const subTestItem = this.testController?.createTestItem(subtestId, subtestId, parentTestItem.uri);

            if (subTestItem) {
                const traceback = testItem.traceback ?? '';
                const text = `${testItem.subtest} failed: ${testItem.message ?? testItem.outcome}\r\n${traceback}`;
                parentTestItem.children.add(subTestItem);
                runInstance.started(subTestItem);
                const message = new TestMessage(text);
                if (parentTestItem.uri && parentTestItem.range) {
                    message.location = new Location(parentTestItem.uri, parentTestItem.range);
                }
                runInstance.failed(subTestItem, message);
            } else {
                throw new Error('Unable to create new child node for subtest');
            }
        } else {
            throw new Error('Parent test item not found');
        }
    }

    /**
     * Handle subtest successes
     */
    private handleSubtestSuccess(keyTemp: string, runInstance: TestRun): void {
        const [parentTestCaseId, subtestId] = splitTestNameWithRegex(keyTemp);
        const parentTestItem = this.runIdToTestItem.get(parentTestCaseId);

        if (parentTestItem) {
            const subtestStats = this.subTestStats.get(parentTestCaseId);
            if (subtestStats) {
                subtestStats.passed += 1;
            } else {
                this.subTestStats.set(parentTestCaseId, { failed: 0, passed: 1 });
                clearAllChildren(parentTestItem);
            }

            const subTestItem = this.testController?.createTestItem(subtestId, subtestId, parentTestItem.uri);

            if (subTestItem) {
                parentTestItem.children.add(subTestItem);
                runInstance.started(subTestItem);
                runInstance.passed(subTestItem);
            } else {
                throw new Error('Unable to create new child node for subtest');
            }
        } else {
            throw new Error('Parent test item not found');
        }
    }

    /**
     * Process test execution results and update VS Code's Test Explorer with outcomes.
     * Uses efficient lookup methods to handle large numbers of test results.
     */
    public _resolveExecution(payload: ExecutionTestPayload, runInstance: TestRun): void {
        const rawTestExecData = payload as ExecutionTestPayload;
        if (rawTestExecData !== undefined && rawTestExecData.result !== undefined) {
            for (const keyTemp of Object.keys(rawTestExecData.result)) {
                const testItem = rawTestExecData.result[keyTemp];

                // Delegate to specific outcome handlers using efficient lookups
                if (testItem.outcome === 'error') {
                    this.handleTestError(keyTemp, testItem, runInstance);
                } else if (testItem.outcome === 'failure' || testItem.outcome === 'passed-unexpected') {
                    this.handleTestFailure(keyTemp, testItem, runInstance);
                } else if (testItem.outcome === 'success' || testItem.outcome === 'expected-failure') {
                    this.handleTestSuccess(keyTemp, runInstance);
                } else if (testItem.outcome === 'skipped') {
                    this.handleTestSkipped(keyTemp, runInstance);
                } else if (testItem.outcome === 'subtest-failure') {
                    this.handleSubtestFailure(keyTemp, testItem, runInstance);
                } else if (testItem.outcome === 'subtest-success') {
                    this.handleSubtestSuccess(keyTemp, runInstance);
                }
            }
        }
    }
}
