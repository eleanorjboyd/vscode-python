// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { uniq } from 'lodash';
import {
    CancellationToken,
    TestController,
    TestItem,
    TestRunRequest,
    tests,
    WorkspaceFolder,
    RelativePattern,
    TestRunProfileKind,
    CancellationTokenSource,
    Uri,
    EventEmitter,
    TextDocument,
    TestRunProfile,
} from 'vscode';
import { IExtensionSingleActivationService } from '../../activation/types';
import { ICommandManager, IDocumentManager, IWorkspaceService } from '../../common/application/types';
import * as constants from '../../common/constants';
import { IPythonExecutionFactory } from '../../common/process/types';
import { IConfigurationService, IDisposableRegistry, ITestOutputChannel, Resource } from '../../common/types';
import { DelayedTrigger, IDelayedTrigger } from '../../common/utils/delayTrigger';
import { noop } from '../../common/utils/misc';
import { IInterpreterService } from '../../interpreter/contracts';
import { traceError, traceInfo, traceVerbose } from '../../logging';
import { IEventNamePropertyMapping, sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { PYTEST_PROVIDER, UNITTEST_PROVIDER } from '../common/constants';
import { TestProvider } from '../types';
import { DebugTestTag, getNodeByUri, RunTestTag } from './common/testItemUtilities';
import { pythonTestAdapterRewriteEnabled } from './common/utils';
import {
    ITestController,
    ITestDiscoveryAdapter,
    ITestFrameworkController,
    TestRefreshOptions,
    ITestExecutionAdapter,
    ITestResultResolver,
} from './common/types';
import { UnittestTestDiscoveryAdapter } from './unittest/testDiscoveryAdapter';
import { UnittestTestExecutionAdapter } from './unittest/testExecutionAdapter';
import { PytestTestDiscoveryAdapter } from './pytest/pytestDiscoveryAdapter';
import { PytestTestExecutionAdapter } from './pytest/pytestExecutionAdapter';
import { WorkspaceTestAdapter } from './workspaceTestAdapter';
import { ITestDebugLauncher } from '../common/types';
import { IServiceContainer } from '../../ioc/types';
import { PythonResultResolver } from './common/resultResolver';
import { onDidSaveTextDocument } from '../../common/vscodeApis/workspaceApis';
import { IEnvironmentVariablesProvider } from '../../common/variables/types';
import { TestConfig } from '../configuration/types';

// Types gymnastics to make sure that sendTriggerTelemetry only accepts the correct types.
type EventPropertyType = IEventNamePropertyMapping[EventName.UNITTEST_DISCOVERY_TRIGGER];
type TriggerKeyType = keyof EventPropertyType;
type TriggerType = EventPropertyType[TriggerKeyType];

@injectable()
export class PythonTestController implements ITestController, IExtensionSingleActivationService {
    public readonly supportedWorkspaceTypes = { untrustedWorkspace: false, virtualWorkspace: false };

    private readonly testAdapters: Map<Uri, WorkspaceTestAdapter> = new Map();

    private readonly triggerTypes: TriggerType[] = [];

    private readonly testController: TestController;

    private testRunProfiles: TestRunProfile[];

    private readonly refreshData: IDelayedTrigger;

    private refreshCancellation: CancellationTokenSource;

    private readonly refreshingCompletedEvent: EventEmitter<void> = new EventEmitter<void>();

    private readonly refreshingStartedEvent: EventEmitter<void> = new EventEmitter<void>();

    private readonly runWithoutConfigurationEvent: EventEmitter<WorkspaceFolder[]> = new EventEmitter<
        WorkspaceFolder[]
    >();

    public readonly onRefreshingCompleted = this.refreshingCompletedEvent.event;

    public readonly onRefreshingStarted = this.refreshingStartedEvent.event;

    public readonly onRunWithoutConfiguration = this.runWithoutConfigurationEvent.event;

    private sendTestDisabledTelemetry = true;

    constructor(
        @inject(IWorkspaceService) private readonly workspaceService: IWorkspaceService,
        @inject(IConfigurationService) private readonly configSettings: IConfigurationService,
        @inject(ITestFrameworkController) @named(PYTEST_PROVIDER) private readonly pytest: ITestFrameworkController,
        @inject(ITestFrameworkController) @named(UNITTEST_PROVIDER) private readonly unittest: ITestFrameworkController,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IInterpreterService) private readonly interpreterService: IInterpreterService,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(IPythonExecutionFactory) private readonly pythonExecFactory: IPythonExecutionFactory,
        @inject(ITestDebugLauncher) private readonly debugLauncher: ITestDebugLauncher,
        @inject(ITestOutputChannel) private readonly testOutputChannel: ITestOutputChannel,
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer,
        @inject(IEnvironmentVariablesProvider) private readonly envVarsService: IEnvironmentVariablesProvider,
        @inject(IDocumentManager) private readonly documentManager: IDocumentManager,
    ) {
        this.refreshCancellation = new CancellationTokenSource();

        this.testController = tests.createTestController('python-tests', 'Python Tests');
        this.disposables.push(this.testController);
        this.testRunProfiles = [];

        const delayTrigger = new DelayedTrigger(
            (uri: Uri, invalidate: boolean) => {
                this.refreshTestDataInternal(uri);
                if (invalidate) {
                    this.invalidateTests(uri);
                }
            },
            250, // Delay running the refresh by 250 ms
            'Refresh Test Data',
        );
        this.disposables.push(delayTrigger);
        this.refreshData = delayTrigger;

        const runProfileA = this.testController.createRunProfile(
            'simple test config',
            TestRunProfileKind.Run,
            this.runTests.bind(this),
            true,
            RunTestTag,
        );
        const runProfileb = this.testController.createRunProfile(
            'simple test config',
            TestRunProfileKind.Debug,
            this.runTests.bind(this),
            false,
            DebugTestTag,
        );
        // const runProfilec = this.testController.createRunProfile(
        //     'test config: test data',
        //     TestRunProfileKind.Debug,
        //     this.runTests.bind(this),
        //     true,
        //     DebugTestTag,
        // );
        // const runProfiled = this.testController.createRunProfile(
        //     'test config: test data',
        //     TestRunProfileKind.Run,
        //     this.runTests.bind(this),
        //     false,
        //     RunTestTag,
        // );
        // const runProfileList = [runProfileA, runProfileb, runProfilec, runProfiled];
        // for (const runProfile of runProfileList) {
        //     runProfile.configureHandler = async () => {
        //         const stringPath = `${this.workspaceService.rootPath}/.vscode/settings.json`;
        //         const settingsJsonPath = Uri.file(stringPath);

        //         try {
        //             const settingKey = 'python.testing.configs';
        //             const editor = await this.documentManager.showTextDocument(settingsJsonPath);
        //             const text = editor.document.getText();
        //             const settingIndex = text.indexOf(settingKey);

        //             if (settingIndex !== -1) {
        //                 // const position = editor.document.positionAt(settingIndex);
        //                 editor.revealRange(new Range());
        //             } else {
        //                 traceError('Setting not found');
        //             }
        //         } catch (error) {
        //             traceError('Error configuring test profile', error);
        //         }
        //     };

        //     // console.log('Configuring test profile');
        //     // // /Users/eleanorboyd/testingFiles/custom-configs-folder/simple_workspace/.vscode/settings.json
        //     // const stringPath = `${this.workspaceService.rootPath}/.vscode/settings.json`;
        //     // const settingsJsonPath = Uri.file(stringPath);
        //     // traceError("Configuring test profile doesn't work yet");
        //     // traceError('workspace.asRelativePath(settingsJsonPath);', workspace.asRelativePath(settingsJsonPath));
        //     // await this.documentManager.showTextDocument(settingsJsonPath).then((editor: TextEditor) => {
        //     //     const text = editor.document.getText();
        //     //     // find in text where it says "python.testing.configs"
        //     //     const pythonTestingConfigsIndex = text.indexOf('python.testing.configs');
        //     //     // open to the pythonTestingConfigsIndex
        //     //     const position = editor.document.positionAt(pythonTestingConfigsIndex);
        //     //     editor.selection = new Selection(position, position);
        //     // });
        // }
        this.disposables.push(
            // CC: create specific run profiles
            runProfileA,
            runProfileb,
        );
        this.testController.resolveHandler = this.resolveChildren.bind(this);
        this.testController.refreshHandler = (token: CancellationToken) => {
            this.disposables.push(
                token.onCancellationRequested(() => {
                    traceVerbose('Testing: Stop refreshing triggered');
                    sendTelemetryEvent(EventName.UNITTEST_DISCOVERING_STOP);
                    this.stopRefreshing();
                }),
            );

            traceVerbose('Testing: Manually triggered test refresh');
            sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_TRIGGER, undefined, {
                trigger: constants.CommandSource.commandPalette,
            });
            return this.refreshTestData(undefined, { forceRefresh: true });
        };
    }

    public async activate(): Promise<void> {
        const workspaces: readonly WorkspaceFolder[] = this.workspaceService.workspaceFolders || [];
        workspaces.forEach((workspace) => {
            const settings = this.configSettings.getSettings(workspace.uri);

            let discoveryAdapter: ITestDiscoveryAdapter;
            let executionAdapter: ITestExecutionAdapter;
            let testProvider: TestProvider;
            let resultResolver: ITestResultResolver;
            if (settings.testing.unittestEnabled) {
                testProvider = UNITTEST_PROVIDER;
                resultResolver = new PythonResultResolver(this.testController, testProvider, workspace.uri);
                discoveryAdapter = new UnittestTestDiscoveryAdapter(
                    this.configSettings,
                    this.testOutputChannel,
                    resultResolver,
                    this.envVarsService,
                );
                executionAdapter = new UnittestTestExecutionAdapter(
                    this.configSettings,
                    this.testOutputChannel,
                    resultResolver,
                    this.envVarsService,
                );
            } else {
                testProvider = PYTEST_PROVIDER;
                resultResolver = new PythonResultResolver(this.testController, testProvider, workspace.uri);
                discoveryAdapter = new PytestTestDiscoveryAdapter(
                    this.configSettings,
                    this.testOutputChannel,
                    resultResolver,
                    this.envVarsService,
                );
                executionAdapter = new PytestTestExecutionAdapter(
                    this.configSettings,
                    this.testOutputChannel,
                    resultResolver,
                    this.envVarsService,
                );
            }

            const workspaceTestAdapter = new WorkspaceTestAdapter(
                testProvider,
                discoveryAdapter,
                executionAdapter,
                workspace.uri,
                resultResolver,
            );

            this.testAdapters.set(workspace.uri, workspaceTestAdapter);

            if (settings.testing.autoTestDiscoverOnSaveEnabled) {
                traceVerbose(`Testing: Setting up watcher for ${workspace.uri.fsPath}`);
                this.watchForSettingsChanges(workspace);
                this.watchForTestContentChangeOnSave();
            }
        });
    }

    public refreshTestData(uri?: Resource, options?: TestRefreshOptions): Promise<void> {
        if (options?.forceRefresh) {
            if (uri === undefined) {
                // This is a special case where we want everything to be re-discovered.
                traceVerbose('Testing: Clearing all discovered tests');
                this.testController.items.forEach((item) => {
                    const ids: string[] = [];
                    item.children.forEach((child) => ids.push(child.id));
                    ids.forEach((id) => item.children.delete(id));
                });

                traceVerbose('Testing: Forcing test data refresh');
                return this.refreshTestDataInternal(undefined);
            }

            traceVerbose('Testing: Forcing test data refresh');
            return this.refreshTestDataInternal(uri);
        }

        this.refreshData.trigger(uri, false);
        return Promise.resolve();
    }

    public stopRefreshing(): void {
        this.refreshCancellation.cancel();
        this.refreshCancellation.dispose();
        this.refreshCancellation = new CancellationTokenSource();
    }

    public clearTestController(): void {
        const ids: string[] = [];
        this.testController.items.forEach((item) => ids.push(item.id));
        ids.forEach((id) => this.testController.items.delete(id));
    }

    private async refreshTestDataInternal(uri?: Resource): Promise<void> {
        this.refreshingStartedEvent.fire();
        if (uri) {
            const settings = this.configSettings.getSettings(uri);
            const workspace = this.workspaceService.getWorkspaceFolder(uri);
            traceInfo(`Discover tests for workspace name: ${workspace?.name} - uri: ${uri.fsPath}`);
            // Ensure we send test telemetry if it gets disabled again
            this.sendTestDisabledTelemetry = true;
            // ** experiment to roll out NEW test discovery mechanism
            if (settings.testing.pytestEnabled) {
                if (pythonTestAdapterRewriteEnabled(this.serviceContainer)) {
                    traceInfo(`Running discovery for pytest using the new test adapter.`);
                    if (workspace && workspace.uri) {
                        const testAdapter = this.testAdapters.get(workspace.uri);
                        if (testAdapter) {
                            await testAdapter.discoverTests(
                                this.testController,
                                this.refreshCancellation.token,
                                this.pythonExecFactory,
                            );
                        } else {
                            traceError('Unable to find test adapter for workspace.');
                        }
                    } else {
                        traceError('Unable to find workspace for given file');
                    }
                } else {
                    // else use OLD test discovery mechanism
                    await this.pytest.refreshTestData(this.testController, uri, this.refreshCancellation.token);
                }
            } else if (settings.testing.unittestEnabled) {
                if (pythonTestAdapterRewriteEnabled(this.serviceContainer)) {
                    traceInfo(`Running discovery for unittest using the new test adapter.`);
                    if (workspace && workspace.uri) {
                        const testAdapter = this.testAdapters.get(workspace.uri);
                        if (testAdapter) {
                            await testAdapter.discoverTests(
                                this.testController,
                                this.refreshCancellation.token,
                                this.pythonExecFactory,
                            );
                        } else {
                            traceError('Unable to find test adapter for workspace.');
                        }
                    } else {
                        traceError('Unable to find workspace for given file');
                    }
                } else {
                    // else use OLD test discovery mechanism
                    await this.unittest.refreshTestData(this.testController, uri, this.refreshCancellation.token);
                }
            } else {
                if (this.sendTestDisabledTelemetry) {
                    this.sendTestDisabledTelemetry = false;
                    sendTelemetryEvent(EventName.UNITTEST_DISABLED);
                }
                // If we are here we may have to remove an existing node from the tree
                // This handles the case where user removes test settings. Which should remove the
                // tests for that particular case from the tree view
                if (workspace) {
                    const toDelete: string[] = [];
                    this.testController.items.forEach((i: TestItem) => {
                        const w = this.workspaceService.getWorkspaceFolder(i.uri);
                        if (w?.uri.fsPath === workspace.uri.fsPath) {
                            toDelete.push(i.id);
                        }
                    });
                    toDelete.forEach((i) => this.testController.items.delete(i));
                }
            }
        } else {
            traceVerbose('Testing: Refreshing all test data');
            const workspaces: readonly WorkspaceFolder[] = this.workspaceService.workspaceFolders || [];
            await Promise.all(
                workspaces.map(async (workspace) => {
                    if (!(await this.interpreterService.getActiveInterpreter(workspace.uri))) {
                        this.commandManager
                            .executeCommand(constants.Commands.TriggerEnvironmentSelection, workspace.uri)
                            .then(noop, noop);
                        return;
                    }
                    await this.refreshTestDataInternal(workspace.uri);
                }),
            );
        }
        this.refreshingCompletedEvent.fire();
        return Promise.resolve();
    }

    private async resolveChildren(item: TestItem | undefined): Promise<void> {
        if (item) {
            traceVerbose(`Testing: Resolving item ${item.id}`);
            const settings = this.configSettings.getSettings(item.uri);
            if (settings.testing.pytestEnabled) {
                return this.pytest.resolveChildren(this.testController, item, this.refreshCancellation.token);
            }
            if (settings.testing.unittestEnabled) {
                return this.unittest.resolveChildren(this.testController, item, this.refreshCancellation.token);
            }
        } else {
            traceVerbose('Testing: Refreshing all test data');
            this.sendTriggerTelemetry('auto');
            const workspaces: readonly WorkspaceFolder[] = this.workspaceService.workspaceFolders || [];
            await Promise.all(
                workspaces.map(async (workspace) => {
                    if (!(await this.interpreterService.getActiveInterpreter(workspace.uri))) {
                        traceError('Cannot trigger test discovery as a valid interpreter is not selected');
                        return;
                    }
                    await this.refreshTestDataInternal(workspace.uri);
                }),
            );
        }
        return Promise.resolve();
    }

    private async runTests(request: TestRunRequest, token: CancellationToken): Promise<void> {
        const workspaces: WorkspaceFolder[] = [];
        if (request.include) {
            uniq(request.include.map((r) => this.workspaceService.getWorkspaceFolder(r.uri))).forEach((w) => {
                if (w) {
                    workspaces.push(w);
                }
            });
        } else {
            (this.workspaceService.workspaceFolders || []).forEach((w) => workspaces.push(w));
        }
        const runInstance = this.testController.createTestRun(
            request,
            `Running Tests for Workspace(s): ${workspaces.map((w) => w.uri.fsPath).join(';')}`,
            true,
        );

        const dispose = token.onCancellationRequested(() => {
            runInstance.appendOutput(`\nRun instance cancelled.\r\n`);
            runInstance.end();
        });

        const unconfiguredWorkspaces: WorkspaceFolder[] = [];
        try {
            await Promise.all(
                workspaces.map(async (workspace) => {
                    if (!(await this.interpreterService.getActiveInterpreter(workspace.uri))) {
                        this.commandManager
                            .executeCommand(constants.Commands.TriggerEnvironmentSelection, workspace.uri)
                            .then(noop, noop);
                        return undefined;
                    }
                    const testItems: TestItem[] = [];
                    // If the run request includes test items then collect only items that belong to
                    // `workspace`. If there are no items in the run request then just run the `workspace`
                    // root test node. Include will be `undefined` in the "run all" scenario.
                    (request.include ?? this.testController.items).forEach((i: TestItem) => {
                        const w = this.workspaceService.getWorkspaceFolder(i.uri);
                        if (w?.uri.fsPath === workspace.uri.fsPath) {
                            testItems.push(i);
                        }
                    });

                    const settings = this.configSettings.getSettings(workspace.uri);
                    if (testItems.length > 0) {
                        if (settings.testing.pytestEnabled) {
                            sendTelemetryEvent(EventName.UNITTEST_RUN, undefined, {
                                tool: 'pytest',
                                debugging: request.profile?.kind === TestRunProfileKind.Debug,
                            });
                            // ** experiment to roll out NEW test discovery mechanism
                            if (pythonTestAdapterRewriteEnabled(this.serviceContainer)) {
                                const testAdapter =
                                    this.testAdapters.get(workspace.uri) ||
                                    (this.testAdapters.values().next().value as WorkspaceTestAdapter);
                                return testAdapter.executeTests(
                                    this.testController,
                                    runInstance,
                                    testItems,
                                    token,
                                    request.profile?.kind === TestRunProfileKind.Debug,
                                    this.pythonExecFactory,
                                    this.debugLauncher,
                                );
                            }
                            return this.pytest.runTests(
                                {
                                    includes: testItems,
                                    excludes: request.exclude ?? [],
                                    runKind: request.profile?.kind ?? TestRunProfileKind.Run,
                                    runInstance,
                                },
                                workspace,
                                token,
                            );
                        }
                        if (settings.testing.unittestEnabled) {
                            sendTelemetryEvent(EventName.UNITTEST_RUN, undefined, {
                                tool: 'unittest',
                                debugging: request.profile?.kind === TestRunProfileKind.Debug,
                            });
                            // ** experiment to roll out NEW test discovery mechanism
                            if (pythonTestAdapterRewriteEnabled(this.serviceContainer)) {
                                const testAdapter =
                                    this.testAdapters.get(workspace.uri) ||
                                    (this.testAdapters.values().next().value as WorkspaceTestAdapter);
                                return testAdapter.executeTests(
                                    this.testController,
                                    runInstance,
                                    testItems,
                                    token,
                                    request.profile?.kind === TestRunProfileKind.Debug,
                                    this.pythonExecFactory,
                                    this.debugLauncher,
                                );
                            }
                            // below is old way of running unittest execution
                            return this.unittest.runTests(
                                {
                                    includes: testItems,
                                    excludes: request.exclude ?? [],
                                    runKind: request.profile?.kind ?? TestRunProfileKind.Run,
                                    runInstance,
                                },
                                workspace,
                                token,
                                this.testController,
                            );
                        }
                    }
                    if (!settings.testing.pytestEnabled && !settings.testing.unittestEnabled) {
                        unconfiguredWorkspaces.push(workspace);
                    }
                    return Promise.resolve();
                }),
            );
        } finally {
            traceVerbose('Finished running tests, ending runInstance.');
            runInstance.appendOutput(`Finished running tests!\r\n`);
            runInstance.end();
            dispose.dispose();
            if (unconfiguredWorkspaces.length > 0) {
                this.runWithoutConfigurationEvent.fire(unconfiguredWorkspaces);
            }
        }
    }

    private invalidateTests(uri: Uri) {
        this.testController.items.forEach((root) => {
            const item = getNodeByUri(root, uri);
            if (item && !!item.invalidateResults) {
                // Minimize invalidating to test case nodes for the test file where
                // the change occurred
                item.invalidateResults();
            }
        });
    }

    private watchForSettingsChanges(workspace: WorkspaceFolder): void {
        const pattern = new RelativePattern(workspace, '**/{settings.json,pytest.ini,pyproject.toml,setup.cfg}');
        const watcher = this.workspaceService.createFileSystemWatcher(pattern);
        this.disposables.push(watcher);

        this.disposables.push(
            onDidSaveTextDocument(async (doc: TextDocument) => {
                const file = doc.fileName;
                // refresh on any settings file save
                if (
                    file.includes('settings.json') ||
                    file.includes('pytest.ini') ||
                    file.includes('setup.cfg') ||
                    file.includes('pyproject.toml')
                ) {
                    traceVerbose(`Testing: Trigger refresh after saving ${doc.uri.fsPath}`);
                    this.sendTriggerTelemetry('watching');
                    this.refreshData.trigger(doc.uri, false);
                    this.refreshTestConfigs(workspace.uri, { forceRefresh: true });
                }
            }),
        );
        /* Keep both watchers for create and delete since config files can change test behavior without content
        due to their impact on pythonPath. */
        this.disposables.push(
            watcher.onDidCreate((uri) => {
                traceVerbose(`Testing: Trigger refresh after creating ${uri.fsPath}`);
                this.sendTriggerTelemetry('watching');
                this.refreshData.trigger(uri, false);
            }),
        );
        this.disposables.push(
            watcher.onDidDelete((uri) => {
                traceVerbose(`Testing: Trigger refresh after deleting in ${uri.fsPath}`);
                this.sendTriggerTelemetry('watching');
                this.refreshData.trigger(uri, false);
            }),
        );
    }

    private watchForTestContentChangeOnSave(): void {
        this.disposables.push(
            onDidSaveTextDocument(async (doc: TextDocument) => {
                if (doc.fileName.endsWith('.py')) {
                    traceVerbose(`Testing: Trigger refresh after saving ${doc.uri.fsPath}`);
                    this.sendTriggerTelemetry('watching');
                    this.refreshData.trigger(doc.uri, false);
                }
            }),
        );
    }

    /**
     * Send UNITTEST_DISCOVERY_TRIGGER telemetry event only once per trigger type.
     *
     * @param triggerType The trigger type to send telemetry for.
     */
    private sendTriggerTelemetry(trigger: TriggerType): void {
        if (!this.triggerTypes.includes(trigger)) {
            sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_TRIGGER, undefined, {
                trigger,
            });
            this.triggerTypes.push(trigger);
        }
    }

    public refreshTestConfigs(uri?: Resource, options?: TestRefreshOptions): Promise<void> {
        if (options?.forceRefresh) {
            if (uri === undefined) {
                traceVerbose('uri undefined, refresh test configs');
            }

            traceVerbose('Testing: refresh CONFIGS');
            // return this.refreshTestDataInternal(uri);
            // this.testController.createRunProfile;
        }
        // get current test configs from this.testRunProfiles
        const currProfiles: TestRunProfile[] = this.testRunProfiles;
        console.log('currProfiles', currProfiles);

        // get test configs from settings.json
        const settings = this.configSettings.getSettings(uri);
        const { configs } = settings.testing;
        console.log('testConfigs', configs);

        const settingsConfigsIds: string[] = [];
        for (const config of configs) {
            settingsConfigsIds.push(config.name);
        }
        const currProfilesIds: string[] = [];
        for (const currProfile of currProfiles) {
            currProfilesIds.push(currProfile.label);
        }

        // Compare the arrays and create new run profiles for missing configs
        const newProfiles: TestRunProfile[] = [];
        for (const config of configs) {
            if (!currProfilesIds.includes(config.name)) {
                const newProfile: TestRunProfile = this.testController.createRunProfile(
                    config.name,
                    TestRunProfileKind.Run,
                    this.runTests.bind(this),
                    false,
                    RunTestTag,
                );
                newProfiles.push(newProfile);
            }
        }

        // Dispose of profiles that are no longer in settings.json
        const profilesToRemove: TestRunProfile[] = [];
        for (const currProfile of currProfiles) {
            if (!settingsConfigsIds.includes(currProfile.label)) {
                profilesToRemove.push(currProfile);
            }
        }
        for (const profileToRemove of profilesToRemove) {
            profileToRemove.dispose();
        }

        // Add new profiles to the profile list
        currProfiles.push(...newProfiles);

        // Update the controller with the updated profile list
        this.testRunProfiles = currProfiles;

        // dispose of test configs that are no longer in settings.json
        // create new test configs that are in settings.json but not in this.testRunProfiles

        // this.refreshData.trigger(uri, false);
        return Promise.resolve();
    }
}
