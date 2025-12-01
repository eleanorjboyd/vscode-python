// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, TestItem } from 'vscode';
import { traceError, traceVerbose } from '../../../logging';

/**
 * Interface defining subtest statistics for a parent test
 */
export interface SubtestStats {
    passed: number;
    failed: number;
}

/**
 * TestItemIndex - Manages persistent ID mappings between Python test IDs and VS Code TestItems.
 *
 * This is the only stateful component in the new design. It provides:
 * - Storage for bidirectional mappings: runId ↔ TestItem, runId ↔ vsId
 * - Efficient O(1) lookup methods
 * - Stale reference cleanup when tests are removed
 * - Validation that TestItem references are still in the tree
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
     * Map from Python run ID (e.g., "test_file.py::test_example") to VS Code TestItem
     * Used for O(1) lookup during execution result processing
     */
    private _runIdToTestItem: Map<string, TestItem>;

    /**
     * Map from Python run ID to VS Code ID
     * Used as fallback when TestItem reference is stale
     */
    private _runIdToVSid: Map<string, string>;

    /**
     * Map from VS Code ID to Python run ID
     * Used by WorkspaceTestAdapter.executeTests() to convert selected tests to Python IDs
     */
    private _vsIdToRunId: Map<string, string>;

    constructor() {
        this._runIdToTestItem = new Map<string, TestItem>();
        this._runIdToVSid = new Map<string, string>();
        this._vsIdToRunId = new Map<string, string>();
    }

    /**
     * Get the runId to TestItem map (read-only access for backward compatibility)
     */
    public get runIdToTestItem(): Map<string, TestItem> {
        return this._runIdToTestItem;
    }

    /**
     * Get the runId to VS Code ID map (read-only access for backward compatibility)
     */
    public get runIdToVSid(): Map<string, string> {
        return this._runIdToVSid;
    }

    /**
     * Get the VS Code ID to runId map (read-only access for backward compatibility)
     */
    public get vsIdToRunId(): Map<string, string> {
        return this._vsIdToRunId;
    }

    /**
     * Register a test item with its Python run ID and VS Code ID.
     * Called during DISCOVERY to populate the index.
     *
     * @param runId - Python run ID (e.g., "test_file.py::test_example")
     * @param vsId - VS Code TestItem ID
     * @param testItem - The VS Code TestItem reference
     */
    public registerTestItem(runId: string, vsId: string, testItem: TestItem): void {
        this._runIdToTestItem.set(runId, testItem);
        this._runIdToVSid.set(runId, vsId);
        this._vsIdToRunId.set(vsId, runId);
    }

    /**
     * Get TestItem by Python run ID with validation and fallback strategies.
     * Called during EXECUTION to look up tests.
     *
     * Uses a three-tier approach:
     * 1. Direct O(1) lookup in runIdToTestItem map
     * 2. If stale, try vsId mapping and search controller
     * 3. Fall back to full tree search if needed
     *
     * @param runId - Python run ID to look up
     * @param testController - TestController to search if cached reference is stale
     * @returns TestItem if found, undefined otherwise
     */
    public getTestItem(runId: string, testController: TestController): TestItem | undefined {
        // Try direct O(1) lookup first
        const directItem = this._runIdToTestItem.get(runId);
        if (directItem) {
            // Validate the item is still in the test tree
            if (this.isTestItemValid(directItem, testController)) {
                return directItem;
            } else {
                // Clean up stale reference
                this._runIdToTestItem.delete(runId);
            }
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
            } else {
                // Clean up stale mapping
                this._runIdToVSid.delete(runId);
                this._vsIdToRunId.delete(vsId);
            }
        }

        // Last resort: full tree search (logged as it's expensive)
        traceError(`Falling back to tree search for test: ${runId}`);
        return this.searchTreeForTestItem(vsId, testController);
    }

    /**
     * Get Python run ID from VS Code ID.
     * Called by WorkspaceTestAdapter.executeTests() to convert selected tests to Python IDs.
     *
     * @param vsId - VS Code TestItem ID
     * @returns Python run ID if found, undefined otherwise
     */
    public getRunId(vsId: string): string | undefined {
        return this._vsIdToRunId.get(vsId);
    }

    /**
     * Get VS Code ID from Python run ID.
     *
     * @param runId - Python run ID
     * @returns VS Code ID if found, undefined otherwise
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
     * @param testItem - TestItem to validate
     * @param testController - TestController that owns the test tree
     * @returns true if the item is valid and in the tree
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
     * @param testController - TestController to validate items against
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
     * Search the entire test tree for a test item by VS Code ID.
     * This is expensive and should only be used as a last resort.
     *
     * @param vsId - VS Code ID to search for
     * @param testController - TestController containing the test tree
     * @returns TestItem if found, undefined otherwise
     */
    private searchTreeForTestItem(vsId: string | undefined, testController: TestController): TestItem | undefined {
        if (!vsId) {
            return undefined;
        }

        const testCases: TestItem[] = [];
        testController.items.forEach((item) => {
            this.collectTestCasesRecursively(item, testCases);
        });

        return testCases.find((item) => item.id === vsId);
    }

    /**
     * Recursively collect all test case items from a test item and its children.
     *
     * @param testItem - Root item to start collecting from
     * @param testCases - Array to collect test cases into
     */
    private collectTestCasesRecursively(testItem: TestItem, testCases: TestItem[]): void {
        if (!testItem.canResolveChildren) {
            // This is a leaf node (test case)
            testCases.push(testItem);
        }
        testItem.children.forEach((child) => {
            this.collectTestCasesRecursively(child, testCases);
        });
    }
}
