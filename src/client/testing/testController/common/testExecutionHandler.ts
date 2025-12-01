// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Location, TestController, TestMessage, TestRun } from 'vscode';
import { ExecutionTestPayload } from './types';
import { splitLines } from '../../../common/stringUtils';
import { splitTestNameWithRegex } from './utils';
import { TestItemIndex } from './testItemIndex';
import { clearAllChildren } from './testItemUtilities';

/**
 * Subtest statistics for a parent test.
 */
export interface SubtestStats {
    passed: number;
    failed: number;
}

/**
 * TestExecutionHandler processes execution payloads and updates TestRun instances.
 *
 * This class is STATELESS - it has no instance variables that persist between calls.
 * All state is passed as parameters or returned to the caller.
 *
 * Ownership: One shared instance created at the module/service level, reused by all resolvers/adapters.
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
     * @param payload The execution payload from the Python test run
     * @param runInstance The VS Code TestRun to update
     * @param testItemIndex The index to look up test items from
     * @param testController The TestController for creating subtest items
     * @returns Map of parent test ID to subtest statistics
     */
    public processExecution(
        payload: ExecutionTestPayload,
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
        testController: TestController,
    ): Map<string, SubtestStats> {
        const subtestStats = new Map<string, SubtestStats>();

        if (payload === undefined || payload.result === undefined) {
            return subtestStats;
        }

        for (const keyTemp of Object.keys(payload.result)) {
            const testItem = payload.result[keyTemp];

            // Delegate to specific outcome handlers
            if (testItem.outcome === 'error') {
                this.handleTestError(keyTemp, testItem, runInstance, testItemIndex);
            } else if (testItem.outcome === 'failure' || testItem.outcome === 'passed-unexpected') {
                this.handleTestFailure(keyTemp, testItem, runInstance, testItemIndex);
            } else if (testItem.outcome === 'success' || testItem.outcome === 'expected-failure') {
                this.handleTestSuccess(keyTemp, runInstance, testItemIndex);
            } else if (testItem.outcome === 'skipped') {
                this.handleTestSkipped(keyTemp, runInstance, testItemIndex);
            } else if (testItem.outcome === 'subtest-failure') {
                this.handleSubtestFailure(keyTemp, testItem, runInstance, testItemIndex, testController, subtestStats);
            } else if (testItem.outcome === 'subtest-success') {
                this.handleSubtestSuccess(keyTemp, runInstance, testItemIndex, testController, subtestStats);
            }
        }

        return subtestStats;
    }

    /**
     * Handle test items that errored during execution.
     */
    private handleTestError(
        keyTemp: string,
        testItem: { test?: string; message?: string; outcome?: string; traceback?: string },
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
    ): void {
        const rawTraceback = testItem.traceback ?? '';
        const traceback = splitLines(rawTraceback, {
            trim: false,
            removeEmptyEntries: true,
        }).join('\r\n');
        const text = `${testItem.test} failed with error: ${testItem.message ?? testItem.outcome}\r\n${traceback}`;
        const message = new TestMessage(text);

        const foundItem = testItemIndex.runIdToTestItem.get(keyTemp);

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
        keyTemp: string,
        testItem: { test?: string; message?: string; outcome?: string; traceback?: string },
        runInstance: TestRun,
        testItemIndex: TestItemIndex,
    ): void {
        const rawTraceback = testItem.traceback ?? '';
        const traceback = splitLines(rawTraceback, {
            trim: false,
            removeEmptyEntries: true,
        }).join('\r\n');

        const text = `${testItem.test} failed: ${testItem.message ?? testItem.outcome}\r\n${traceback}`;
        const message = new TestMessage(text);

        const foundItem = testItemIndex.runIdToTestItem.get(keyTemp);

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
    private handleTestSuccess(keyTemp: string, runInstance: TestRun, testItemIndex: TestItemIndex): void {
        const grabTestItem = testItemIndex.runIdToTestItem.get(keyTemp);

        if (grabTestItem !== undefined && grabTestItem.uri) {
            runInstance.passed(grabTestItem);
        }
    }

    /**
     * Handle test items that were skipped during execution.
     */
    private handleTestSkipped(keyTemp: string, runInstance: TestRun, testItemIndex: TestItemIndex): void {
        const grabTestItem = testItemIndex.runIdToTestItem.get(keyTemp);

        if (grabTestItem !== undefined && grabTestItem.uri) {
            runInstance.skipped(grabTestItem);
        }
    }

    /**
     * Handle subtest failures.
     */
    private handleSubtestFailure(
        keyTemp: string,
        testItem: { subtest?: string; message?: string; outcome?: string; traceback?: string },
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
                subtestStats.set(parentTestCaseId, { failed: 1, passed: 0 });
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
     * Handle subtest successes.
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
