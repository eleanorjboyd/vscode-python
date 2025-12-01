// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, TestItem, TestItemCollection, Uri, Range } from 'vscode';
import * as typemoq from 'typemoq';
import * as assert from 'assert';
import { TestItemIndex } from '../../../client/testing/testController/common/testItemIndex';

suite('TestItemIndex tests', () => {
    let testItemIndex: TestItemIndex;
    let testControllerMock: typemoq.IMock<TestController>;
    let mockTestItem1: TestItem;
    let mockTestItem2: TestItem;

    function createMockTestItem(id: string): TestItem {
        const range = new Range(0, 0, 0, 0);
        const mockItem = ({
            id,
            canResolveChildren: false,
            tags: [{ id: 'python-run' }],
            children: {
                add: () => {
                    // empty
                },
            },
            range,
            uri: Uri.file('/foo/bar'),
            parent: undefined,
        } as unknown) as TestItem;

        return mockItem;
    }

    setup(() => {
        testItemIndex = new TestItemIndex();

        // Create mock test items
        mockTestItem1 = createMockTestItem('testItem1');
        mockTestItem2 = createMockTestItem('testItem2');

        // Create mock testItems to pass into an iterable
        const mockTestItems: [string, TestItem][] = [
            ['testItem1', mockTestItem1],
            ['testItem2', mockTestItem2],
        ];

        // Create mock testItemCollection
        const testItemCollectionMock = typemoq.Mock.ofType<TestItemCollection>();
        testItemCollectionMock
            .setup((x) => x.forEach(typemoq.It.isAny()))
            .callback((callback: (item: TestItem) => void) => {
                for (const [, item] of mockTestItems) {
                    callback(item);
                }
            });
        testItemCollectionMock
            .setup((x) => x.get(typemoq.It.isAnyString()))
            .returns((id: string) => {
                const found = mockTestItems.find(([key]) => key === id);
                return found ? found[1] : undefined;
            });

        // Create mock testController
        testControllerMock = typemoq.Mock.ofType<TestController>();
        testControllerMock.setup((t) => t.items).returns(() => testItemCollectionMock.object);
    });

    suite('registerTestItem', () => {
        test('should register a test item with all mappings', () => {
            const runId = 'test_file.py::test_example';
            const vsId = 'testItem1';

            testItemIndex.registerTestItem(runId, vsId, mockTestItem1);

            // Verify all three maps are populated
            assert.strictEqual(testItemIndex.runIdToTestItem.get(runId), mockTestItem1);
            assert.strictEqual(testItemIndex.runIdToVSid.get(runId), vsId);
            assert.strictEqual(testItemIndex.vsIdToRunId.get(vsId), runId);
        });

        test('should handle multiple registrations', () => {
            testItemIndex.registerTestItem('run1', 'vs1', mockTestItem1);
            testItemIndex.registerTestItem('run2', 'vs2', mockTestItem2);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 2);
            assert.strictEqual(testItemIndex.runIdToVSid.size, 2);
            assert.strictEqual(testItemIndex.vsIdToRunId.size, 2);
        });
    });

    suite('getRunId', () => {
        test('should return the run ID for a registered VS Code ID', () => {
            const runId = 'test_file.py::test_example';
            const vsId = 'testItem1';

            testItemIndex.registerTestItem(runId, vsId, mockTestItem1);

            assert.strictEqual(testItemIndex.getRunId(vsId), runId);
        });

        test('should return undefined for an unregistered VS Code ID', () => {
            assert.strictEqual(testItemIndex.getRunId('unknown'), undefined);
        });
    });

    suite('getVSId', () => {
        test('should return the VS Code ID for a registered run ID', () => {
            const runId = 'test_file.py::test_example';
            const vsId = 'testItem1';

            testItemIndex.registerTestItem(runId, vsId, mockTestItem1);

            assert.strictEqual(testItemIndex.getVSId(runId), vsId);
        });

        test('should return undefined for an unregistered run ID', () => {
            assert.strictEqual(testItemIndex.getVSId('unknown'), undefined);
        });
    });

    suite('clear', () => {
        test('should clear all mappings', () => {
            testItemIndex.registerTestItem('run1', 'vs1', mockTestItem1);
            testItemIndex.registerTestItem('run2', 'vs2', mockTestItem2);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 2);

            testItemIndex.clear();

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 0);
            assert.strictEqual(testItemIndex.runIdToVSid.size, 0);
            assert.strictEqual(testItemIndex.vsIdToRunId.size, 0);
        });
    });

    suite('getTestItem', () => {
        test('should return test item from direct lookup when valid', () => {
            const runId = 'test_file.py::test_example';
            const vsId = 'testItem1';

            testItemIndex.registerTestItem(runId, vsId, mockTestItem1);

            // The getTestItem method will validate against the controller
            // Since the mock controller is set up to return testItem1, this should work
            const result = testItemIndex.getTestItem(runId, testControllerMock.object);

            // The result depends on whether the mock validation passes
            // In this test setup, the mock controller items.get('testItem1') returns the mock item
            assert.strictEqual(result, mockTestItem1);
        });

        test('should return undefined for unregistered run ID', () => {
            const result = testItemIndex.getTestItem('unknown', testControllerMock.object);
            assert.strictEqual(result, undefined);
        });
    });

    suite('isTestItemValid', () => {
        test('should validate test item exists in controller', () => {
            // When the item is in the controller, it should be valid
            const result = testItemIndex.isTestItemValid(mockTestItem1, testControllerMock.object);

            // The item should be valid since it's in the mock controller
            assert.strictEqual(result, true);
        });

        test('should return false for item not in controller', () => {
            const unknownItem = createMockTestItem('unknownItem');

            const result = testItemIndex.isTestItemValid(unknownItem, testControllerMock.object);

            assert.strictEqual(result, false);
        });
    });

    suite('cleanupStaleReferences', () => {
        test('should remove stale references from all maps', () => {
            // Create a mock item that won't be found in the controller
            const staleItem = createMockTestItem('staleItem');

            // Register an item that won't be found in the controller
            testItemIndex.registerTestItem('staleRun', 'staleItem', staleItem);

            // Verify initial state
            assert.strictEqual(testItemIndex.runIdToTestItem.size, 1);

            // Call cleanup - the mock controller won't return the stale item
            testItemIndex.cleanupStaleReferences(testControllerMock.object);

            // After cleanup, stale items should be removed
            assert.strictEqual(testItemIndex.runIdToTestItem.size, 0);
            assert.strictEqual(testItemIndex.runIdToVSid.size, 0);
            assert.strictEqual(testItemIndex.vsIdToRunId.size, 0);
        });

        test('should keep valid references', () => {
            // Register an item that IS in the controller
            testItemIndex.registerTestItem('validRun', 'testItem1', mockTestItem1);

            // Verify initial state
            assert.strictEqual(testItemIndex.runIdToTestItem.size, 1);

            // The mock controller is set up to find 'testItem1'
            testItemIndex.cleanupStaleReferences(testControllerMock.object);

            // The valid item should still exist
            assert.strictEqual(testItemIndex.runIdToTestItem.size, 1);
            assert.strictEqual(testItemIndex.runIdToTestItem.get('validRun'), mockTestItem1);
        });
    });

    suite('expose internal maps for backward compatibility', () => {
        test('runIdToTestItem getter should return the internal map', () => {
            testItemIndex.registerTestItem('run1', 'vs1', mockTestItem1);

            const map = testItemIndex.runIdToTestItem;
            assert.strictEqual(map.get('run1'), mockTestItem1);
            assert.ok(map instanceof Map);
        });

        test('runIdToVSid getter should return the internal map', () => {
            testItemIndex.registerTestItem('run1', 'vs1', mockTestItem1);

            const map = testItemIndex.runIdToVSid;
            assert.strictEqual(map.get('run1'), 'vs1');
            assert.ok(map instanceof Map);
        });

        test('vsIdToRunId getter should return the internal map', () => {
            testItemIndex.registerTestItem('run1', 'vs1', mockTestItem1);

            const map = testItemIndex.vsIdToRunId;
            assert.strictEqual(map.get('vs1'), 'run1');
            assert.ok(map instanceof Map);
        });
    });
});
