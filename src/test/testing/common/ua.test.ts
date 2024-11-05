/* eslint-disable @typescript-eslint/no-explicit-any */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { TestController, TestRun, TestRunProfileKind, Uri } from 'vscode';
import * as typeMoq from 'typemoq';
import * as path from 'path';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { ITestController, ITestResultResolver } from '../../../client/testing/testController/common/types';
import { IPythonExecutionFactory } from '../../../client/common/process/types';
import { IConfigurationService, ITestOutputChannel } from '../../../client/common/types';
import { IServiceContainer } from '../../../client/ioc/types';
import { EXTENSION_ROOT_DIR_FOR_TESTS, initialize } from '../../initialize';
import {traceLog } from '../../../client/logging';
import { UnittestTestExecutionAdapter } from '../../../client/testing/testController/unittest/testExecutionAdapter';
import { PythonResultResolver } from '../../../client/testing/testController/common/resultResolver';
import { TestProvider } from '../../../client/testing/types';
import { UNITTEST_PROVIDER } from '../../../client/testing/common/constants';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import { createTypeMoq } from '../../mocks/helper';
import * as pixi from '../../../client/pythonEnvironments/common/environmentManagers/pixi';

suite('End to End Tests: the broken one', () => {
    let resultResolver: ITestResultResolver;
    let pythonExecFactory: IPythonExecutionFactory;
    let configService: IConfigurationService;
    let serviceContainer: IServiceContainer;
    let envVarsService: IEnvironmentVariablesProvider;
    let workspaceUri: Uri;
    let testOutputChannel: typeMoq.IMock<ITestOutputChannel>;
    let testController: TestController;
    let getPixiStub: sinon.SinonStub;
    const unittestProvider: TestProvider = UNITTEST_PROVIDER;
    const rootPathErrorWorkspace = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'errorWorkspace',
    );
    suiteSetup(async () => {
        serviceContainer = (await initialize()).serviceContainer;
    });

    setup(async () => {
        getPixiStub = sinon.stub(pixi, 'getPixi');
        getPixiStub.resolves(undefined);

        // create objects that were injected
        configService = serviceContainer.get<IConfigurationService>(IConfigurationService);
        pythonExecFactory = serviceContainer.get<IPythonExecutionFactory>(IPythonExecutionFactory);
        pythonExecFactory.createCondaExecutionService = async () => undefined;
        testController = serviceContainer.get<TestController>(ITestController);
        envVarsService = serviceContainer.get<IEnvironmentVariablesProvider>(IEnvironmentVariablesProvider);

        // create objects that were not injected

        testOutputChannel = createTypeMoq<ITestOutputChannel>();
        testOutputChannel
            .setup((x) => x.append(typeMoq.It.isAny()))
            .callback((appendVal: any) => {
                traceLog('output channel - ', appendVal.toString());
            })
            .returns(() => {
                // Whatever you need to return
            });
        testOutputChannel
            .setup((x) => x.appendLine(typeMoq.It.isAny()))
            .callback((appendVal: any) => {
                traceLog('output channel ', appendVal.toString());
            })
            .returns(() => {
                // Whatever you need to return
            });
    });
    teardown(() => {
        sinon.restore();
    });
    suiteTeardown(async () => {
        sinon.restore();
        sinon.reset();
        sinon.resetBehavior();
    });
    test('unittest execution adapter seg fault error handling', async () => {
        resultResolver = new PythonResultResolver(testController, unittestProvider, workspaceUri);
        let callCount = 0;
        let failureOccurred = false;
        let failureMsg = '';
        resultResolver._resolveExecution = async (data, _token?) => {
            // do the following asserts for each time resolveExecution is called, should be called once per test.
            callCount = callCount + 1;
            traceLog(`unittest execution adapter seg fault error handling \n  ${JSON.stringify(data)}`);
            try {
                if (data.status === 'error') {
                    if (data.error === undefined) {
                        // Dereference a NULL pointer
                        const indexOfTest = JSON.stringify(data).search('Dereference a NULL pointer');
                        if (indexOfTest === -1) {
                            failureOccurred = true;
                            failureMsg = 'Expected test to have a null pointer';
                        }
                    } else if (data.error.length === 0) {
                        failureOccurred = true;
                        failureMsg = "Expected errors in 'error' field";
                    }
                } else {
                    const indexOfTest = JSON.stringify(data.result).search('error');
                    if (indexOfTest === -1) {
                        failureOccurred = true;
                        failureMsg =
                            'If payload status is not error then the individual tests should be marked as errors. This should occur on windows machines.';
                    }
                }
                if (data.result === undefined) {
                    failureOccurred = true;
                    failureMsg = 'Expected results to be present';
                }
                // make sure the testID is found in the results
                const indexOfTest = JSON.stringify(data).search('test_seg_fault.TestSegmentationFault.test_segfault');
                if (indexOfTest === -1) {
                    failureOccurred = true;
                    failureMsg = 'Expected testId to be present';
                }
            } catch (err) {
                failureMsg = err ? (err as Error).toString() : '';
                failureOccurred = true;
            }
            return Promise.resolve();
        };

        const testId = `test_seg_fault.TestSegmentationFault.test_segfault`;
        const testIds: string[] = [testId];

        // set workspace to test workspace folder
        workspaceUri = Uri.parse(rootPathErrorWorkspace);
        configService.getSettings(workspaceUri).testing.unittestArgs = ['-s', '.', '-p', '*test*.py'];

        // run pytest execution
        const executionAdapter = new UnittestTestExecutionAdapter(
            configService,
            testOutputChannel.object,
            resultResolver,
            envVarsService,
        );
        const testRun = typeMoq.Mock.ofType<TestRun>();
        testRun
            .setup((t) => t.token)
            .returns(
                () =>
                    ({
                        onCancellationRequested: () => undefined,
                    } as any),
            );
        await executionAdapter
            .runTests(workspaceUri, testIds, TestRunProfileKind.Run, testRun.object, pythonExecFactory)
            .finally(() => {
                assert.strictEqual(callCount, 1, 'Expected _resolveExecution to be called once');
                assert.strictEqual(failureOccurred, false, failureMsg);
            });
    });
});
