// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, TestItem } from 'vscode';
import { traceVerbose } from '../../../logging';

/**
 * TestItemIndex maintains persistent ID mappings between Python test IDs and VS Code TestItems.
 *
 * This is the only stateful component in the test result handling design. It stores:
 * - runId → TestItem: Maps Python run IDs to VS Code TestItem instances
 * - runId → vsId: Maps Python run IDs to VS Code IDs
 * - vsId → runId: Maps VS Code IDs to Python run IDs
 *
 * Lifecycle:
 * - Created: When PythonResultResolver is instantiated (during workspace activation)
 * - Populated: During discovery - each discovered test registers its mappings
 * - Queried: During execution - to look up TestItems by Python run ID
 * - Cleared: When discovery runs again (fresh start) or workspace is disposed
 * - Cleaned: Periodically to remove stale references to deleted tests
 */
export class TestItemIndex {
    // THE STATE - these maps persist across discovery and execution
    private _runIdToTestItem: Map<string, TestItem>;

    private _runIdToVSid: Map<string, string>;

    private _vsIdToRunId: Map<string, string>;

    constructor() {
        this._runIdToTestItem = new Map<string, TestItem>();
        this._runIdToVSid = new Map<string, string>();
        this._vsIdToRunId = new Map<string, string>();
    }

    /**
     * Get the runId to TestItem map.
     * Used for backward compatibility with existing code.
     */
    get runIdToTestItem(): Map<string, TestItem> {
        return this._runIdToTestItem;
    }

    /**
     * Get the runId to VS Code ID map.
     * Used for backward compatibility with existing code.
     */
    get runIdToVSid(): Map<string, string> {
        return this._runIdToVSid;
    }

    /**
     * Get the VS Code ID to runId map.
     * Used for backward compatibility with existing code.
     */
    get vsIdToRunId(): Map<string, string> {
        return this._vsIdToRunId;
    }

    /**
     * Register a test item with its Python run ID and VS Code ID.
     * Called during DISCOVERY to populate the index.
     *
     * @param runId Python run ID (e.g., "test_file.py::test_example")
     * @param vsId VS Code ID (e.g., "test_file.py::test_example")
     * @param testItem VS Code TestItem instance
     */
    registerTestItem(runId: string, vsId: string, testItem: TestItem): void {
        this._runIdToTestItem.set(runId, testItem);
        this._runIdToVSid.set(runId, vsId);
        this._vsIdToRunId.set(vsId, runId);
    }

    /**
     * Get TestItem by Python run ID (with validation and fallback strategies).
     * Called during EXECUTION to look up tests.
     *
     * Uses a three-tier approach:
     * 1. Direct O(1) lookup from runIdToTestItem
     * 2. If stale, try vsId mapping and search tree
     * 3. Fall back to full tree search if needed
     *
     * @param runId Python run ID
     * @param testController VS Code TestController for tree search
     * @returns TestItem if found, undefined otherwise
     */
    getTestItem(runId: string, testController: TestController): TestItem | undefined {
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
                if (foundItem) {
                    return; // Already found, skip remaining iterations
                }
                if (item.id === vsId) {
                    foundItem = item;
                    return;
                }
                // Search children only if not found at top level
                item.children.forEach((child) => {
                    if (!foundItem && child.id === vsId) {
                        foundItem = child;
                    }
                });
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

        return undefined;
    }

    /**
     * Get Python run ID from VS Code ID.
     * Called by WorkspaceTestAdapter.executeTests() to convert selected tests to Python IDs.
     *
     * @param vsId VS Code ID
     * @returns Python run ID if found, undefined otherwise
     */
    getRunId(vsId: string): string | undefined {
        return this._vsIdToRunId.get(vsId);
    }

    /**
     * Get VS Code ID from Python run ID.
     *
     * @param runId Python run ID
     * @returns VS Code ID if found, undefined otherwise
     */
    getVSId(runId: string): string | undefined {
        return this._runIdToVSid.get(runId);
    }

    /**
     * Check if a TestItem reference is still valid in the TestController tree.
     *
     * Time Complexity: O(depth) where depth is the maximum nesting level of the test tree.
     * In most cases this is O(1) to O(3) since test trees are typically shallow.
     *
     * @param testItem TestItem to validate
     * @param testController VS Code TestController
     * @returns true if the item is still in the tree
     */
    isTestItemValid(testItem: TestItem, testController: TestController): boolean {
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
    clear(): void {
        this._runIdToTestItem.clear();
        this._runIdToVSid.clear();
        this._vsIdToRunId.clear();
    }

    /**
     * Clean up stale references that no longer exist in the test tree.
     * Called after test tree modifications.
     *
     * @param testController VS Code TestController
     */
    cleanupStaleReferences(testController: TestController): void {
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
}
