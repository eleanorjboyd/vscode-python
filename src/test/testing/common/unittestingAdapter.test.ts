/* eslint-disable @typescript-eslint/no-explicit-any */
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { TestController, TestRun, TestRunProfileKind, Uri } from 'vscode';
import * as typeMoq from 'typemoq';
import * as path from 'path';
import * as assert from 'assert';
import * as fs from 'fs';
import * as sinon from 'sinon';
import { ITestController, ITestResultResolver } from '../../../client/testing/testController/common/types';
import { IPythonExecutionFactory } from '../../../client/common/process/types';
import { IConfigurationService, ITestOutputChannel } from '../../../client/common/types';
import { IServiceContainer } from '../../../client/ioc/types';
import { EXTENSION_ROOT_DIR_FOR_TESTS, initialize } from '../../initialize';
import { traceError, traceLog } from '../../../client/logging';
import { UnittestTestDiscoveryAdapter } from '../../../client/testing/testController/unittest/testDiscoveryAdapter';
import { UnittestTestExecutionAdapter } from '../../../client/testing/testController/unittest/testExecutionAdapter';
import { PythonResultResolver } from '../../../client/testing/testController/common/resultResolver';
import { TestProvider } from '../../../client/testing/types';
import { UNITTEST_PROVIDER } from '../../../client/testing/common/constants';
import { IEnvironmentVariablesProvider } from '../../../client/common/variables/types';
import { createTypeMoq } from '../../mocks/helper';
import * as pixi from '../../../client/pythonEnvironments/common/environmentManagers/pixi';

suite('End to End Tests: unittest adapters', () => {
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
    const rootPathSmallWorkspace = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'smallWorkspace',
    );
    const rootPathLargeWorkspace = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'largeWorkspace',
    );
    const rootPathErrorWorkspace = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'errorWorkspace',
    );
    const rootPathDiscoveryErrorWorkspace = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'discoveryErrorWorkspace',
    );
    const rootPathDiscoverySymlink = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'symlinkWorkspace',
    );
    const nestedTarget = path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src', 'testTestingRootWkspc', 'target workspace');
    const nestedSymlink = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'symlink_parent-folder',
    );
    const rootPathCoverageWorkspace = path.join(
        EXTENSION_ROOT_DIR_FOR_TESTS,
        'src',
        'testTestingRootWkspc',
        'coverageWorkspace',
    );
    suiteSetup(async () => {
        // create symlink for specific symlink test
        const target = rootPathSmallWorkspace;
        const dest = rootPathDiscoverySymlink;
        serviceContainer = (await initialize()).serviceContainer;
        try {
            fs.symlink(target, dest, 'dir', (err) => {
                if (err) {
                    traceError(err);
                } else {
                    traceLog('Symlink created successfully for regular symlink end to end tests.');
                }
            });
            fs.symlink(nestedTarget, nestedSymlink, 'dir', (err) => {
                if (err) {
                    traceError(err);
                } else {
                    traceLog('Symlink created successfully for nested symlink end to end tests.');
                }
            });
        } catch (err) {
            traceError(err);
        }
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
        // remove symlink
        const dest = rootPathDiscoverySymlink;
        if (fs.existsSync(dest)) {
            fs.unlink(dest, (err) => {
                if (err) {
                    traceError(err);
                } else {
                    traceLog('Symlink removed successfully after tests, rootPathDiscoverySymlink.');
                }
            });
        } else {
            traceLog('Symlink was not found to remove after tests, exiting successfully, rootPathDiscoverySymlink.');
        }

        if (fs.existsSync(nestedSymlink)) {
            fs.unlink(nestedSymlink, (err) => {
                if (err) {
                    traceError(err);
                } else {
                    traceLog('Symlink removed successfully after tests, nestedSymlink.');
                }
            });
        } else {
            traceLog('Symlink was not found to remove after tests, exiting successfully, nestedSymlink.');
        }
    });

    test('unittest discovery adapter small workspace', async () => {
        // result resolver and saved data for assertions
        let actualData: {
            cwd: string;
            tests?: unknown;
            status: 'success' | 'error';
            error?: string[];
        };
        workspaceUri = Uri.parse(rootPathSmallWorkspace);
        resultResolver = new PythonResultResolver(testController, unittestProvider, workspaceUri);
        let callCount = 0;
        // const deferredTillEOT = createTestingDeferred();
        resultResolver._resolveDiscovery = async (payload, _token?) => {
            traceLog(`resolveDiscovery ${payload}`);
            callCount = callCount + 1;
            actualData = payload;
            return Promise.resolve();
        };

        // set workspace to test workspace folder and set up settings

        configService.getSettings(workspaceUri).testing.unittestArgs = ['-s', '.', '-p', '*test*.py'];

        // run unittest discovery
        const discoveryAdapter = new UnittestTestDiscoveryAdapter(
            configService,
            testOutputChannel.object,
            resultResolver,
            envVarsService,
        );

        await discoveryAdapter.discoverTests(workspaceUri, pythonExecFactory).finally(() => {
            // verification after discovery is complete

            // 1. Check the status is "success"
            assert.strictEqual(
                actualData.status,
                'success',
                `Expected status to be 'success' instead status is ${actualData.status}`,
            );
            // 2. Confirm no errors
            assert.strictEqual(actualData.error, undefined, "Expected no errors in 'error' field");
            // 3. Confirm tests are found
            assert.ok(actualData.tests, 'Expected tests to be present');

            assert.strictEqual(callCount, 1, 'Expected _resolveDiscovery to be called once');
        });
    });
    test('unittest discovery adapter large workspace', async () => {
        // result resolver and saved data for assertions
        let actualData: {
            cwd: string;
            tests?: unknown;
            status: 'success' | 'error';
            error?: string[];
        };
        resultResolver = new PythonResultResolver(testController, unittestProvider, workspaceUri);
        let callCount = 0;
        resultResolver._resolveDiscovery = async (payload, _token?) => {
            traceLog(`resolveDiscovery ${payload}`);
            callCount = callCount + 1;
            actualData = payload;
            return Promise.resolve();
        };

        // set settings to work for the given workspace
        workspaceUri = Uri.parse(rootPathLargeWorkspace);
        configService.getSettings(workspaceUri).testing.unittestArgs = ['-s', '.', '-p', '*test*.py'];
        // run discovery
        const discoveryAdapter = new UnittestTestDiscoveryAdapter(
            configService,
            testOutputChannel.object,
            resultResolver,
            envVarsService,
        );

        await discoveryAdapter.discoverTests(workspaceUri, pythonExecFactory).finally(() => {
            // 1. Check the status is "success"
            assert.strictEqual(
                actualData.status,
                'success',
                `Expected status to be 'success' instead status is ${actualData.status}`,
            );
            // 2. Confirm no errors
            assert.strictEqual(actualData.error, undefined, "Expected no errors in 'error' field");
            // 3. Confirm tests are found
            assert.ok(actualData.tests, 'Expected tests to be present');

            assert.strictEqual(callCount, 1, 'Expected _resolveDiscovery to be called once');
        });
    });
    test('unittest execution adapter small workspace with correct output', async () => {
        // result resolver and saved data for assertions
        resultResolver = new PythonResultResolver(testController, unittestProvider, workspaceUri);
        let callCount = 0;
        let failureOccurred = false;
        let failureMsg = '';
        resultResolver._resolveExecution = async (payload, _token?) => {
            traceLog(`resolveDiscovery ${payload}`);
            callCount = callCount + 1;
            // the payloads that get to the _resolveExecution are all data and should be successful.
            try {
                assert.strictEqual(
                    payload.status,
                    'success',
                    `Expected status to be 'success', instead status is ${payload.status}`,
                );
                assert.ok(payload.result, 'Expected results to be present');
            } catch (err) {
                failureMsg = err ? (err as Error).toString() : '';
                failureOccurred = true;
            }
            return Promise.resolve();
        };

        // set workspace to test workspace folder
        workspaceUri = Uri.parse(rootPathSmallWorkspace);
        configService.getSettings(workspaceUri).testing.unittestArgs = ['-s', '.', '-p', '*test*.py'];
        // run execution
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
        let collectedOutput = '';
        testRun
            .setup((t) => t.appendOutput(typeMoq.It.isAny()))
            .callback((output: string) => {
                collectedOutput += output;
                traceLog('appendOutput was called with:', output);
            })
            .returns(() => false);
        await executionAdapter
            .runTests(
                workspaceUri,
                ['test_simple.SimpleClass.test_simple_unit'],
                TestRunProfileKind.Run,
                testRun.object,
                pythonExecFactory,
            )
            .finally(() => {
                // verify that the _resolveExecution was called once per test
                assert.strictEqual(callCount, 1, 'Expected _resolveExecution to be called once');
                assert.strictEqual(failureOccurred, false, failureMsg);

                // verify output works for stdout and stderr as well as unittest output
                assert.ok(
                    collectedOutput.includes('expected printed output, stdout'),
                    'The test string does not contain the expected stdout output.',
                );
                assert.ok(
                    collectedOutput.includes('expected printed output, stderr'),
                    'The test string does not contain the expected stderr output.',
                );
                assert.ok(
                    collectedOutput.includes('Ran 1 test in'),
                    'The test string does not contain the expected unittest output.',
                );
            });
    });
    test('unittest execution adapter large workspace', async () => {
        // result resolver and saved data for assertions
        resultResolver = new PythonResultResolver(testController, unittestProvider, workspaceUri);
        let callCount = 0;
        let failureOccurred = false;
        let failureMsg = '';
        resultResolver._resolveExecution = async (payload, _token?) => {
            traceLog(`resolveDiscovery ${payload}`);
            callCount = callCount + 1;
            // the payloads that get to the _resolveExecution are all data and should be successful.
            try {
                const validStatuses = ['subtest-success', 'subtest-failure'];
                assert.ok(
                    validStatuses.includes(payload.status),
                    `Expected status to be one of ${validStatuses.join(', ')}, but instead status is ${payload.status}`,
                );
                assert.ok(payload.result, 'Expected results to be present');
            } catch (err) {
                failureMsg = err ? (err as Error).toString() : '';
                failureOccurred = true;
            }
            return Promise.resolve();
        };

        // set workspace to test workspace folder
        workspaceUri = Uri.parse(rootPathLargeWorkspace);
        configService.getSettings(workspaceUri).testing.unittestArgs = ['-s', '.', '-p', '*test*.py'];

        // run unittest execution
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
        let collectedOutput = '';
        testRun
            .setup((t) => t.appendOutput(typeMoq.It.isAny()))
            .callback((output: string) => {
                collectedOutput += output;
                traceLog('appendOutput was called with:', output);
            })
            .returns(() => false);
        await executionAdapter
            .runTests(
                workspaceUri,
                ['test_parameterized_subtest.NumbersTest.test_even'],
                TestRunProfileKind.Run,
                testRun.object,
                pythonExecFactory,
            )
            .then(() => {
                // verify that the _resolveExecution was called once per test
                assert.strictEqual(callCount, 2000, 'Expected _resolveExecution to be called once');
                assert.strictEqual(failureOccurred, false, failureMsg);

                // verify output
                assert.ok(
                    collectedOutput.includes('test_parameterized_subtest.py'),
                    'The test string does not contain the correct test name which should be printed',
                );
                assert.ok(
                    collectedOutput.includes('FAILED (failures=1000)'),
                    'The test string does not contain the last of the unittest output',
                );
            });
    });
    test('Unittest execution with coverage, small workspace', async () => {
        // result resolver and saved data for assertions
        resultResolver = new PythonResultResolver(testController, unittestProvider, workspaceUri);
        resultResolver._resolveCoverage = async (payload, _token?) => {
            assert.strictEqual(payload.cwd, rootPathCoverageWorkspace, 'Expected cwd to be the workspace folder');
            assert.ok(payload.result, 'Expected results to be present');
            const simpleFileCov = payload.result[`${rootPathCoverageWorkspace}/even.py`];
            assert.ok(simpleFileCov, 'Expected test_simple.py coverage to be present');
            // since only one test was run, the other test in the same file will have missed coverage lines
            assert.strictEqual(simpleFileCov.lines_covered.length, 3, 'Expected 1 line to be covered in even.py');
            assert.strictEqual(simpleFileCov.lines_missed.length, 1, 'Expected 3 lines to be missed in even.py');
            return Promise.resolve();
        };

        // set workspace to test workspace folder
        workspaceUri = Uri.parse(rootPathCoverageWorkspace);
        configService.getSettings(workspaceUri).testing.unittestArgs = ['-s', '.', '-p', '*test*.py'];
        // run execution
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
        let collectedOutput = '';
        testRun
            .setup((t) => t.appendOutput(typeMoq.It.isAny()))
            .callback((output: string) => {
                collectedOutput += output;
                traceLog('appendOutput was called with:', output);
            })
            .returns(() => false);
        await executionAdapter
            .runTests(
                workspaceUri,
                ['test_even.TestNumbers.test_odd'],
                TestRunProfileKind.Coverage,
                testRun.object,
                pythonExecFactory,
            )
            .finally(() => {
                assert.ok(collectedOutput, 'expect output to be collected');
            });
    });
    test('unittest discovery adapter seg fault error handling', async () => {
        resultResolver = new PythonResultResolver(testController, unittestProvider, workspaceUri);
        let callCount = 0;
        let failureOccurred = false;
        let failureMsg = '';
        resultResolver._resolveDiscovery = async (data, _token?) => {
            // do the following asserts for each time resolveExecution is called, should be called once per test.
            callCount = callCount + 1;
            traceLog(`unittest discovery adapter seg fault error handling \n  ${JSON.stringify(data)}`);
            try {
                if (data.status === 'error') {
                    if (data.error === undefined) {
                        // Dereference a NULL pointer
                        const indexOfTest = JSON.stringify(data).search('Dereference a NULL pointer');
                        assert.notDeepEqual(indexOfTest, -1, 'Expected test to have a null pointer');
                    } else {
                        assert.ok(data.error, "Expected errors in 'error' field");
                    }
                } else {
                    const indexOfTest = JSON.stringify(data.tests).search('error');
                    assert.notDeepEqual(
                        indexOfTest,
                        -1,
                        'If payload status is not error then the individual tests should be marked as errors. This should occur on windows machines.',
                    );
                }
            } catch (err) {
                failureMsg = err ? (err as Error).toString() : '';
                failureOccurred = true;
            }
            return Promise.resolve();
        };

        // set workspace to test workspace folder
        workspaceUri = Uri.parse(rootPathDiscoveryErrorWorkspace);
        configService.getSettings(workspaceUri).testing.unittestArgs = ['-s', '.', '-p', '*test*.py'];

        const discoveryAdapter = new UnittestTestDiscoveryAdapter(
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
        await discoveryAdapter.discoverTests(workspaceUri, pythonExecFactory).finally(() => {
            assert.strictEqual(callCount, 1, 'Expected _resolveDiscovery to be called once');
            assert.strictEqual(failureOccurred, false, failureMsg);
        });
    });
    test('unittest execution adapter RuntimeError handling', async () => {
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
                        const indexOfTest = JSON.stringify(data).search('RuntimeError');
                        if (indexOfTest === -1) {
                            failureOccurred = true;
                            failureMsg = 'Expected test to have a RuntimeError';
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
                const indexOfTest = JSON.stringify(data).search('test_runtime_error.TestRuntimeError.test_exception');
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

        const testId = 'test_runtime_error.TestRuntimeError.test_exception';
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
