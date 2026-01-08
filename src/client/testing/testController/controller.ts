// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable, named } from 'inversify';
import { uniq } from 'lodash';
import * as minimatch from 'minimatch';
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
    FileCoverageDetail,
    TestRun,
    MarkdownString,
} from 'vscode';
import { IExtensionSingleActivationService } from '../../activation/types';
import { ICommandManager, IWorkspaceService } from '../../common/application/types';
import * as constants from '../../common/constants';
import { IPythonExecutionFactory } from '../../common/process/types';
import { IConfigurationService, IDisposableRegistry, Resource } from '../../common/types';
import { DelayedTrigger, IDelayedTrigger } from '../../common/utils/delayTrigger';
import { noop } from '../../common/utils/misc';
import { IInterpreterService } from '../../interpreter/contracts';
import { traceError, traceVerbose } from '../../logging';
import { IEventNamePropertyMapping, sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { PYTEST_PROVIDER, UNITTEST_PROVIDER } from '../common/constants';
import { TestProvider } from '../types';
import { createErrorTestItem, DebugTestTag, getNodeByUri, RunTestTag } from './common/testItemUtilities';
import { buildErrorNodeOptions } from './common/utils';
import {
    ITestController,
    ITestDiscoveryAdapter,
    ITestFrameworkController,
    TestRefreshOptions,
    ITestExecutionAdapter,
} from './common/types';
import { UnittestTestDiscoveryAdapter } from './unittest/testDiscoveryAdapter';
import { UnittestTestExecutionAdapter } from './unittest/testExecutionAdapter';
import { PytestTestDiscoveryAdapter } from './pytest/pytestDiscoveryAdapter';
import { PytestTestExecutionAdapter } from './pytest/pytestExecutionAdapter';
import { WorkspaceTestAdapter } from './workspaceTestAdapter';
import { ITestDebugLauncher } from '../common/types';
import { PythonResultResolver } from './common/resultResolver';
import { onDidSaveTextDocument } from '../../common/vscodeApis/workspaceApis';
import { IEnvironmentVariablesProvider } from '../../common/variables/types';
import { findProjectRoots, ProjectRoot, isFileInProject } from './common/projectRootFinder';

// Types gymnastics to make sure that sendTriggerTelemetry only accepts the correct types.
type EventPropertyType = IEventNamePropertyMapping[EventName.UNITTEST_DISCOVERY_TRIGGER];
type TriggerKeyType = keyof EventPropertyType;
type TriggerType = EventPropertyType[TriggerKeyType];

/**
 * Represents a project-specific test adapter with its project root information
 */
interface ProjectTestAdapter {
    adapter: WorkspaceTestAdapter;
    projectRoot: ProjectRoot;
}

@injectable()
export class PythonTestController implements ITestController, IExtensionSingleActivationService {
    public readonly supportedWorkspaceTypes = { untrustedWorkspace: false, virtualWorkspace: false };

    // Map of workspace URI -> array of project-specific test adapters
    private readonly testAdapters: Map<string, ProjectTestAdapter[]> = new Map();

    private readonly triggerTypes: TriggerType[] = [];

    private readonly testController: TestController;

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
        @inject(IEnvironmentVariablesProvider) private readonly envVarsService: IEnvironmentVariablesProvider,
    ) {
        this.refreshCancellation = new CancellationTokenSource();

        this.testController = tests.createTestController('python-tests', 'Python Tests');
        this.disposables.push(this.testController);

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

        this.disposables.push(
            this.testController.createRunProfile(
                'Run Tests',
                TestRunProfileKind.Run,
                this.runTests.bind(this),
                true,
                RunTestTag,
            ),
            this.testController.createRunProfile(
                'Debug Tests',
                TestRunProfileKind.Debug,
                this.runTests.bind(this),
                true,
                DebugTestTag,
            ),
            this.testController.createRunProfile(
                'Coverage Tests',
                TestRunProfileKind.Coverage,
                this.runTests.bind(this),
                true,
                RunTestTag,
            ),
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
            // Initialize with empty array - projects will be detected during discovery
            this.testAdapters.set(workspace.uri.toString(), []);

            const settings = this.configSettings.getSettings(workspace.uri);
            if (settings.testing.autoTestDiscoverOnSaveEnabled) {
                traceVerbose(`Testing: Setting up watcher for ${workspace.uri.fsPath}`);
                this.watchForSettingsChanges(workspace);
                this.watchForTestContentChangeOnSave();
            }
        });
    }

    /**
     * Creates a test adapter for a specific project root within a workspace.
     * @param _workspaceUri The workspace folder URI (for future use)
     * @param projectRoot The project root to create adapter for
     * @param testProvider The test provider (pytest or unittest)
     * @returns A ProjectTestAdapter instance
     */
    private createProjectAdapter(
        _workspaceUri: Uri,
        projectRoot: ProjectRoot,
        testProvider: TestProvider,
    ): ProjectTestAdapter {
        traceVerbose(
            `Creating ${testProvider} adapter for project at ${projectRoot.uri.fsPath} (marker: ${projectRoot.markerFile})`,
        );

        const resultResolver = new PythonResultResolver(this.testController, testProvider, projectRoot.uri);

        let discoveryAdapter: ITestDiscoveryAdapter;
        let executionAdapter: ITestExecutionAdapter;

        if (testProvider === UNITTEST_PROVIDER) {
            discoveryAdapter = new UnittestTestDiscoveryAdapter(
                this.configSettings,
                resultResolver,
                this.envVarsService,
            );
            executionAdapter = new UnittestTestExecutionAdapter(
                this.configSettings,
                resultResolver,
                this.envVarsService,
            );
        } else {
            discoveryAdapter = new PytestTestDiscoveryAdapter(
                this.configSettings,
                resultResolver,
                this.envVarsService,
            );
            executionAdapter = new PytestTestExecutionAdapter(
                this.configSettings,
                resultResolver,
                this.envVarsService,
            );
        }

        const workspaceTestAdapter = new WorkspaceTestAdapter(
            testProvider,
            discoveryAdapter,
            executionAdapter,
            projectRoot.uri, // Use project root URI instead of workspace URI
            resultResolver,
        );

        return {
            adapter: workspaceTestAdapter,
            projectRoot,
        };
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
        try {
            if (uri) {
                await this.refreshSingleWorkspace(uri);
            } else {
                await this.refreshAllWorkspaces();
            }
        } finally {
            this.refreshingCompletedEvent.fire();
        }
    }

    /**
     * Discovers tests for a single workspace.
     */
    private async refreshSingleWorkspace(uri: Uri): Promise<void> {
        const workspace = this.workspaceService.getWorkspaceFolder(uri);
        if (!workspace?.uri) {
            traceError('Unable to find workspace for given file');
            return;
        }

        const settings = this.configSettings.getSettings(uri);
        traceVerbose(`Discover tests for workspace name: ${workspace.name} - uri: ${uri.fsPath}`);

        // Ensure we send test telemetry if it gets disabled again
        this.sendTestDisabledTelemetry = true;

        if (settings.testing.pytestEnabled) {
            await this.discoverTestsForProvider(workspace.uri, 'pytest');
        } else if (settings.testing.unittestEnabled) {
            await this.discoverTestsForProvider(workspace.uri, 'unittest');
        } else {
            await this.handleNoTestProviderEnabled(workspace);
        }
    }

    /**
     * Discovers tests for all workspaces in the workspace folders.
     */
    private async refreshAllWorkspaces(): Promise<void> {
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
                await this.refreshSingleWorkspace(workspace.uri);
            }),
        );
    }

    /**
     * Discovers tests for a specific test provider (pytest or unittest).
     * Detects all project roots within the workspace and runs discovery for each project.
     */
    private async discoverTestsForProvider(workspaceUri: Uri, expectedProvider: TestProvider): Promise<void> {
        const workspaceKey = workspaceUri.toString();

        // Step 1: Detect all project roots in the workspace
        traceVerbose(`Detecting ${expectedProvider} projects in workspace: ${workspaceUri.fsPath}`);
        const projectRoots = await findProjectRoots(workspaceUri, expectedProvider);
        traceVerbose(`Found ${projectRoots.length} project(s) in workspace ${workspaceUri.fsPath}`);

        // Step 2: Create or reuse adapters for each project
        const existingAdapters = this.testAdapters.get(workspaceKey) || [];
        const newAdapters: ProjectTestAdapter[] = [];

        for (const projectRoot of projectRoots) {
            // Check if we already have an adapter for this project
            const existingAdapter = existingAdapters.find(
                (a) => a.projectRoot.uri.fsPath === projectRoot.uri.fsPath && a.adapter.getTestProvider() === expectedProvider,
            );

            if (existingAdapter) {
                traceVerbose(`Reusing existing adapter for project at ${projectRoot.uri.fsPath}`);
                newAdapters.push(existingAdapter);
            } else {
                // Create new adapter for this project
                const projectAdapter = this.createProjectAdapter(workspaceUri, projectRoot, expectedProvider);
                newAdapters.push(projectAdapter);
            }
        }

        // Update the adapters map
        this.testAdapters.set(workspaceKey, newAdapters);

        // Step 3: Run discovery for each project
        const interpreter = await this.interpreterService.getActiveInterpreter(workspaceUri);
        await Promise.all(
            newAdapters.map(async ({ adapter, projectRoot }) => {
                traceVerbose(
                    `Running ${expectedProvider} discovery for project at ${projectRoot.uri.fsPath}`,
                );
                try {
                    await adapter.discoverTests(
                        this.testController,
                        this.pythonExecFactory,
                        this.refreshCancellation.token,
                        interpreter,
                    );
                } catch (error) {
                    traceError(
                        `Error during ${expectedProvider} discovery for project at ${projectRoot.uri.fsPath}:`,
                        error,
                    );
                    this.surfaceErrorNode(
                        projectRoot.uri,
                        `Error discovering tests in project at ${projectRoot.uri.fsPath}: ${error}`,
                        expectedProvider,
                    );
                }
            }),
        );
    }

    /**
     * Handles the case when no test provider is enabled.
     * Sends telemetry and removes test items for the workspace from the tree.
     */
    private async handleNoTestProviderEnabled(workspace: WorkspaceFolder): Promise<void> {
        if (this.sendTestDisabledTelemetry) {
            this.sendTestDisabledTelemetry = false;
            sendTelemetryEvent(EventName.UNITTEST_DISABLED);
        }

        this.removeTestItemsForWorkspace(workspace);
    }

    /**
     * Removes all test items belonging to a specific workspace from the test controller.
     * This is used when test discovery is disabled for a workspace.
     */
    private removeTestItemsForWorkspace(workspace: WorkspaceFolder): void {
        const itemsToDelete: string[] = [];

        this.testController.items.forEach((testItem: TestItem) => {
            const itemWorkspace = this.workspaceService.getWorkspaceFolder(testItem.uri);
            if (itemWorkspace?.uri.fsPath === workspace.uri.fsPath) {
                itemsToDelete.push(testItem.id);
            }
        });

        itemsToDelete.forEach((id) => this.testController.items.delete(id));
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
        const workspaces = this.getWorkspacesForTestRun(request);
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
                workspaces.map((workspace) =>
                    this.runTestsForWorkspace(workspace, request, runInstance, token, unconfiguredWorkspaces),
                ),
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

    /**
     * Gets the list of workspaces to run tests for based on the test run request.
     */
    private getWorkspacesForTestRun(request: TestRunRequest): WorkspaceFolder[] {
        if (request.include) {
            const workspaces: WorkspaceFolder[] = [];
            uniq(request.include.map((r) => this.workspaceService.getWorkspaceFolder(r.uri))).forEach((w) => {
                if (w) {
                    workspaces.push(w);
                }
            });
            return workspaces;
        }
        return Array.from(this.workspaceService.workspaceFolders || []);
    }

    /**
     * Runs tests for a single workspace.
     * Groups tests by project and executes them using the appropriate project adapter.
     */
    private async runTestsForWorkspace(
        workspace: WorkspaceFolder,
        request: TestRunRequest,
        runInstance: TestRun,
        token: CancellationToken,
        unconfiguredWorkspaces: WorkspaceFolder[],
    ): Promise<void> {
        if (!(await this.interpreterService.getActiveInterpreter(workspace.uri))) {
            this.commandManager
                .executeCommand(constants.Commands.TriggerEnvironmentSelection, workspace.uri)
                .then(noop, noop);
            return;
        }

        const testItems = this.getTestItemsForWorkspace(workspace, request);
        const settings = this.configSettings.getSettings(workspace.uri);

        if (testItems.length === 0) {
            if (!settings.testing.pytestEnabled && !settings.testing.unittestEnabled) {
                unconfiguredWorkspaces.push(workspace);
            }
            return;
        }

        // Get project adapters for this workspace
        const workspaceKey = workspace.uri.toString();
        const projectAdapters = this.testAdapters.get(workspaceKey) || [];

        if (projectAdapters.length === 0) {
            traceError('No test adapters found for workspace. Tests may not have been discovered yet.');
            unconfiguredWorkspaces.push(workspace);
            return;
        }

        // Group test items by project
        const testItemsByProject = new Map<string, TestItem[]>();
        for (const testItem of testItems) {
            // Find which project this test belongs to
            const projectAdapter = projectAdapters.find(({ projectRoot }) => {
                const testPath = testItem.uri?.fsPath;
                if (!testPath) {
                    return false;
                }
                return isFileInProject(testPath, projectRoot);
            });

            if (projectAdapter) {
                const projectKey = projectAdapter.projectRoot.uri.fsPath;
                if (!testItemsByProject.has(projectKey)) {
                    testItemsByProject.set(projectKey, []);
                }
                testItemsByProject.get(projectKey)!.push(testItem);
            } else {
                traceError(`Could not find project adapter for test: ${testItem.id}`);
            }
        }

        // Execute tests for each project
        const testProvider = settings.testing.pytestEnabled ? 'pytest' : 'unittest';
        await Promise.all(
            Array.from(testItemsByProject.entries()).map(async ([projectPath, projectTestItems]) => {
                const projectAdapter = projectAdapters.find(
                    ({ projectRoot }) => projectRoot.uri.fsPath === projectPath,
                );

                if (!projectAdapter) {
                    traceError(`Project adapter not found for project at ${projectPath}`);
                    return;
                }

                this.setupCoverageIfNeeded(request, projectAdapter.adapter);

                await this.executeTestsForProvider(
                    workspace,
                    projectAdapter.adapter,
                    projectTestItems,
                    runInstance,
                    request,
                    token,
                    testProvider,
                );
            }),
        );
    }

    /**
     * Gets test items that belong to a specific workspace from the run request.
     */
    private getTestItemsForWorkspace(workspace: WorkspaceFolder, request: TestRunRequest): TestItem[] {
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
        return testItems;
    }

    /**
     * Sets up detailed coverage loading if the run profile is for coverage.
     */
    private setupCoverageIfNeeded(request: TestRunRequest, testAdapter: WorkspaceTestAdapter): void {
        // no profile will have TestRunProfileKind.Coverage if rewrite isn't enabled
        if (request.profile?.kind && request.profile?.kind === TestRunProfileKind.Coverage) {
            request.profile.loadDetailedCoverage = (
                _testRun: TestRun,
                fileCoverage,
                _token,
            ): Thenable<FileCoverageDetail[]> => {
                const details = testAdapter.resultResolver.detailedCoverageMap.get(fileCoverage.uri.fsPath);
                if (details === undefined) {
                    // given file has no detailed coverage data
                    return Promise.resolve([]);
                }
                return Promise.resolve(details);
            };
        }
    }

    /**
     * Executes tests using the test adapter for a specific test provider.
     */
    private async executeTestsForProvider(
        workspace: WorkspaceFolder,
        testAdapter: WorkspaceTestAdapter,
        testItems: TestItem[],
        runInstance: TestRun,
        request: TestRunRequest,
        token: CancellationToken,
        provider: TestProvider,
    ): Promise<void> {
        sendTelemetryEvent(EventName.UNITTEST_RUN, undefined, {
            tool: provider,
            debugging: request.profile?.kind === TestRunProfileKind.Debug,
        });

        await testAdapter.executeTests(
            this.testController,
            runInstance,
            testItems,
            this.pythonExecFactory,
            token,
            request.profile?.kind,
            this.debugLauncher,
            await this.interpreterService.getActiveInterpreter(workspace.uri),
        );
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
                const settings = this.configSettings.getSettings(doc.uri);
                if (
                    settings.testing.autoTestDiscoverOnSaveEnabled &&
                    minimatch.default(doc.uri.fsPath, settings.testing.autoTestDiscoverOnSavePattern)
                ) {
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

    private surfaceErrorNode(workspaceUri: Uri, message: string, testProvider: TestProvider): void {
        let errorNode = this.testController.items.get(`DiscoveryError:${workspaceUri.fsPath}`);
        if (errorNode === undefined) {
            const options = buildErrorNodeOptions(workspaceUri, message, testProvider);
            errorNode = createErrorTestItem(this.testController, options);
            this.testController.items.add(errorNode);
        }
        const errorNodeLabel: MarkdownString = new MarkdownString(message);
        errorNodeLabel.isTrusted = true;
        errorNode.error = errorNodeLabel;
    }
}
