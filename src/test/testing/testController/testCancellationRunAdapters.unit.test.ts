/* eslint-disable @typescript-eslint/no-explicit-any */
//  Copyright (c) Microsoft Corporation. All rights reserved.
//  Licensed under the MIT License.
import { CancellationTokenSource, TestRun, Uri } from 'vscode';
import * as typeMoq from 'typemoq';
import * as sinon from 'sinon';
import * as path from 'path';
import { Observable } from 'rxjs';
import { IPythonExecutionFactory, IPythonExecutionService, Output } from '../../../client/common/process/types';
import { IConfigurationService, ITestOutputChannel } from '../../../client/common/types';
import { Deferred, createDeferred } from '../../../client/common/utils/async';
import { EXTENSION_ROOT_DIR } from '../../../client/constants';
import { ITestDebugLauncher } from '../../../client/testing/common/types';
import { ITestServer } from '../../../client/testing/testController/common/types';
import { PytestTestExecutionAdapter } from '../../../client/testing/testController/pytest/pytestExecutionAdapter';
import { UnittestTestExecutionAdapter } from '../../../client/testing/testController/unittest/testExecutionAdapter';
import { MockChildProcess } from '../../mocks/mockChildProcess';
import * as util from '../../../client/testing/testController/common/utils';

suite('Execution Flow Run Adapters', () => {
    let configService: IConfigurationService;
    let execFactory = typeMoq.Mock.ofType<IPythonExecutionFactory>();
    let adapter: PytestTestExecutionAdapter;
    let execService: typeMoq.IMock<IPythonExecutionService>;
    let deferred: Deferred<void>;
    let debugLauncher: typeMoq.IMock<ITestDebugLauncher>;
    (global as any).EXTENSION_ROOT_DIR = EXTENSION_ROOT_DIR;
    let myTestPath: string;
    let mockProc: MockChildProcess;
    let utilsStartServerStub: sinon.SinonStub;

    setup(() => {
        configService = ({
            getSettings: () => ({
                testing: { pytestArgs: ['.'], unittestArgs: ['-v', '-s', '.', '-p', 'test*'] },
            }),
            isTestExecution: () => false,
        } as unknown) as IConfigurationService;

        // mock out the result resolver

        // set up exec service with child process
        mockProc = new MockChildProcess('', ['']);
        const output = new Observable<Output<string>>(() => {
            /* no op */
        });
        execService = typeMoq.Mock.ofType<IPythonExecutionService>();
        execService
            .setup((x) => x.execObservable(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => ({
                proc: mockProc,
                out: output,
                dispose: () => {
                    /* no-body */
                },
            }));
        execFactory = typeMoq.Mock.ofType<IPythonExecutionFactory>();
        utilsStartServerStub = sinon.stub(util, 'startTestIdServer');
        debugLauncher = typeMoq.Mock.ofType<ITestDebugLauncher>();
        execFactory
            .setup((x) => x.createActivatedEnvironment(typeMoq.It.isAny()))
            .returns(() => Promise.resolve(execService.object));
        deferred = createDeferred();
        execService
            .setup((x) => x.exec(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => {
                deferred.resolve();
                return Promise.resolve({ stdout: '{}' });
            });
        execFactory.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        execService.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        debugLauncher.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        myTestPath = path.join('/', 'my', 'test', 'path', '/');
    });
    teardown(() => {
        sinon.restore();
    });
    test('PYTEST cancelation token called mid-run resolves correctly', async () => {
        // mock test run and cancelation token
        const testRunMock = typeMoq.Mock.ofType<TestRun>();
        const cancellationToken = new CancellationTokenSource();
        const { token } = cancellationToken;
        testRunMock.setup((t) => t.token).returns(() => token);
        // mock exec service and exec factory
        const execServiceMock = typeMoq.Mock.ofType<IPythonExecutionService>();
        execServiceMock
            .setup((x) => x.execObservable(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => {
                cancellationToken.cancel();
                return {
                    proc: mockProc,
                    out: typeMoq.Mock.ofType<Observable<Output<string>>>().object,
                    dispose: () => {
                        /* no-body */
                    },
                };
            });
        const execFactoryMock = typeMoq.Mock.ofType<IPythonExecutionFactory>();
        execFactoryMock
            .setup((x) => x.createActivatedEnvironment(typeMoq.It.isAny()))
            .returns(() => Promise.resolve(execServiceMock.object));
        execFactoryMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        execServiceMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);

        const deferredStartServer = createDeferred();
        utilsStartServerStub.callsFake(() => {
            deferredStartServer.resolve();
            return Promise.resolve(54321);
        });
        // mock EOT token & ExecClose token
        const deferredEOT = createDeferred();
        const deferredExecClose = createDeferred();
        const utilsCreateEOTStub: sinon.SinonStub = sinon.stub(util, 'createTestingDeferred');
        utilsCreateEOTStub.callsFake(() => {
            if (utilsCreateEOTStub.callCount === 1) {
                return deferredEOT;
            }
            return deferredExecClose;
        });
        adapter = new PytestTestExecutionAdapter(configService, typeMoq.Mock.ofType<ITestOutputChannel>().object);
        await adapter.runTests(
            Uri.file(myTestPath),
            [],
            false,
            testRunMock.object,
            execFactoryMock.object,
            debugLauncher.object,
        );
        // wait for server to start to keep test from failing
        await deferredStartServer.promise;

        // testServer.verify((x) => x.deleteUUID(typeMoq.It.isAny()), typeMoq.Times.once());
    });
    test('PYTEST cancelation token called mid-debug resolves correctly', async () => {
        // mock test run and cancelation token
        const testRunMock = typeMoq.Mock.ofType<TestRun>();
        const cancellationToken = new CancellationTokenSource();
        const { token } = cancellationToken;
        testRunMock.setup((t) => t.token).returns(() => token);
        // mock exec service and exec factory
        const execServiceMock = typeMoq.Mock.ofType<IPythonExecutionService>();
        debugLauncher
            .setup((dl) => dl.launchDebugger(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .callback((_options, callback) => {
                if (callback) {
                    callback();
                }
            })
            .returns(async () => {
                cancellationToken.cancel();
                return Promise.resolve();
            });
        const execFactoryMock = typeMoq.Mock.ofType<IPythonExecutionFactory>();
        execFactoryMock
            .setup((x) => x.createActivatedEnvironment(typeMoq.It.isAny()))
            .returns(() => Promise.resolve(execServiceMock.object));
        execFactoryMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        execServiceMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);

        const deferredStartServer = createDeferred();
        utilsStartServerStub.callsFake(() => {
            deferredStartServer.resolve();
            return Promise.resolve(54321);
        });
        // mock EOT token & ExecClose token
        const deferredEOT = createDeferred();
        const deferredExecClose = createDeferred();
        const utilsCreateEOTStub: sinon.SinonStub = sinon.stub(util, 'createTestingDeferred');
        utilsCreateEOTStub.callsFake(() => {
            if (utilsCreateEOTStub.callCount === 1) {
                return deferredEOT;
            }
            return deferredExecClose;
        });
        // set up test server

        adapter = new PytestTestExecutionAdapter(configService, typeMoq.Mock.ofType<ITestOutputChannel>().object);
        await adapter.runTests(
            Uri.file(myTestPath),
            [],
            true,
            testRunMock.object,
            execFactoryMock.object,
            debugLauncher.object,
        );
        // wait for server to start to keep test from failing
        await deferredStartServer.promise;

        // testServer.verify((x) => x.deleteUUID(typeMoq.It.isAny()), typeMoq.Times.once());
    });
    test('UNITTEST cancelation token called mid-run resolves correctly', async () => {
        // mock test run and cancelation token
        const testRunMock = typeMoq.Mock.ofType<TestRun>();
        const cancellationToken = new CancellationTokenSource();
        const { token } = cancellationToken;
        testRunMock.setup((t) => t.token).returns(() => token);

        // mock exec service and exec factory
        const execServiceMock = typeMoq.Mock.ofType<IPythonExecutionService>();
        execServiceMock
            .setup((x) => x.execObservable(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => {
                cancellationToken.cancel();
                return {
                    proc: mockProc,
                    out: typeMoq.Mock.ofType<Observable<Output<string>>>().object,
                    dispose: () => {
                        /* no-body */
                    },
                };
            });
        const execFactoryMock = typeMoq.Mock.ofType<IPythonExecutionFactory>();
        execFactoryMock
            .setup((x) => x.createActivatedEnvironment(typeMoq.It.isAny()))
            .returns(() => Promise.resolve(execServiceMock.object));
        execFactoryMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        execServiceMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);

        const deferredStartServer = createDeferred();
        utilsStartServerStub.callsFake(() => {
            deferredStartServer.resolve();
            return Promise.resolve(54321);
        });
        // mock EOT token & ExecClose token
        const deferredEOT = createDeferred();
        const deferredExecClose = createDeferred();
        const utilsCreateEOTStub: sinon.SinonStub = sinon.stub(util, 'createTestingDeferred');
        utilsCreateEOTStub.callsFake(() => {
            if (utilsCreateEOTStub.callCount === 1) {
                return deferredEOT;
            }
            return deferredExecClose;
        });
        // set up test server
        const unittestAdapter = new UnittestTestExecutionAdapter(
            // stubTestServer.object,
            configService,
            typeMoq.Mock.ofType<ITestOutputChannel>().object,
        );
        await unittestAdapter.runTests(Uri.file(myTestPath), [], false, testRunMock.object);
        // wait for server to start to keep test from failing
        await deferredStartServer.promise;

        // stubTestServer.verify((x) => x.deleteUUID(typeMoq.It.isAny()), typeMoq.Times.once());
    });
    test('UNITTEST cancelation token called mid-debug resolves correctly', async () => {
        // mock test run and cancelation token
        const testRunMock = typeMoq.Mock.ofType<TestRun>();
        const cancellationToken = new CancellationTokenSource();
        const { token } = cancellationToken;
        testRunMock.setup((t) => t.token).returns(() => token);

        // Stub send command to then have token canceled
        const stubTestServer = typeMoq.Mock.ofType<ITestServer>();
        stubTestServer
            .setup((t) =>
                t.sendCommand(
                    typeMoq.It.isAny(),
                    typeMoq.It.isAny(),
                    typeMoq.It.isAny(),
                    typeMoq.It.isAny(),
                    typeMoq.It.isAny(),
                    typeMoq.It.isAny(),
                ),
            )
            .returns(() => {
                cancellationToken.cancel();
                return Promise.resolve();
            });

        stubTestServer.setup((t) => t.createUUID(typeMoq.It.isAny())).returns(() => 'uuid123');
        stubTestServer
            .setup((t) => t.onRunDataReceived(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => ({
                dispose: () => {
                    /* no-body */
                },
            }));
        // mock exec service and exec factory
        const execServiceMock = typeMoq.Mock.ofType<IPythonExecutionService>();
        debugLauncher
            .setup((dl) => dl.launchDebugger(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(async () => {
                cancellationToken.cancel();
                return Promise.resolve();
            });
        const execFactoryMock = typeMoq.Mock.ofType<IPythonExecutionFactory>();
        execFactoryMock
            .setup((x) => x.createActivatedEnvironment(typeMoq.It.isAny()))
            .returns(() => Promise.resolve(execServiceMock.object));
        execFactoryMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        execServiceMock.setup((p) => ((p as unknown) as any).then).returns(() => undefined);

        const deferredStartServer = createDeferred();
        utilsStartServerStub.callsFake(() => {
            deferredStartServer.resolve();
            return Promise.resolve(54321);
        });
        // mock EOT token & ExecClose token
        const deferredEOT = createDeferred();
        const deferredExecClose = createDeferred();
        const utilsCreateEOTStub: sinon.SinonStub = sinon.stub(util, 'createTestingDeferred');
        utilsCreateEOTStub.callsFake(() => {
            if (utilsCreateEOTStub.callCount === 1) {
                return deferredEOT;
            }
            return deferredExecClose;
        });
        // set up test server
        const unittestAdapter = new UnittestTestExecutionAdapter(
            configService,
            typeMoq.Mock.ofType<ITestOutputChannel>().object,
        );
        await unittestAdapter.runTests(Uri.file(myTestPath), [], false, testRunMock.object);
        // wait for server to start to keep test from failing
        await deferredStartServer.promise;

        stubTestServer.verify((x) => x.deleteUUID(typeMoq.It.isAny()), typeMoq.Times.once());
    });
});
