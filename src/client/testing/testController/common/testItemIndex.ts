// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, TestItem } from 'vscode';
import { traceError, traceVerbose } from '../../../logging';

/**
 * TestItemIndex maintains persistent ID mappings between Python test IDs and VS Code TestItems.
 *
 * This class is the only stateful component in the test resolver architecture.
 * It bridges the gap between discovery (when TestItems are created) and execution
 * (when TestItems need to be looked up by their Python run ID).
 *
 * Ownership: One instance per workspace, created by PythonResultResolver.
 *
 * Lifecycle:
 * - Created: When PythonResultResolver is instantiated (during workspace activation)
 * - Populated: During discovery - each discovered test registers its mappings
 * - Queried: During execution - to look up TestItems by Python run ID
 * - Cleared: When discovery runs again (fresh start) or workspace is disposed
 * - Cleaned: Periodically to remove stale references to deleted tests
 */
export class TestItemIndex {
    /**
     * Maps Python run ID to VS Code TestItem instance.
     * Primary lookup structure for execution phase.
     */
    private _runIdToTestItem: Map<string, TestItem>;

    /**
     * Maps Python run ID to VS Code TestItem ID.
     * Used when the TestItem reference becomes stale but we still have the ID.
     */
    private _runIdToVSid: Map<string, string>;

    /**
     * Maps VS Code TestItem ID to Python run ID.
     * Used when converting user's test selection to Python command arguments.
     */
    private _vsIdToRunId: Map<string, string>;

    constructor() {
        this._runIdToTestItem = new Map<string, TestItem>();
        this._runIdToVSid = new Map<string, string>();
        this._vsIdToRunId = new Map<string, string>();
    }

    /**
     * Expose the internal maps for backward compatibility.
     * These allow the PythonResultResolver facade to provide the same public API.
     */
    public get runIdToTestItem(): Map<string, TestItem> {
        return this._runIdToTestItem;
    }

    public get runIdToVSid(): Map<string, string> {
        return this._runIdToVSid;
    }

    public get vsIdToRunId(): Map<string, string> {
        return this._vsIdToRunId;
    }

    /**
     * Register a test item with its Python run ID and VS Code ID.
     * Called during DISCOVERY to populate the index.
     *
     * @param runId The Python run ID (e.g., "test_file.py::test_example")
     * @param vsId The VS Code TestItem ID (e.g., "test_file.py::test_example")
     * @param testItem The VS Code TestItem instance
     */
    public registerTestItem(runId: string, vsId: string, testItem: TestItem): void {
        this._runIdToTestItem.set(runId, testItem);
        this._runIdToVSid.set(runId, vsId);
        this._vsIdToRunId.set(vsId, runId);
    }

    /**
     * Get TestItem by Python run ID (with validation and fallback strategies).
     * Called during EXECUTION to look up tests.
     *
     * Uses a three-tier approach:
     * 1. Direct O(1) lookup in runIdToTestItem
     * 2. If stale, try vsId mapping and search the tree
     * 3. Fall back to full tree search
     *
     * @param runId The Python run ID to look up
     * @param testController The TestController for tree traversal
     * @returns The TestItem if found, undefined otherwise
     */
    public getTestItem(runId: string, testController: TestController): TestItem | undefined {
        // Try direct O(1) lookup first
        const directItem = this._runIdToTestItem.get(runId);
        if (directItem) {
            // Validate the item is still in the test tree
            if (this.isTestItemValid(directItem, testController)) {
                return directItem;
            }
            // Clean up stale reference
            this._runIdToTestItem.delete(runId);
        }

        // Try vsId mapping as fallback
        const vsId = this._runIdToVSid.get(runId);
        if (vsId) {
            // Search by VS Code ID in the controller
            let foundItem: TestItem | undefined;
            testController.items.forEach((item) => {
                if (item.id === vsId) {
                    foundItem = item;
                    return;
                }
                if (!foundItem) {
                    item.children.forEach((child) => {
                        if (child.id === vsId) {
                            foundItem = child;
                        }
                    });
                }
            });

            if (foundItem) {
                // Cache for future lookups
                this._runIdToTestItem.set(runId, foundItem);
                return foundItem;
            }
            // Clean up stale mapping
            this._runIdToVSid.delete(runId);
            this._vsIdToRunId.delete(vsId);
        }

        // Last resort: full tree search (only if we have a vsId to search for)
        if (vsId === undefined) {
            return undefined;
        }
        traceError(`Falling back to tree search for test: ${runId}`);
        const testCases = this.collectAllTestCases(testController);
        return testCases.find((item) => item.id === vsId);
    }

    /**
     * Get Python run ID from VS Code ID.
     * Called by WorkspaceTestAdapter.executeTests() to convert selected tests to Python IDs.
     *
     * @param vsId The VS Code TestItem ID
     * @returns The Python run ID if found, undefined otherwise
     */
    public getRunId(vsId: string): string | undefined {
        return this._vsIdToRunId.get(vsId);
    }

    /**
     * Get VS Code ID from Python run ID.
     *
     * @param runId The Python run ID
     * @returns The VS Code TestItem ID if found, undefined otherwise
     */
    public getVSId(runId: string): string | undefined {
        return this._runIdToVSid.get(runId);
    }

    /**
     * Check if a TestItem is still valid (exists in the TestController tree).
     *
     * Time Complexity: O(depth) where depth is the maximum nesting level of the test tree.
     * In most cases this is O(1) to O(3) since test trees are typically shallow.
     *
     * @param testItem The TestItem to validate
     * @param testController The TestController that owns the tree
     * @returns true if the TestItem is still in the tree, false otherwise
     */
    public isTestItemValid(testItem: TestItem, testController: TestController): boolean {
        // Simple validation: check if the item's parent chain leads back to the controller
        let current: TestItem | undefined = testItem;
        while (current?.parent) {
            current = current.parent;
        }

        // If we reached a root item, check if it's in the controller
        if (current) {
            return testController.items.get(current.id) === current;
        }

        // If no parent chain, check if it's directly in the controller
        return testController.items.get(testItem.id) === testItem;
    }

    /**
     * Remove all mappings.
     * Called at the start of discovery to ensure clean state.
     */
    public clear(): void {
        this._runIdToTestItem.clear();
        this._runIdToVSid.clear();
        this._vsIdToRunId.clear();
    }

    /**
     * Clean up stale references that no longer exist in the test tree.
     * Called after test tree modifications.
     *
     * @param testController The TestController for validation
     */
    public cleanupStaleReferences(testController: TestController): void {
        const staleRunIds: string[] = [];

        // Check all runId->TestItem mappings
        this._runIdToTestItem.forEach((testItem, runId) => {
            if (!this.isTestItemValid(testItem, testController)) {
                staleRunIds.push(runId);
            }
        });

        // Remove stale entries
        staleRunIds.forEach((runId) => {
            const vsId = this._runIdToVSid.get(runId);
            this._runIdToTestItem.delete(runId);
            this._runIdToVSid.delete(runId);
            if (vsId) {
                this._vsIdToRunId.delete(vsId);
            }
        });

        if (staleRunIds.length > 0) {
            traceVerbose(`Cleaned up ${staleRunIds.length} stale test item references`);
        }
    }

    /**
     * Collect all test case items from the test controller tree.
     * Note: This performs full tree traversal - use cached lookups when possible.
     *
     * @param testController The TestController to traverse
     * @returns Array of all TestItem leaf nodes (test cases)
     */
    private collectAllTestCases(testController: TestController): TestItem[] {
        const testCases: TestItem[] = [];
        const getTestCaseNodes = (item: TestItem): TestItem[] => {
            const nodes: TestItem[] = [];
            if (!item.canResolveChildren && item.tags.length > 0) {
                nodes.push(item);
            }
            item.children.forEach((child) => {
                if (item.canResolveChildren) {
                    nodes.push(...getTestCaseNodes(child));
                } else {
                    nodes.push(item);
                }
            });
            return nodes;
        };

        testController.items.forEach((i) => {
            const tempArr = getTestCaseNodes(i);
            testCases.push(...tempArr);
        });

        return testCases;
    }
}
