// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as path from 'path';
import { Uri } from 'vscode';
import {
    ExecutionFactoryCreateWithEnvironmentOptions,
    IPythonExecutionFactory,
    SpawnOptions,
} from '../../../common/process/types';
import { IConfigurationService } from '../../../common/types';
import { createDeferred, Deferred } from '../../../common/utils/async';
import { EXTENSION_ROOT_DIR } from '../../../constants';
import { DataReceivedEvent, DiscoveredTestPayload, ITestDiscoveryAdapter, ITestServer } from '../common/types';

/**
 * Wrapper class for unittest test discovery. This is where we call `runTestCommand`. #this seems incorrectly copied
 */
export class PytestTestDiscoveryAdapter implements ITestDiscoveryAdapter {
    private deferred: Deferred<DiscoveredTestPayload> | undefined;

    private cwd: string | undefined;

    constructor(public testServer: ITestServer, public configSettings: IConfigurationService) {
        testServer.onDataReceived(this.onDataReceivedHandler, this);
    }

    public onDataReceivedHandler({ cwd, data }: DataReceivedEvent): void {
        if (this.deferred && cwd === this.cwd) {
            const testData: DiscoveredTestPayload = JSON.parse(data);

            this.deferred.resolve(testData);
            this.deferred = undefined;
        }
    }

    public async discoverTests(uri: Uri, executionFactory: IPythonExecutionFactory): Promise<DiscoveredTestPayload> {
        const settings = this.configSettings.getSettings(uri);
        const { pytestArgs } = settings.testing;
        console.debug(pytestArgs); // do we use pytestArgs anywhere?

        this.cwd = uri.fsPath;
        return this.runPytestDiscovery(uri, executionFactory);
    }

    async runPytestDiscovery(uri: Uri, executionFactory: IPythonExecutionFactory): Promise<DiscoveredTestPayload> {
        if (!this.deferred) {
            this.deferred = createDeferred<DiscoveredTestPayload>();
            const relativePathToPytest = 'pythonFiles';
            const fullPluginPath = path.join(EXTENSION_ROOT_DIR, relativePathToPytest);
            const uuid = this.testServer.createUUID(uri.fsPath);
            const settings = this.configSettings.getSettings(uri);
            const { pytestArgs } = settings.testing;

            const pythonPathParts: string[] = process.env.PYTHONPATH?.split(path.delimiter) ?? [];
            const pythonPathCommand = [fullPluginPath, ...pythonPathParts].join(path.delimiter);
            console.log('port', this.testServer.getPort().toString(), uuid.toString());

            const spawnOptions: SpawnOptions = {
                cwd: uri.fsPath,
                throwOnStdErr: true,
                extraVariables: {
                    PYTHONPATH: pythonPathCommand,
                    TEST_UUID: uuid.toString(),
                    TEST_PORT: this.testServer.getPort().toString(),
                },
            };

            // Create the Python environment in which to execute the command.
            const creationOptions: ExecutionFactoryCreateWithEnvironmentOptions = {
                allowEnvironmentFetchExceptions: false,
                resource: uri,
            };
            const execService = await executionFactory.createActivatedEnvironment(creationOptions);

            try {
                // const p = await execService.exec(['os.getenv("TEST_PORT",5555)'], spawnOptions);
                // console.log(await execService.exec(['echo', '$PYTHONPATH'], spawnOptions));\--trace-config
                // const p = await execService.exec(
                //     ['-m', 'pytest', '-p', 'vscode_pytest', '--trace-config'].concat(pytestArgs),
                //     spawnOptions,
                // );
                const p = await execService.exec(
                    ['-m', 'pytest', '-p', 'vscode_pytest', '--collect-only'].concat(pytestArgs),
                    spawnOptions,
                );
                console.log(p.stdout);
                console.log('finish');
            } catch (ex) {
                console.error(ex);
            }
        }
        return this.deferred.promise;
    }
}
