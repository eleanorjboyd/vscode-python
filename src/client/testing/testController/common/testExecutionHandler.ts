// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, TestMessage, Location, TestRun } from 'vscode';
import { ExecutionTestPayload, ITestResultResolver } from './types';
import { splitLines } from '../../../common/stringUtils';
import { splitTestNameWithRegex } from './utils';
import { clearAllChildren } from './testItemUtilities';
import { TestItemIndex } from './testItemIndex';

/**
 * Interface defining subtest statistics for a parent test
 */
export interface SubtestStats {
    passed: number;
    failed: number;
}

/**
 * TestExecutionHandler - Stateless processor for test execution payloads.
 *
 * This handler processes execution payloads and updates TestRun instances with results.
 * It is designed to be stateless and shared across all workspaces.
 *
 * Responsibilities:
 * - Parse ExecutionTestPayload and update TestRun with results (passed/failed/skipped/errored)
 * - Look up TestItems using TestItemIndex
 * - Handle subtests (create child TestItems dynamically)
 * - Process test outcomes and create TestMessages
 *
 * The handler returns subtest statistics rather than storing them, allowing
 * the caller (resolver or adapter) to decide how to manage this transient state.
 */
export class TestExecutionHandler {
    /**
     * Process execution payload and update test run.
     * This is the main entry point for handling execution results.
     *
     * @param payload - The execution payload from the Python subprocess
     * @param runInstance - VS Code TestRun to update with results
     * @param testItemIndex - Index for looking up TestItems by run ID
     * @param testController - VS Code TestController for creating subtest items
     * @param resultResolver - Result resolver for accessing ID mappings (for subtests)
     * @returns Map of subtest statistics for caller to manage
     */
    public processExecution(
        payload: ExecutionTestPayload,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
        resultResolver: ITestResultResolver,
    ): Map<string, SubtestStats> {
        const subtestStats = new Map<string, SubtestStats>();

        if (payload !== undefined && payload.result !== undefined) {
            for (const keyTemp of Object.keys(payload.result)) {
                const testItem = payload.result[keyTemp];

                // Route to outcome-specific handlers
                this.handleTestOutcome(
                    keyTemp,
                    testItem,
                    runInstance,
                    testItemIndex,
                    testController,
                    resultResolver,
                    subtestStats,
                );
            }
        }

        return subtestStats;
    }

    /**
     * Route test result to appropriate outcome handler based on outcome type.
     */
    private handleTestOutcome(
        runId: string,
        testItem: any,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
        resultResolver: ITestResultResolver,
        subtestStats: Map<string, SubtestStats>,
    ): void {
        if (testItem.outcome === 'error') {
            this.handleTestError(runId, testItem, runInstance, testItemIndex, testController);
        } else if (testItem.outcome === 'failure' || testItem.outcome === 'passed-unexpected') {
            this.handleTestFailure(runId, testItem, runInstance, testItemIndex, testController);
        } else if (testItem.outcome === 'success' || testItem.outcome === 'expected-failure') {
            this.handleTestSuccess(runId, runInstance, testItemIndex, testController);
        } else if (testItem.outcome === 'skipped') {
            this.handleTestSkipped(runId, runInstance, testItemIndex, testController);
        } else if (testItem.outcome === 'subtest-failure') {
            this.handleSubtestFailure(runId, testItem, runInstance, testController, resultResolver, subtestStats);
        } else if (testItem.outcome === 'subtest-success') {
            this.handleSubtestSuccess(runId, runInstance, testController, resultResolver, subtestStats);
        }
    }

    /**
     * Handle test items that errored during execution.
     * Extracts error details, finds the corresponding TestItem, and reports the error to VS Code's Test Explorer.
     */
    private handleTestError(
        runId: string,
        testItem: any,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): void {
        const rawTraceback = testItem.traceback ?? '';
        const traceback = splitLines(rawTraceback, {
            trim: false,
            removeEmptyEntries: true,
        }).join('\r\n');
        const text = `${testItem.test} failed with error: ${testItem.message ?? testItem.outcome}\r\n${traceback}`;
        const message = new TestMessage(text);

        const foundItem = testItemIndex.getTestItem(runId, testController);

        if (foundItem?.uri) {
            if (foundItem.range) {
                message.location = new Location(foundItem.uri, foundItem.range);
            }
            runInstance.errored(foundItem, message);
        }
    }

    /**
     * Handle test items that failed during execution.
     */
    private handleTestFailure(
        runId: string,
        testItem: any,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): void {
        const rawTraceback = testItem.traceback ?? '';
        const traceback = splitLines(rawTraceback, {
            trim: false,
            removeEmptyEntries: true,
        }).join('\r\n');

        const text = `${testItem.test} failed: ${testItem.message ?? testItem.outcome}\r\n${traceback}`;
        const message = new TestMessage(text);

        const foundItem = testItemIndex.getTestItem(runId, testController);

        if (foundItem?.uri) {
            if (foundItem.range) {
                message.location = new Location(foundItem.uri, foundItem.range);
            }
            runInstance.failed(foundItem, message);
        }
    }

    /**
     * Handle test items that passed during execution.
     */
    private handleTestSuccess(
        runId: string,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): void {
        const grabTestItem = testItemIndex.runIdToTestItem.get(runId);

        if (grabTestItem !== undefined) {
            const foundItem = testItemIndex.getTestItem(runId, testController);
            if (foundItem?.uri) {
                runInstance.passed(grabTestItem);
            }
        }
    }

    /**
     * Handle test items that were skipped during execution.
     */
    private handleTestSkipped(
        runId: string,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): void {
        const grabTestItem = testItemIndex.runIdToTestItem.get(runId);

        if (grabTestItem !== undefined) {
            const foundItem = testItemIndex.getTestItem(runId, testController);
            if (foundItem?.uri) {
                runInstance.skipped(grabTestItem);
            }
        }
    }

    /**
     * Handle subtest failures.
     * Creates a child TestItem for the subtest and reports it as failed.
     */
    private handleSubtestFailure(
        runId: string,
        testItem: any,
        runInstance: TestRun,
        testController: TestController,
        resultResolver: ITestResultResolver,
        subtestStats: Map<string, SubtestStats>,
    ): void {
        const [parentTestCaseId, subtestId] = splitTestNameWithRegex(runId);
        const parentTestItem = resultResolver.runIdToTestItem.get(parentTestCaseId);

        if (parentTestItem) {
            const stats = subtestStats.get(parentTestCaseId);
            if (stats) {
                stats.failed += 1;
            } else {
                subtestStats.set(parentTestCaseId, {
                    failed: 1,
                    passed: 0,
                });
                clearAllChildren(parentTestItem);
            }

            const subTestItem = testController?.createTestItem(subtestId, subtestId, parentTestItem.uri);

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
     * Handle subtest successes.
     * Creates a child TestItem for the subtest and reports it as passed.
     */
    private handleSubtestSuccess(
        runId: string,
        runInstance: TestRun,
        testController: TestController,
        resultResolver: ITestResultResolver,
        subtestStats: Map<string, SubtestStats>,
    ): void {
        const [parentTestCaseId, subtestId] = splitTestNameWithRegex(runId);
        const parentTestItem = resultResolver.runIdToTestItem.get(parentTestCaseId);

        if (parentTestItem) {
            const stats = subtestStats.get(parentTestCaseId);
            if (stats) {
                stats.passed += 1;
            } else {
                subtestStats.set(parentTestCaseId, { failed: 0, passed: 1 });
                clearAllChildren(parentTestItem);
            }

            const subTestItem = testController?.createTestItem(subtestId, subtestId, parentTestItem.uri);

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
}
