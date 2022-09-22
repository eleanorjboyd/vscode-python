// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as path from 'path';
import * as util from 'util';
import {
    CancellationToken,
    Position,
    Range,
    TestController,
    TestItem,
    TestMessage,
    TestRun,
    Uri,
    Location,
} from 'vscode';
import { IPythonExecutionFactory } from '../../common/process/types';
import { createDeferred, Deferred } from '../../common/utils/async';
import { Testing } from '../../common/utils/localize';
import { traceError } from '../../logging';
import { sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { TestProvider } from '../types';
import {
    createErrorTestItem,
    DebugTestTag,
    ErrorTestItemOptions,
    getTestCaseNodes,
    RunTestTag,
} from './common/testItemUtilities';
import {
    DiscoveredTestItem,
    DiscoveredTestNode,
    DiscoveredTestType,
    ITestDiscoveryAdapter,
    ITestExecutionAdapter,
} from './common/types';
import { fixLogLines } from './common/utils';

/**
 * This class exposes a test-provider-agnostic way of discovering tests.
 *
 * It gets instantiated by the `PythonTestController` class in charge of reflecting test data in the UI,
 * and then instantiates provider-specific adapters under the hood depending on settings.
 *
 * This class formats the JSON test data returned by the `[Unittest|Pytest]TestDiscoveryAdapter` into test UI elements,
 * and uses them to insert/update/remove items in the `TestController` instance behind the testing UI whenever the `PythonTestController` requests a refresh.
 */
export class WorkspaceTestAdapter {
    private discovering: Deferred<void> | undefined;

    private executing: Deferred<void> | undefined;

    runIdToTestItem: Map<string, TestItem>;

    runIdToVSid: Map<string, string>;

    vsIdToRunId: Map<string, string>;

    constructor(
        private testProvider: TestProvider,
        private discoveryAdapter: ITestDiscoveryAdapter,
        private executionAdapter: ITestExecutionAdapter,
        private workspaceUri: Uri,
    ) {
        this.runIdToTestItem = new Map<string, TestItem>();
        this.runIdToVSid = new Map<string, string>();
        this.vsIdToRunId = new Map<string, string>();
    }

    public async executeTests(
        testController: TestController,
        runInstance: TestRun,
        includes: TestItem[],
        token?: CancellationToken,
        debugBool?: boolean,
    ): Promise<void> {
        if (this.executing) {
            return this.executing.promise;
        }

        const deferred = createDeferred<void>();
        this.executing = deferred;

        let rawTestExecData;
        const testCaseNodes: TestItem[] = [];
        const testCaseIds: string[] = [];
        try {
            // first fetch all the individual test Items that we necessarily want
            includes.forEach((t) => {
                const nodes = getTestCaseNodes(t);
                testCaseNodes.push(...nodes);
            });
            // iterate through testItems nodes and fetch their unittest runID to pass in as argument
            testCaseNodes.forEach((node) => {
                runInstance.started(node); // do the vscode ui test item start here before runtest
                const runId = this.vsIdToRunId.get(node.id);
                if (runId) {
                    testCaseIds.push(runId);
                }
            });

            // need to get the testItems runIds so that we can pass in here.
            rawTestExecData = await this.executionAdapter.runTests(this.workspaceUri, testCaseIds, debugBool);
            deferred.resolve();
        } catch (ex) {
            // handle token and telemetry here
            sendTelemetryEvent(EventName.UNITTEST_RUN_ALL_FAILED, undefined);

            const cancel = token?.isCancellationRequested
                ? Testing.cancelUnittestExecution
                : Testing.errorUnittestExecution;
            traceError(`${cancel}\r\n`, ex);

            // Also report on the test view
            const message = util.format(`${cancel} ${Testing.seePythonOutput}\r\n`, ex);
            const options = buildErrorNodeOptions(this.workspaceUri, message);
            const errorNode = createErrorTestItem(testController, options);
            testController.items.add(errorNode);

            deferred.reject(ex as Error);
        } finally {
            this.executing = undefined;
        }

        if (rawTestExecData !== undefined && rawTestExecData.result !== undefined) {
            for (const keyTemp of Object.keys(rawTestExecData.result)) {
                // check for result and update the UI accordingly.
                const testCases: TestItem[] = [];

                // grab leaf level test items
                testController.items.forEach((i) => {
                    const tempArr: TestItem[] = getTestCaseNodes(i);
                    testCases.push(...tempArr);
                });

                if (
                    rawTestExecData.result[keyTemp].outcome === 'failure' ||
                    rawTestExecData.result[keyTemp].outcome === 'subtest-failure' ||
                    rawTestExecData.result[keyTemp].outcome === 'passed-unexpected'
                ) {
                    const traceback = rawTestExecData.result[keyTemp].traceback
                        ? rawTestExecData.result[keyTemp]
                              .traceback!.splitLines({ trim: false, removeEmptyEntries: true })
                              .join('\r\n')
                        : '';
                    const text = `${rawTestExecData.result[keyTemp].test} failed: ${
                        rawTestExecData.result[keyTemp].message ?? rawTestExecData.result[keyTemp].outcome
                    }\r\n${traceback}\r\n`;
                    const message = new TestMessage(text);

                    // note that keyTemp is a runId for unittest library...
                    const grabVSid = this.runIdToVSid.get(keyTemp);
                    // search through freshly built array of testItem to find the failed test and update UI.
                    testCases.forEach((indiItem) => {
                        if (indiItem.id === grabVSid) {
                            if (indiItem.uri && indiItem.range) {
                                message.location = new Location(indiItem.uri, indiItem.range);
                                runInstance.failed(indiItem, message);
                                runInstance.appendOutput(fixLogLines(text));
                            }
                        }
                    });
                } else if (
                    rawTestExecData.result[keyTemp].outcome === 'success' ||
                    rawTestExecData.result[keyTemp].outcome === 'expected-failure' ||
                    rawTestExecData.result[keyTemp].outcome === 'subtest-passed'
                ) {
                    const grabTestItem = this.runIdToTestItem.get(keyTemp);
                    const grabVSid = this.runIdToVSid.get(keyTemp);
                    if (grabTestItem !== undefined) {
                        testCases.forEach((indiItem) => {
                            if (indiItem.id === grabVSid) {
                                if (indiItem.uri && indiItem.range) {
                                    runInstance.passed(grabTestItem);
                                    runInstance.appendOutput('Passed here');
                                }
                            }
                        });
                    }
                } else if (rawTestExecData.result[keyTemp].outcome === 'skipped') {
                    const grabTestItem = this.runIdToTestItem.get(keyTemp);
                    const grabVSid = this.runIdToVSid.get(keyTemp);
                    if (grabTestItem !== undefined) {
                        testCases.forEach((indiItem) => {
                            if (indiItem.id === grabVSid) {
                                if (indiItem.uri && indiItem.range) {
                                    runInstance.skipped(grabTestItem);
                                    runInstance.appendOutput('Skipped here');
                                }
                            }
                        });
                    }
                }
            }
        }
        return Promise.resolve();
    }

    public async discoverTests(
        testController: TestController,
        token?: CancellationToken,
        isMultiroot?: boolean,
        workspaceFilePath?: string,
        executionFactory?: IPythonExecutionFactory,
    ): Promise<void> {
        sendTelemetryEvent(EventName.UNITTEST_DISCOVERING, undefined, { tool: this.testProvider });

        const workspacePath = this.workspaceUri.fsPath;

        // Discovery is expensive. If it is already running, use the existing promise.
        if (this.discovering) {
            return this.discovering.promise;
        }

        const deferred = createDeferred<void>();
        this.discovering = deferred;

        let rawTestData;
        try {
            if (executionFactory !== undefined) {
                rawTestData = await this.discoveryAdapter.discoverTests(this.workspaceUri, executionFactory);
                console.debug('here');
                console.debug('rawTestData: ', rawTestData);
            } else {
                console.log('executionFactory is undefined');
            }

            deferred.resolve();
        } catch (ex) {
            sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_DONE, undefined, { tool: this.testProvider, failed: true });

            const cancel = token?.isCancellationRequested
                ? Testing.cancelUnittestDiscovery
                : Testing.errorUnittestDiscovery;

            traceError(`${cancel}\r\n`, ex);

            // Report also on the test view.
            const message = util.format(`${cancel} ${Testing.seePythonOutput}\r\n`, ex);
            const options = buildErrorNodeOptions(this.workspaceUri, message);
            const errorNode = createErrorTestItem(testController, options);
            testController.items.add(errorNode);

            deferred.reject(ex as Error);
        } finally {
            // Discovery has finished running, we have the data,
            // we don't need the deferred promise anymore.
            this.discovering = undefined;
        }

        if (!rawTestData) {
            // No test data is available
            return Promise.resolve();
        }

        // Check if there were any errors in the discovery process.
        if (rawTestData.status === 'error') {
            const { errors } = rawTestData;
            traceError(Testing.errorUnittestDiscovery, '\r\n', errors!.join('\r\n\r\n'));

            let errorNode = testController.items.get(`DiscoveryError:${workspacePath}`);
            const message = util.format(
                `${Testing.errorUnittestDiscovery} ${Testing.seePythonOutput}\r\n`,
                errors!.join('\r\n\r\n'),
            );

            if (errorNode === undefined) {
                const options = buildErrorNodeOptions(this.workspaceUri, message);
                errorNode = createErrorTestItem(testController, options);
                testController.items.add(errorNode);
            }
            errorNode.error = message;
        } else {
            // Remove the error node if necessary,
            // then parse and insert test data.
            testController.items.delete(`DiscoveryError:${workspacePath}`);

            // Wrap the data under a root node named after the test provider.
            const wrappedTests = rawTestData.tests;

            // If we are in a multiroot workspace scenario, wrap the current folder's test result in a tree under the overall root + the current folder name.
            let rootPath = workspacePath;
            let childrenRootPath = rootPath;
            let childrenRootName = path.basename(rootPath);

            if (isMultiroot) {
                rootPath = workspaceFilePath!;
                childrenRootPath = workspacePath;
                childrenRootName = path.basename(workspacePath);
            }

            const children = [
                {
                    path: childrenRootPath,
                    name: childrenRootName,
                    type_: 'folder' as DiscoveredTestType,
                    id_: childrenRootPath,
                    children: wrappedTests ? [wrappedTests] : [],
                },
            ];

            // Update the raw test data with the wrapped data.
            rawTestData.tests = {
                path: rootPath,
                name: this.testProvider,
                type_: 'folder',
                id_: rootPath,
                children,
            };

            if (rawTestData.tests) {
                // If the test root for this folder exists: Workspace refresh, update its children.
                // Otherwise, it is a freshly discovered workspace, and we need to create a new test root and populate the test tree.
                populateTestTree(testController, rawTestData.tests, undefined, this, token);
            } else {
                // Delete everything from the test controller.
                testController.items.replace([]);
            }
        }

        sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_DONE, undefined, { tool: this.testProvider, failed: false });
        return Promise.resolve();
    }
}

function isTestItem(test: DiscoveredTestNode | DiscoveredTestItem): test is DiscoveredTestItem {
    return test.type_ === 'test';
}

// had to switch the order of the original parameter since required param cannot follow optional.
function populateTestTree(
    testController: TestController,
    testTreeData: DiscoveredTestNode,
    testRoot: TestItem | undefined,
    wstAdapter: WorkspaceTestAdapter,
    token?: CancellationToken,
): void {
    // If testRoot is undefined, use the info of the root item of testTreeData to create a test item, and append it to the test controller.
    if (!testRoot) {
        testRoot = testController.createTestItem(testTreeData.path, testTreeData.name, Uri.file(testTreeData.path));

        testRoot.canResolveChildren = true;
        testRoot.tags = [RunTestTag, DebugTestTag];

        testController.items.add(testRoot);
    }

    // Recursively populate the tree with test data.
    for (let i = 0; i < testTreeData.children.length; i = i + 1) {
        console.debug('testTreeData.children i= ', i, '', testTreeData.children[i]);
    }

    testTreeData.children.forEach((child) => {
        if (!token?.isCancellationRequested) {
            if (isTestItem(child)) {
                const testItem = testController.createTestItem(child.id_, child.name, Uri.file(child.path));
                testItem.tags = [RunTestTag, DebugTestTag];

                const range = new Range(
                    new Position(Number(child.lineno) - 1, 0),
                    new Position(Number(child.lineno), 0),
                );
                testItem.canResolveChildren = false;
                testItem.range = range;
                testItem.tags = [RunTestTag, DebugTestTag];
                testRoot!.children.add(testItem);
                // add to our map
                wstAdapter.runIdToTestItem.set(child.runID, testItem);
                wstAdapter.runIdToVSid.set(child.runID, child.id_);
                wstAdapter.vsIdToRunId.set(child.id_, child.runID);
            } else {
                let node = testController.items.get(child.path);

                if (!node) {
                    node = testController.createTestItem(child.id_, child.name, Uri.file(child.path));

                    node.canResolveChildren = true;
                    node.tags = [RunTestTag, DebugTestTag];

                    testRoot!.children.add(node);
                }
                populateTestTree(testController, child, node, wstAdapter, token);
            }
        }
    });
}

function buildErrorNodeOptions(uri: Uri, message: string): ErrorTestItemOptions {
    return {
        id: `DiscoveryError:${uri.fsPath}`,
        label: `Unittest Discovery Error [${path.basename(uri.fsPath)}]`,
        error: message,
    };
}
