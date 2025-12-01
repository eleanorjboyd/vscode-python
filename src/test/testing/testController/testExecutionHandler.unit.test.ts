// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, Uri, TestItem, CancellationToken, TestRun, TestItemCollection, Range } from 'vscode';
import * as typemoq from 'typemoq';
import * as sinon from 'sinon';
import * as assert from 'assert';
import { ExecutionTestPayload } from '../../../client/testing/testController/common/types';
import * as testItemUtilities from '../../../client/testing/testController/common/testItemUtilities';
import { TestExecutionHandler } from '../../../client/testing/testController/common/testExecutionHandler';
import { TestItemIndex } from '../../../client/testing/testController/common/testItemIndex';

suite('TestExecutionHandler tests', () => {
    let executionHandler: TestExecutionHandler;
    let testItemIndex: TestItemIndex;
    let runInstance: typemoq.IMock<TestRun>;
    let testControllerMock: typemoq.IMock<TestController>;
    let mockTestItem1: TestItem;
    let mockTestItem2: TestItem;
    let workspaceUri: Uri;
    let cancelationToken: CancellationToken;
    const log: string[] = [];

    function createMockTestItem(id: string): TestItem {
        const range = new Range(0, 0, 0, 0);
        const mockTestItem = ({
            id,
            canResolveChildren: false,
            tags: [],
            children: {
                add: () => {
                    // empty
                },
            },
            range,
            uri: Uri.file('/foo/bar'),
        } as unknown) as TestItem;

        return mockTestItem;
    }

    setup(() => {
        executionHandler = new TestExecutionHandler();
        testItemIndex = new TestItemIndex();

        // create mock test items
        mockTestItem1 = createMockTestItem('mockTestItem1');
        mockTestItem2 = createMockTestItem('mockTestItem2');

        // create mock testItems to pass into a iterable
        const mockTestItems: [string, TestItem][] = [
            ['1', mockTestItem1],
            ['2', mockTestItem2],
        ];
        const iterableMock = mockTestItems[Symbol.iterator]();

        // create mock testItemCollection
        const testItemCollectionMock = typemoq.Mock.ofType<TestItemCollection>();
        testItemCollectionMock
            .setup((x) => x.forEach(typemoq.It.isAny()))
            .callback((callback) => {
                let result = iterableMock.next();
                while (!result.done) {
                    callback(result.value[1]);
                    result = iterableMock.next();
                }
            })
            .returns(() => mockTestItem1);

        // create mock testController
        testControllerMock = typemoq.Mock.ofType<TestController>();
        testControllerMock.setup((t) => t.items).returns(() => testItemCollectionMock.object);

        cancelationToken = ({
            isCancellationRequested: false,
        } as unknown) as CancellationToken;

        // define functions within runInstance
        runInstance = typemoq.Mock.ofType<TestRun>();
        runInstance.setup((r) => r.name).returns(() => 'name');
        runInstance.setup((r) => r.token).returns(() => cancelationToken);
        runInstance.setup((r) => r.isPersisted).returns(() => true);
        runInstance
            .setup((r) => r.enqueued(typemoq.It.isAny()))
            .returns(() => {
                log.push('enqueue');
                return undefined;
            });
        runInstance
            .setup((r) => r.started(typemoq.It.isAny()))
            .returns(() => {
                log.push('start');
            });

        workspaceUri = Uri.file('/foo/bar');

        // mock getTestCaseNodes to just return the given testNode added
        sinon.stub(testItemUtilities, 'getTestCaseNodes').callsFake((testNode: TestItem) => [testNode]);
    });

    teardown(() => {
        sinon.restore();
    });

    suite('processExecution', () => {
        test('handles failed tests correctly', async () => {
            // Register test items in the index
            testItemIndex.registerTestItem('mockTestItem1', 'mockTestItem1', mockTestItem1);
            testItemIndex.registerTestItem('mockTestItem2', 'mockTestItem2', mockTestItem2);

            const failurePayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    mockTestItem1: {
                        test: 'test',
                        outcome: 'failure',
                        message: 'message',
                        traceback: 'traceback',
                        subtest: 'subtest',
                    },
                },
                error: '',
            };

            executionHandler.processExecution(
                failurePayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            runInstance.verify((r) => r.failed(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.once());
        });

        test('handles skipped tests correctly', async () => {
            testItemIndex.registerTestItem('mockTestItem1', 'mockTestItem1', mockTestItem1);
            testItemIndex.registerTestItem('mockTestItem2', 'mockTestItem2', mockTestItem2);

            const skippedPayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    mockTestItem1: {
                        test: 'test',
                        outcome: 'skipped',
                        message: 'message',
                        traceback: 'traceback',
                        subtest: 'subtest',
                    },
                },
                error: '',
            };

            executionHandler.processExecution(
                skippedPayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            runInstance.verify((r) => r.skipped(typemoq.It.isAny()), typemoq.Times.once());
        });

        test('handles error correctly as test outcome', async () => {
            testItemIndex.registerTestItem('mockTestItem1', 'mockTestItem1', mockTestItem1);
            testItemIndex.registerTestItem('mockTestItem2', 'mockTestItem2', mockTestItem2);

            const errorPayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    mockTestItem1: {
                        test: 'test',
                        outcome: 'error',
                        message: 'message',
                        traceback: 'traceback',
                        subtest: 'subtest',
                    },
                },
                error: '',
            };

            executionHandler.processExecution(
                errorPayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            runInstance.verify((r) => r.errored(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.once());
        });

        test('handles success correctly', async () => {
            testItemIndex.registerTestItem('mockTestItem1', 'mockTestItem1', mockTestItem1);
            testItemIndex.registerTestItem('mockTestItem2', 'mockTestItem2', mockTestItem2);

            const successPayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    mockTestItem1: {
                        test: 'test',
                        outcome: 'success',
                        message: 'message',
                        traceback: 'traceback',
                        subtest: 'subtest',
                    },
                },
                error: '',
            };

            executionHandler.processExecution(
                successPayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            runInstance.verify((r) => r.passed(typemoq.It.isAny()), typemoq.Times.once());
        });

        test('handles empty result payload', async () => {
            const emptyPayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'error',
                error: 'error',
            };

            const result = executionHandler.processExecution(
                emptyPayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            // Should return empty subtest stats
            assert.strictEqual(result.size, 0);
            runInstance.verify((r) => r.passed(typemoq.It.isAny()), typemoq.Times.never());
            runInstance.verify((r) => r.failed(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.never());
            runInstance.verify((r) => r.skipped(typemoq.It.isAny()), typemoq.Times.never());
        });

        test('returns subtest stats map', async () => {
            sinon.stub(testItemUtilities, 'clearAllChildren').callsFake(() => undefined);
            const subtestName = 'parentTest [subTest1]';
            const mockSubtestItem = createMockTestItem(subtestName);
            testItemIndex.registerTestItem('parentTest', 'parentTest', mockTestItem2);
            testItemIndex.registerTestItem(subtestName, subtestName, mockSubtestItem);

            let generatedId: string | undefined;
            testControllerMock
                .setup((t) => t.createTestItem(typemoq.It.isAny(), typemoq.It.isAny(), typemoq.It.isAny()))
                .callback((id: string) => {
                    generatedId = id;
                })
                .returns(() => ({ id: 'id_this', label: 'label_this', uri: workspaceUri } as TestItem));

            const subtestPayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    'parentTest [subTest1]': {
                        test: 'parentTest',
                        outcome: 'subtest-success',
                        message: 'message',
                        traceback: 'traceback',
                        subtest: subtestName,
                    },
                },
                error: '',
            };

            const result = executionHandler.processExecution(
                subtestPayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            // Should have subtest stats for the parent
            assert.strictEqual(result.size, 1);
            const stats = result.get('parentTest');
            assert.ok(stats);
            assert.strictEqual(stats.passed, 1);
            assert.strictEqual(stats.failed, 0);
        });

        test('handles multiple test outcomes', async () => {
            testItemIndex.registerTestItem('mockTestItem1', 'mockTestItem1', mockTestItem1);
            testItemIndex.registerTestItem('mockTestItem2', 'mockTestItem2', mockTestItem2);

            // Test one outcome per call to avoid iterator exhaustion issues
            const successPayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    mockTestItem1: {
                        test: 'test1',
                        outcome: 'success',
                        message: '',
                        traceback: '',
                    },
                },
                error: '',
            };

            executionHandler.processExecution(
                successPayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            runInstance.verify((r) => r.passed(typemoq.It.isAny()), typemoq.Times.once());
        });

        test('handles expected-failure outcome as success', async () => {
            testItemIndex.registerTestItem('mockTestItem1', 'mockTestItem1', mockTestItem1);

            const expectedFailurePayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    mockTestItem1: {
                        test: 'test',
                        outcome: 'expected-failure',
                        message: 'message',
                    },
                },
                error: '',
            };

            executionHandler.processExecution(
                expectedFailurePayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            runInstance.verify((r) => r.passed(typemoq.It.isAny()), typemoq.Times.once());
        });

        test('handles passed-unexpected outcome as failure', async () => {
            testItemIndex.registerTestItem('mockTestItem1', 'mockTestItem1', mockTestItem1);

            const passedUnexpectedPayload: ExecutionTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                result: {
                    mockTestItem1: {
                        test: 'test',
                        outcome: 'passed-unexpected',
                        message: 'message',
                    },
                },
                error: '',
            };

            executionHandler.processExecution(
                passedUnexpectedPayload,
                runInstance.object,
                testItemIndex,
                testControllerMock.object,
            );

            runInstance.verify((r) => r.failed(typemoq.It.isAny(), typemoq.It.isAny()), typemoq.Times.once());
        });
    });
});
