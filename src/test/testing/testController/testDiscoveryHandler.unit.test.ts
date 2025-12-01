// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { TestController, Uri, TestItem, CancellationToken, TestItemCollection, MarkdownString } from 'vscode';
import * as typemoq from 'typemoq';
import * as sinon from 'sinon';
import * as assert from 'assert';
import { TestProvider } from '../../../client/testing/types';
import { DiscoveredTestNode, DiscoveredTestPayload } from '../../../client/testing/testController/common/types';
import * as testItemUtilities from '../../../client/testing/testController/common/testItemUtilities';
import * as util from '../../../client/testing/testController/common/utils';
import { TestDiscoveryHandler } from '../../../client/testing/testController/common/testDiscoveryHandler';
import { TestItemIndex } from '../../../client/testing/testController/common/testItemIndex';

suite('TestDiscoveryHandler tests', () => {
    let discoveryHandler: TestDiscoveryHandler;
    let testItemIndex: TestItemIndex;
    let testController: TestController;
    const log: string[] = [];
    let workspaceUri: Uri;
    let testProvider: TestProvider;
    let defaultErrorMessage: string;
    let blankTestItem: TestItem;
    let cancelationToken: CancellationToken;

    setup(() => {
        discoveryHandler = new TestDiscoveryHandler();
        testItemIndex = new TestItemIndex();

        testController = ({
            items: {
                get: () => {
                    log.push('get');
                },
                add: () => {
                    log.push('add');
                },
                replace: () => {
                    log.push('replace');
                },
                delete: () => {
                    log.push('delete');
                },
            },
            dispose: () => {
                // empty
            },
        } as unknown) as TestController;
        defaultErrorMessage = 'pytest test discovery error (see Output > Python)';
        blankTestItem = ({
            canResolveChildren: false,
            tags: [],
            children: {
                add: () => {
                    // empty
                },
            },
        } as unknown) as TestItem;
        cancelationToken = ({
            isCancellationRequested: false,
        } as unknown) as CancellationToken;
    });

    teardown(() => {
        sinon.restore();
    });

    suite('processDiscovery', () => {
        test('calls populate test tree correctly for success payload', async () => {
            testProvider = 'pytest';
            workspaceUri = Uri.file('/foo/bar');
            const tests: DiscoveredTestNode = {
                path: 'path',
                name: 'name',
                type_: 'folder',
                id_: 'id',
                children: [],
            };
            const payload: DiscoveredTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                tests,
            };

            const populateTestTreeStub = sinon.stub(util, 'populateTestTree').returns();

            discoveryHandler.processDiscovery(
                payload,
                testController,
                testItemIndex,
                workspaceUri,
                testProvider,
                cancelationToken,
            );

            sinon.assert.calledOnce(populateTestTreeStub);
            const callArgs = populateTestTreeStub.firstCall.args;
            assert.strictEqual(callArgs[0], testController);
            assert.deepStrictEqual(callArgs[1], tests);
            assert.strictEqual(callArgs[2], undefined);
            assert.ok(callArgs[3].runIdToTestItem instanceof Map);
            assert.strictEqual(callArgs[4], cancelationToken);
        });

        test('creates error node on error status', async () => {
            testProvider = 'pytest';
            workspaceUri = Uri.file('/foo/bar');
            const errorMessage = 'error msg A';
            const expectedErrorMessage = `${defaultErrorMessage}\r\n ${errorMessage}`;

            const payload: DiscoveredTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'error',
                error: [errorMessage],
            };
            const errorTestItemOptions: testItemUtilities.ErrorTestItemOptions = {
                id: 'id',
                label: 'label',
                error: 'error',
            };

            const buildErrorNodeOptionsStub = sinon.stub(util, 'buildErrorNodeOptions').returns(errorTestItemOptions);
            const createErrorTestItemStub = sinon.stub(testItemUtilities, 'createErrorTestItem').returns(blankTestItem);

            discoveryHandler.processDiscovery(
                payload,
                testController,
                testItemIndex,
                workspaceUri,
                testProvider,
                cancelationToken,
            );

            sinon.assert.calledWithMatch(buildErrorNodeOptionsStub, workspaceUri, expectedErrorMessage, testProvider);
            sinon.assert.calledWithMatch(createErrorTestItemStub, sinon.match.any, sinon.match.any);
        });

        test('creates error node and populates test tree when error and tests exist on payload', async () => {
            testProvider = 'pytest';
            workspaceUri = Uri.file('/foo/bar');
            const errorMessage = 'error msg A';
            const expectedErrorMessage = `${defaultErrorMessage}\r\n ${errorMessage}`;

            const tests: DiscoveredTestNode = {
                path: 'path',
                name: 'name',
                type_: 'folder',
                id_: 'id',
                children: [],
            };
            const payload: DiscoveredTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'error',
                error: [errorMessage],
                tests,
            };
            const errorTestItemOptions: testItemUtilities.ErrorTestItemOptions = {
                id: 'id',
                label: 'label',
                error: 'error',
            };

            const buildErrorNodeOptionsStub = sinon.stub(util, 'buildErrorNodeOptions').returns(errorTestItemOptions);
            const createErrorTestItemStub = sinon.stub(testItemUtilities, 'createErrorTestItem').returns(blankTestItem);
            const populateTestTreeStub = sinon.stub(util, 'populateTestTree').returns();

            discoveryHandler.processDiscovery(
                payload,
                testController,
                testItemIndex,
                workspaceUri,
                testProvider,
                cancelationToken,
            );

            // Error node is created
            sinon.assert.calledWithMatch(buildErrorNodeOptionsStub, workspaceUri, expectedErrorMessage, testProvider);
            sinon.assert.calledWithMatch(createErrorTestItemStub, sinon.match.any, sinon.match.any);

            // Test tree is also populated
            sinon.assert.calledOnce(populateTestTreeStub);
        });

        test('clears test item index before populating tree', async () => {
            testProvider = 'pytest';
            workspaceUri = Uri.file('/foo/bar');

            // Pre-populate the index
            testItemIndex.registerTestItem('old_run_id', 'old_vs_id', blankTestItem);
            assert.strictEqual(testItemIndex.runIdToTestItem.size, 1);

            const tests: DiscoveredTestNode = {
                path: 'path',
                name: 'name',
                type_: 'folder',
                id_: 'id',
                children: [],
            };
            const payload: DiscoveredTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'success',
                tests,
            };

            sinon.stub(util, 'populateTestTree').returns();

            discoveryHandler.processDiscovery(
                payload,
                testController,
                testItemIndex,
                workspaceUri,
                testProvider,
                cancelationToken,
            );

            // Index should be cleared
            assert.strictEqual(testItemIndex.runIdToTestItem.size, 0);
        });

        test('handles unittest provider error messages', async () => {
            testProvider = 'unittest';
            workspaceUri = Uri.file('/foo/bar');
            const errorMessage = 'error msg A';

            const payload: DiscoveredTestPayload = {
                cwd: workspaceUri.fsPath,
                status: 'error',
                error: [errorMessage],
            };
            const errorTestItemOptions: testItemUtilities.ErrorTestItemOptions = {
                id: 'id',
                label: 'label',
                error: 'error',
            };

            const buildErrorNodeOptionsStub = sinon.stub(util, 'buildErrorNodeOptions').returns(errorTestItemOptions);
            sinon.stub(testItemUtilities, 'createErrorTestItem').returns(blankTestItem);

            discoveryHandler.processDiscovery(
                payload,
                testController,
                testItemIndex,
                workspaceUri,
                testProvider,
                cancelationToken,
            );

            // Should be called with unittest provider
            sinon.assert.calledWith(buildErrorNodeOptionsStub, workspaceUri, sinon.match.string, 'unittest');
        });
    });

    suite('createErrorNode', () => {
        test('creates error test item correctly', async () => {
            testProvider = 'pytest';
            workspaceUri = Uri.file('/foo/bar');
            const message = 'Test error message';

            const errorTestItemOptions: testItemUtilities.ErrorTestItemOptions = {
                id: `DiscoveryError:${workspaceUri.fsPath}`,
                label: 'pytest Discovery Error [bar]',
                error: message,
            };

            const buildErrorNodeOptionsStub = sinon.stub(util, 'buildErrorNodeOptions').returns(errorTestItemOptions);
            const createErrorTestItemStub = sinon.stub(testItemUtilities, 'createErrorTestItem').returns(blankTestItem);

            const result = discoveryHandler.createErrorNode(testController, workspaceUri, message, testProvider);

            sinon.assert.calledWithMatch(buildErrorNodeOptionsStub, workspaceUri, message, testProvider);
            sinon.assert.calledWithMatch(createErrorTestItemStub, testController, errorTestItemOptions);
            assert.strictEqual(result, blankTestItem);
        });
    });
});
