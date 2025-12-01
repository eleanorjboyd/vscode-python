// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, TestItem, TestItemCollection, Uri } from 'vscode';
import * as typemoq from 'typemoq';
import * as assert from 'assert';
import { TestItemIndex } from '../../../client/testing/testController/common/testItemIndex';

suite('TestItemIndex tests', () => {
    let testItemIndex: TestItemIndex;
    let testControllerMock: typemoq.IMock<TestController>;

    function createMockTestItem(id: string, parent?: TestItem): TestItem {
        const mockTestItem = ({
            id,
            canResolveChildren: false,
            tags: [],
            parent,
            children: {
                add: () => {
                    // empty
                },
                forEach: () => {
                    // empty
                },
            },
            uri: Uri.file('/foo/bar'),
        } as unknown) as TestItem;
        return mockTestItem;
    }

    function createMockTestController(items: TestItem[]): typemoq.IMock<TestController> {
        const mockTestItems: [string, TestItem][] = items.map((item) => [item.id, item]);
        const iterableMock = mockTestItems[Symbol.iterator]();

        const testItemCollectionMock = typemoq.Mock.ofType<TestItemCollection>();
        testItemCollectionMock
            .setup((x) => x.forEach(typemoq.It.isAny()))
            .callback((callback) => {
                let result = iterableMock.next();
                while (!result.done) {
                    callback(result.value[1]);
                    result = iterableMock.next();
                }
            });
        testItemCollectionMock.setup((x) => x.get(typemoq.It.isAny())).returns((id) => items.find((i) => i.id === id));

        const mock = typemoq.Mock.ofType<TestController>();
        mock.setup((t) => t.items).returns(() => testItemCollectionMock.object);
        return mock;
    }

    setup(() => {
        testItemIndex = new TestItemIndex();
    });

    suite('Basic operations', () => {
        test('constructor creates empty maps', () => {
            assert.strictEqual(testItemIndex.runIdToTestItem.size, 0);
            assert.strictEqual(testItemIndex.runIdToVSid.size, 0);
            assert.strictEqual(testItemIndex.vsIdToRunId.size, 0);
        });

        test('registerTestItem adds mappings to all maps', () => {
            const mockTestItem = createMockTestItem('test_file.py::test_example');
            testItemIndex.registerTestItem('run_id_1', 'vs_id_1', mockTestItem);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 1);
            assert.strictEqual(testItemIndex.runIdToVSid.size, 1);
            assert.strictEqual(testItemIndex.vsIdToRunId.size, 1);

            assert.strictEqual(testItemIndex.runIdToTestItem.get('run_id_1'), mockTestItem);
            assert.strictEqual(testItemIndex.runIdToVSid.get('run_id_1'), 'vs_id_1');
            assert.strictEqual(testItemIndex.vsIdToRunId.get('vs_id_1'), 'run_id_1');
        });

        test('clear removes all mappings', () => {
            const mockTestItem = createMockTestItem('test_file.py::test_example');
            testItemIndex.registerTestItem('run_id_1', 'vs_id_1', mockTestItem);
            testItemIndex.registerTestItem('run_id_2', 'vs_id_2', mockTestItem);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 2);

            testItemIndex.clear();

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 0);
            assert.strictEqual(testItemIndex.runIdToVSid.size, 0);
            assert.strictEqual(testItemIndex.vsIdToRunId.size, 0);
        });

        test('getRunId returns correct run ID for VS ID', () => {
            const mockTestItem = createMockTestItem('test_file.py::test_example');
            testItemIndex.registerTestItem('run_id_1', 'vs_id_1', mockTestItem);

            assert.strictEqual(testItemIndex.getRunId('vs_id_1'), 'run_id_1');
            assert.strictEqual(testItemIndex.getRunId('nonexistent'), undefined);
        });

        test('getVSId returns correct VS ID for run ID', () => {
            const mockTestItem = createMockTestItem('test_file.py::test_example');
            testItemIndex.registerTestItem('run_id_1', 'vs_id_1', mockTestItem);

            assert.strictEqual(testItemIndex.getVSId('run_id_1'), 'vs_id_1');
            assert.strictEqual(testItemIndex.getVSId('nonexistent'), undefined);
        });
    });

    suite('getTestItem', () => {
        test('returns TestItem directly from cache when valid', () => {
            const mockTestItem = createMockTestItem('test_id');
            testControllerMock = createMockTestController([mockTestItem]);
            testItemIndex.registerTestItem('run_id_1', 'test_id', mockTestItem);

            const result = testItemIndex.getTestItem('run_id_1', testControllerMock.object);

            assert.strictEqual(result, mockTestItem);
        });

        test('returns undefined when run ID is not registered', () => {
            testControllerMock = createMockTestController([]);

            const result = testItemIndex.getTestItem('nonexistent', testControllerMock.object);

            assert.strictEqual(result, undefined);
        });
    });

    suite('isTestItemValid', () => {
        test('returns true when TestItem is in controller', () => {
            const mockTestItem = createMockTestItem('test_id');
            testControllerMock = createMockTestController([mockTestItem]);

            const result = testItemIndex.isTestItemValid(mockTestItem, testControllerMock.object);

            assert.strictEqual(result, true);
        });

        test('returns false when TestItem is not in controller', () => {
            const mockTestItem = createMockTestItem('test_id');
            testControllerMock = createMockTestController([]); // Empty controller

            const result = testItemIndex.isTestItemValid(mockTestItem, testControllerMock.object);

            assert.strictEqual(result, false);
        });

        test('validates TestItem with parent chain', () => {
            const parentItem = createMockTestItem('parent_id');
            const childItem = createMockTestItem('child_id', parentItem);
            testControllerMock = createMockTestController([parentItem]);

            const result = testItemIndex.isTestItemValid(childItem, testControllerMock.object);

            assert.strictEqual(result, true);
        });
    });

    suite('cleanupStaleReferences', () => {
        test('removes stale references from all maps', () => {
            const validItem = createMockTestItem('valid_id');
            const staleItem = createMockTestItem('stale_id');
            testControllerMock = createMockTestController([validItem]); // Only validItem in controller

            testItemIndex.registerTestItem('run_valid', 'valid_id', validItem);
            testItemIndex.registerTestItem('run_stale', 'stale_id', staleItem);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 2);

            testItemIndex.cleanupStaleReferences(testControllerMock.object);

            // Valid item should remain
            assert.strictEqual(testItemIndex.runIdToTestItem.get('run_valid'), validItem);
            assert.strictEqual(testItemIndex.runIdToVSid.get('run_valid'), 'valid_id');
            assert.strictEqual(testItemIndex.vsIdToRunId.get('valid_id'), 'run_valid');

            // Stale item should be removed
            assert.strictEqual(testItemIndex.runIdToTestItem.get('run_stale'), undefined);
            assert.strictEqual(testItemIndex.runIdToVSid.get('run_stale'), undefined);
            assert.strictEqual(testItemIndex.vsIdToRunId.get('stale_id'), undefined);
        });

        test('does nothing when all references are valid', () => {
            const validItem1 = createMockTestItem('valid_id_1');
            const validItem2 = createMockTestItem('valid_id_2');
            testControllerMock = createMockTestController([validItem1, validItem2]);

            testItemIndex.registerTestItem('run_1', 'valid_id_1', validItem1);
            testItemIndex.registerTestItem('run_2', 'valid_id_2', validItem2);

            testItemIndex.cleanupStaleReferences(testControllerMock.object);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 2);
            assert.strictEqual(testItemIndex.runIdToVSid.size, 2);
            assert.strictEqual(testItemIndex.vsIdToRunId.size, 2);
        });

        test('handles empty index gracefully', () => {
            testControllerMock = createMockTestController([]);

            // Should not throw
            testItemIndex.cleanupStaleReferences(testControllerMock.object);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 0);
        });
    });

    suite('Multiple registrations', () => {
        test('can register multiple test items', () => {
            const mockTestItem1 = createMockTestItem('test_id_1');
            const mockTestItem2 = createMockTestItem('test_id_2');

            testItemIndex.registerTestItem('run_id_1', 'vs_id_1', mockTestItem1);
            testItemIndex.registerTestItem('run_id_2', 'vs_id_2', mockTestItem2);

            assert.strictEqual(testItemIndex.runIdToTestItem.size, 2);
            assert.strictEqual(testItemIndex.runIdToTestItem.get('run_id_1'), mockTestItem1);
            assert.strictEqual(testItemIndex.runIdToTestItem.get('run_id_2'), mockTestItem2);
        });

        test('overwriting a registration updates all maps', () => {
            const mockTestItem1 = createMockTestItem('test_id_1');
            const mockTestItem2 = createMockTestItem('test_id_2');

            testItemIndex.registerTestItem('run_id_1', 'vs_id_1', mockTestItem1);
            testItemIndex.registerTestItem('run_id_1', 'vs_id_2', mockTestItem2);

            // The same run_id now points to different vs_id and TestItem
            assert.strictEqual(testItemIndex.runIdToTestItem.get('run_id_1'), mockTestItem2);
            assert.strictEqual(testItemIndex.runIdToVSid.get('run_id_1'), 'vs_id_2');
        });
    });
});
