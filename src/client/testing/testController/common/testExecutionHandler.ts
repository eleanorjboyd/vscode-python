// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, TestItem, TestMessage, Location, TestRun } from 'vscode';
import { ExecutionTestPayload } from './types';
import { traceError } from '../../../logging';
import { clearAllChildren, getTestCaseNodes } from './testItemUtilities';
import { splitLines } from '../../../common/stringUtils';
import { splitTestNameWithRegex } from './utils';
import { TestItemIndex } from './testItemIndex';

/**
 * Subtest statistics returned by execution handler.
 */
export interface SubtestStats {
    passed: number;
    failed: number;
}

/**
 * TestExecutionHandler processes execution payloads and updates TestRun instances.
 *
 * This is a stateless handler that can be shared across all workspaces.
 *
 * Responsibilities:
 * - Parse ExecutionTestPayload and update TestRun with results (passed/failed/skipped/errored)
 * - Look up TestItems using TestItemIndex
 * - Handle subtests (create child TestItems dynamically)
 * - Process test outcomes and create TestMessages
 */
export class TestExecutionHandler {
    /**
     * Process execution payload and update test run.
     * Pure function - no instance state used.
     * Returns subtest statistics for caller to manage.
     *
     * @param payload Execution payload from Python subprocess
     * @param runInstance VS Code TestRun instance
     * @param testItemIndex TestItemIndex for looking up TestItems
     * @param testController VS Code TestController
     * @returns Map of parent test ID to subtest statistics
     */
    processExecution(
        payload: ExecutionTestPayload,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): Map<string, SubtestStats> {
        const subtestStats = new Map<string, SubtestStats>();

        if (payload !== undefined && payload.result !== undefined) {
            for (const keyTemp of Object.keys(payload.result)) {
                const testItem = payload.result[keyTemp];

                // Delegate to specific outcome handlers using efficient lookups
                if (testItem.outcome === 'error') {
                    this.handleTestError(keyTemp, testItem, runInstance, testItemIndex, testController);
                } else if (testItem.outcome === 'failure' || testItem.outcome === 'passed-unexpected') {
                    this.handleTestFailure(keyTemp, testItem, runInstance, testItemIndex, testController);
                } else if (testItem.outcome === 'success' || testItem.outcome === 'expected-failure') {
                    this.handleTestSuccess(keyTemp, runInstance, testItemIndex, testController);
                } else if (testItem.outcome === 'skipped') {
                    this.handleTestSkipped(keyTemp, runInstance, testItemIndex, testController);
                } else if (testItem.outcome === 'subtest-failure') {
                    this.handleSubtestFailure(keyTemp, testItem, runInstance, testItemIndex, testController, subtestStats);
                } else if (testItem.outcome === 'subtest-success') {
                    this.handleSubtestSuccess(keyTemp, runInstance, testItemIndex, testController, subtestStats);
                }
            }
        }

        return subtestStats;
    }

    /**
     * Collect all test case items from the test controller tree.
     * Note: This performs full tree traversal - use cached lookups when possible.
     */
    private collectAllTestCases(testController: TestController): TestItem[] {
        const testCases: TestItem[] = [];

        testController.items.forEach((i) => {
            const tempArr: TestItem[] = getTestCaseNodes(i);
            testCases.push(...tempArr);
        });

        return testCases;
    }

    /**
     * Find a test item efficiently using cached maps with fallback strategies.
     * Uses a three-tier approach: direct lookup, ID mapping, then tree search.
     */
    private findTestItemByIdEfficient(
        keyTemp: string,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): TestItem | undefined {
        // Use TestItemIndex's getTestItem which implements the three-tier lookup strategy
        const item = testItemIndex.getTestItem(keyTemp, testController);
        if (item) {
            return item;
        }

        // Last resort: full tree search
        traceError(`Falling back to tree search for test: ${keyTemp}`);
        const vsId = testItemIndex.getVSId(keyTemp);
        const testCases = this.collectAllTestCases(testController);
        return testCases.find((testItem) => testItem.id === vsId);
    }

    /**
     * Handle test items that errored during execution.
     * Extracts error details, finds the corresponding TestItem, and reports the error to VS Code's Test Explorer.
     */
    private handleTestError(
        keyTemp: string,
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

        const foundItem = this.findTestItemByIdEfficient(keyTemp, testItemIndex, testController);

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
    private handleTestFailure(
        keyTemp: string,
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

        const foundItem = this.findTestItemByIdEfficient(keyTemp, testItemIndex, testController);

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
    private handleTestSuccess(
        keyTemp: string,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): void {
        const foundItem = this.findTestItemByIdEfficient(keyTemp, testItemIndex, testController);
        if (foundItem?.uri) {
            runInstance.passed(foundItem);
        }
    }

    /**
     * Handle test items that were skipped during execution
     */
    private handleTestSkipped(
        keyTemp: string,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): void {
        const foundItem = this.findTestItemByIdEfficient(keyTemp, testItemIndex, testController);
        if (foundItem?.uri) {
            runInstance.skipped(foundItem);
        }
    }

    /**
     * Handle subtest failures
     */
    private handleSubtestFailure(
        keyTemp: string,
        testItem: any,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
        subtestStats: Map<string, SubtestStats>,
    ): void {
        const [parentTestCaseId, subtestId] = splitTestNameWithRegex(keyTemp);
        const parentTestItem = testItemIndex.runIdToTestItem.get(parentTestCaseId);

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

            const subTestItem = testController.createTestItem(subtestId, subtestId, parentTestItem.uri);

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
    private handleSubtestSuccess(
        keyTemp: string,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
        subtestStats: Map<string, SubtestStats>,
    ): void {
        const [parentTestCaseId, subtestId] = splitTestNameWithRegex(keyTemp);
        const parentTestItem = testItemIndex.runIdToTestItem.get(parentTestCaseId);

        if (parentTestItem) {
            const stats = subtestStats.get(parentTestCaseId);
            if (stats) {
                stats.passed += 1;
            } else {
                subtestStats.set(parentTestCaseId, { failed: 0, passed: 1 });
                clearAllChildren(parentTestItem);
            }

            const subTestItem = testController.createTestItem(subtestId, subtestId, parentTestItem.uri);

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
