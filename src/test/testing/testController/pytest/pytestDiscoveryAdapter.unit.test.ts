// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as assert from 'assert';
import { Uri } from 'vscode';
import * as typeMoq from 'typemoq';
import { IConfigurationService } from '../../../../client/common/types';
import { PytestTestDiscoveryAdapter } from '../../../../client/testing/testController/pytest/pytestDiscoveryAdapter';
import { ITestServer } from '../../../../client/testing/testController/common/types';
import { IPythonExecutionFactory, IPythonExecutionService } from '../../../../client/common/process/types';
import { createDeferred, Deferred } from '../../../../client/common/utils/async';

suite('pytest test discovery adapter', () => {
    let testServer: typeMoq.IMock<ITestServer>;
    let configService: IConfigurationService;
    let execFactory = typeMoq.Mock.ofType<IPythonExecutionFactory>();
    let adapter: PytestTestDiscoveryAdapter;
    let execService: typeMoq.IMock<IPythonExecutionService>;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let deferred: Deferred<void>;

    setup(() => {
        testServer = typeMoq.Mock.ofType<ITestServer>();
        testServer.setup((t) => t.createUUID(typeMoq.It.isAny())).returns(() => 'uuid123');
        testServer.setup((t) => t.getPort()).returns(() => 12345);
        testServer
            .setup((t) => t.onDataReceived(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => ({
                dispose: () => {
                    /* do nothing */
                },
            }));

        // does get settings have URI I should be using
        configService = ({
            getSettings: () => ({
                testing: { pytestArgs: ['.'] },
            }),
        } as unknown) as IConfigurationService;
        execFactory = typeMoq.Mock.ofType<IPythonExecutionFactory>();
        execService = typeMoq.Mock.ofType<IPythonExecutionService>();
        execFactory
            .setup((x) => x.createActivatedEnvironment(typeMoq.It.isAny()))
            .returns(() => Promise.resolve(execService.object));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // execFactory.setup((p) => ((p as unknown) as any).then).returns(() => undefined);
        deferred = createDeferred();
        execService
            .setup((x) => x.exec(typeMoq.It.isAny(), typeMoq.It.isAny()))
            .returns(() => {
                deferred.resolve();
                return Promise.resolve({ stdout: '{}' });
            });
    });

    test('test discovery adapter', async () => {
        const eventData = {
            cwd: '/my/test/path/',
            data: '{}',
        };

        const uri = Uri.file('/my/test/path/');
        adapter = new PytestTestDiscoveryAdapter(testServer.object, configService);
        const promise = adapter.runPytestDiscovery(uri, execFactory.object);
        await deferred.promise;
        adapter.onDataReceivedHandler(eventData);
        const result = await promise;
        assert.deepStrictEqual(result, eventData);
        // goal to have the right cwd?
    });
});
