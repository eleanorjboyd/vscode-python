'use strict';

import { inject, injectable } from 'inversify';
import {
    ConfigurationChangeEvent,
    Disposable,
    Uri,
    tests,
    TestResultState,
    WorkspaceFolder,
    workspace,
    window,
    Position,
    Range,
} from 'vscode';
import { IApplicationShell, ICommandManager, IContextKeyManager, IWorkspaceService } from '../common/application/types';
import * as constants from '../common/constants';
import '../common/extensions';
import { IDisposableRegistry, Product } from '../common/types';
import { IInterpreterService } from '../interpreter/contracts';
import { IServiceContainer } from '../ioc/types';
import { EventName } from '../telemetry/constants';
import { captureTelemetry, sendTelemetryEvent } from '../telemetry/index';
import { selectTestWorkspace } from './common/testUtils';
import { TestSettingsPropertyNames } from './configuration/types';
import { ITestConfigurationService, ITestsHelper, UnitTestProduct } from './common/types';
import { ITestingService } from './types';
import { IExtensionActivationService } from '../activation/types';
import { ITestController } from './testController/common/types';
import { DelayedTrigger, IDelayedTrigger } from '../common/utils/delayTrigger';
import { ExtensionContextKey } from '../common/application/contextKeys';
import { checkForFailedTests, updateTestResultMap } from './testController/common/testItemUtilities';
import { Testing } from '../common/utils/localize';
import { traceVerbose } from '../logging';

@injectable()
export class TestingService implements ITestingService {
    constructor(@inject(IServiceContainer) private serviceContainer: IServiceContainer) {}

    public getSettingsPropertyNames(product: Product): TestSettingsPropertyNames {
        const helper = this.serviceContainer.get<ITestsHelper>(ITestsHelper);
        return helper.getSettingsPropertyNames(product);
    }
}

@injectable()
export class UnitTestManagementService implements IExtensionActivationService {
    private activatedOnce: boolean = false;
    public readonly supportedWorkspaceTypes = { untrustedWorkspace: false, virtualWorkspace: false };
    private readonly disposableRegistry: Disposable[];
    private workspaceService: IWorkspaceService;
    private context: IContextKeyManager;
    private testController: ITestController | undefined;
    private configChangeTrigger: IDelayedTrigger;

    // This is temporarily needed until the proposed API settles for this part
    private testStateMap: Map<string, TestResultState> = new Map();

    constructor(@inject(IServiceContainer) private serviceContainer: IServiceContainer) {
        this.disposableRegistry = serviceContainer.get<Disposable[]>(IDisposableRegistry);
        this.workspaceService = serviceContainer.get<IWorkspaceService>(IWorkspaceService);
        this.context = this.serviceContainer.get<IContextKeyManager>(IContextKeyManager);

        if (tests && !!tests.createTestController) {
            this.testController = serviceContainer.get<ITestController>(ITestController);
        }

        const configChangeTrigger = new DelayedTrigger(
            this.configurationChangeHandler.bind(this),
            500,
            'Test Configuration Change',
        );
        this.configChangeTrigger = configChangeTrigger;
        this.disposableRegistry.push(configChangeTrigger);
    }

    public async activate(): Promise<void> {
        if (this.activatedOnce) {
            return;
        }
        this.activatedOnce = true;
        // TODO: Remove
        this.manageTestConfigs();

        this.registerHandlers();
        this.registerCommands();

        if (!!tests.testResults) {
            await this.updateTestUIButtons();
            this.disposableRegistry.push(
                tests.onDidChangeTestResults(() => {
                    this.updateTestUIButtons();
                }),
            );
        }

        // set context key for test framework
        let myContextKey = 'python.pytestFrameworkEnabled';
        const commandManager = this.serviceContainer.get<ICommandManager>(ICommandManager);
        commandManager.executeCommand('setContext', myContextKey, true);

        if (this.testController) {
            this.testController.onRefreshingStarted(async () => {
                await this.context.setContext(ExtensionContextKey.RefreshingTests, true);
            });
            this.testController.onRefreshingCompleted(async () => {
                await this.context.setContext(ExtensionContextKey.RefreshingTests, false);
            });
            this.testController.onRunWithoutConfiguration(async (unconfigured: WorkspaceFolder[]) => {
                const workspaces = this.workspaceService.workspaceFolders ?? [];
                if (unconfigured.length === workspaces.length) {
                    const commandManager = this.serviceContainer.get<ICommandManager>(ICommandManager);
                    await commandManager.executeCommand('workbench.view.testing.focus');

                    // TODO: this is a workaround for https://github.com/microsoft/vscode/issues/130696
                    // Once that is fixed delete this notification and test should be configured from the test view.
                    const app = this.serviceContainer.get<IApplicationShell>(IApplicationShell);
                    const response = await app.showInformationMessage(
                        Testing.testNotConfigured,
                        Testing.configureTests,
                    );
                    if (response === Testing.configureTests) {
                        await commandManager.executeCommand(
                            constants.Commands.Tests_Configure, //ejfb: CHECK THIS
                            undefined,
                            undefined,
                            constants.CommandSource.ui,
                            unconfigured[0].uri,
                        );
                    }
                }
            });
        }
    }

    private async updateTestUIButtons() {
        // See if we already have stored tests results from previous runs.
        // The tests results currently has a historical test status based on runs. To get a
        // full picture of the tests state these need to be reduced by test id.
        updateTestResultMap(this.testStateMap, tests.testResults);

        const hasFailedTests = checkForFailedTests(this.testStateMap);
        await this.context.setContext(ExtensionContextKey.HasFailedTests, hasFailedTests);
    }

    private async configurationChangeHandler(eventArgs: ConfigurationChangeEvent) {
        const workspaces = this.workspaceService.workspaceFolders ?? [];
        const changedWorkspaces: Uri[] = workspaces
            .filter((w) => eventArgs.affectsConfiguration('python.testing', w.uri))
            .map((w) => w.uri);

        await Promise.all(changedWorkspaces.map((u) => this.testController?.refreshTestData(u)));
    }

    private async manageTestConfigs() {
        // show action menu (actions being, add, remove, go to...)
        const configurationService = this.serviceContainer.get<ITestConfigurationService>(ITestConfigurationService);

        await configurationService.selectManageConfigAction();
    }

    @captureTelemetry(EventName.UNITTEST_CONFIGURE, undefined, false)
    private async configureTests() {
        // open settings.json at the "python.configs" if it exists, if not then at the top level
        // Get the path to the settings.json file
        const settingsUri = Uri.file(`${workspace.rootPath}/.vscode/settings.json`);
        if (!settingsUri) {
            return;
        }
        const document = await workspace.openTextDocument(settingsUri);
        const editor = await window.showTextDocument(document);
        // Parse the JSON contentDEY
        const text = document.getText();
        // const json = JSON.parse(text);

        // Check if "python.configs" exists
        const pythonConfigsPosition = text.indexOf('"python.configs"');
        if (pythonConfigsPosition !== -1) {
            // If "python.configs" exists, reveal it
            const position = document.positionAt(pythonConfigsPosition);
            // const position = new Position(pythonConfigsPosition, 0);

            editor.revealRange(new Range(position, position));
        } else {
            const position = new Position(0, 0);
            editor.revealRange(new Range(position, position));
        }
    }

    @captureTelemetry(EventName.UNITTEST_CONFIGURE, undefined, false)
    private async addConfig(quickConfig: boolean, resource?: Uri, framework?: string) {
        // have ALL go through here
        let wkspace: Uri | undefined;
        if (resource) {
            const wkspaceFolder = this.workspaceService.getWorkspaceFolder(resource);
            wkspace = wkspaceFolder ? wkspaceFolder.uri : undefined;
        } else {
            const appShell = this.serviceContainer.get<IApplicationShell>(IApplicationShell);
            wkspace = await selectTestWorkspace(appShell);
        }
        if (!wkspace) {
            return;
        }
        const interpreterService = this.serviceContainer.get<IInterpreterService>(IInterpreterService);
        const commandManager = this.serviceContainer.get<ICommandManager>(ICommandManager);
        if (!(await interpreterService.getActiveInterpreter(wkspace))) {
            commandManager.executeCommand(constants.Commands.TriggerEnvironmentSelection, wkspace);
            return;
        }
        const configurationService = this.serviceContainer.get<ITestConfigurationService>(ITestConfigurationService);

        let frameworkEnum: UnitTestProduct | undefined;
        if (framework) {
            // might need to check - if framework is not empty string?
            switch (framework) {
                case 'pytest':
                    frameworkEnum = Product.pytest;
                    break;
                case 'unittest':
                    frameworkEnum = Product.unittest;
                    break;
                default:
                    throw new Error('Invalid Test Framework');
            }
        }
        if (quickConfig && frameworkEnum) {
            await configurationService.setupQuickRun(wkspace!, frameworkEnum);
        } else {
            await configurationService.promptToEnableAndConfigureTestFramework(wkspace!, frameworkEnum);
        }
    }
    private registerCommands(): void {
        const commandManager = this.serviceContainer.get<ICommandManager>(ICommandManager);

        this.disposableRegistry.push(
            commandManager.registerCommand(
                constants.Commands.Tests_Configure,
                (
                    arg1: string | undefined,
                    arg2: string | undefined,
                    _cmdSource: constants.CommandSource = constants.CommandSource.commandPalette,
                    resource?: Uri,
                ) => {
                    const framework = arg1 as string | undefined;
                    // if quickConfig is undefined, it will be set to false
                    let quickConfig = arg2 === 'true';

                    // Ignore the exceptions returned.
                    // This command will be invoked from other places of the extension.
                    // EJFB: this is what is called when that button is pressed
                    this.addConfig(quickConfig, resource, framework).ignoreErrors();
                    traceVerbose('Testing: Trigger refresh after config change');
                    this.testController?.refreshTestData(resource, { forceRefresh: true });
                    this.testController?.refreshTestConfigs(resource, { forceRefresh: true });
                },
            ),
            commandManager.registerCommand(
                constants.Commands.Change_Test_Framework,
                (
                    currFramework: string | undefined,
                    _cmdSource: constants.CommandSource = constants.CommandSource.commandPalette,
                    _resource?: Uri,
                ) => {
                    let myContextKey = 'python.pytestFrameworkEnabled';
                    let updatedVal = false;
                    switch (currFramework) {
                        case 'pytest':
                            // switch to unittest
                            updatedVal = false;
                            break;
                        case 'unittest':
                            // switch to pytest
                            updatedVal = true;
                            break;
                        default:
                            break;
                    }
                    const commandManager = this.serviceContainer.get<ICommandManager>(ICommandManager);
                    commandManager.executeCommand('setContext', myContextKey, updatedVal);
                },
            ),
            commandManager.registerCommand(
                constants.Commands.Test_Add_Config,
                (_, _cmdSource: constants.CommandSource = constants.CommandSource.commandPalette, resource?: Uri) => {
                    traceVerbose('Testing, manage config, triggering manage config submenu', resource);
                    this.addConfig(false, resource).ignoreErrors();

                    // this.testController?.refreshTestData(resource, { forceRefresh: true });
                    // this.testController?.refreshTestConfigs(resource, { forceRefresh: true });
                },
            ),
            commandManager.registerCommand(
                constants.Commands.Test_Manage_Configs,
                (_, _cmdSource: constants.CommandSource = constants.CommandSource.commandPalette, resource?: Uri) => {
                    traceVerbose('Testing, manage config, triggering manage config submenu', resource);
                    this.configureTests().ignoreErrors();

                    // this.testController?.refreshTestData(resource, { forceRefresh: true });
                    // this.testController?.refreshTestConfigs(resource, { forceRefresh: true });
                },
            ),
        );
    }

    private registerHandlers() {
        const interpreterService = this.serviceContainer.get<IInterpreterService>(IInterpreterService);
        this.disposableRegistry.push(
            this.workspaceService.onDidChangeConfiguration((e) => {
                this.configChangeTrigger.trigger(e);
            }),
            interpreterService.onDidChangeInterpreter(async () => {
                traceVerbose('Testing: Triggered refresh due to interpreter change.');
                sendTelemetryEvent(EventName.UNITTEST_DISCOVERY_TRIGGER, undefined, { trigger: 'interpreter' });
                await this.testController?.refreshTestData(undefined, { forceRefresh: true });
            }),
        );
    }
}
