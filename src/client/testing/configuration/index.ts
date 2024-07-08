'use strict';

import { inject, injectable } from 'inversify';
import { Uri, workspace, window, Range, Position } from 'vscode';
import { IApplicationShell, IWorkspaceService } from '../../common/application/types';
import { IConfigurationService, Product } from '../../common/types';
import { IServiceContainer } from '../../ioc/types';
import { traceError } from '../../logging';
import { sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { TestConfiguringTelemetry } from '../../telemetry/types';
import { BufferedTestConfigSettingsService } from '../common/bufferedTestConfigSettingService';
import {
    ITestConfigSettingsService,
    ITestConfigurationManager,
    ITestConfigurationManagerFactory,
    ITestConfigurationService,
    ITestsHelper,
    UnitTestProduct,
} from '../common/types';

export const NONE_SELECTED = Error('none selected');

@injectable()
export class UnitTestConfigurationService implements ITestConfigurationService {
    private readonly configurationService: IConfigurationService;

    private readonly appShell: IApplicationShell;

    private readonly workspaceService: IWorkspaceService;

    constructor(@inject(IServiceContainer) private serviceContainer: IServiceContainer) {
        this.configurationService = serviceContainer.get<IConfigurationService>(IConfigurationService);
        this.appShell = serviceContainer.get<IApplicationShell>(IApplicationShell);
        this.workspaceService = serviceContainer.get<IWorkspaceService>(IWorkspaceService);
    }

    public async selectManageConfigAction(wkspace: Uri, frameworkEnum: UnitTestProduct): Promise<string | undefined> {
        await this._manageConfigs(wkspace, frameworkEnum);
        console.log('this', this.displayTestFrameworkError);
        return Promise.resolve(undefined);
    }

    public async displayTestFrameworkError(wkspace: Uri): Promise<void> {
        const settings = this.configurationService.getSettings(wkspace);
        let enabledCount = settings.testing.pytestEnabled ? 1 : 0;
        enabledCount += settings.testing.unittestEnabled ? 1 : 0;
        if (enabledCount > 1) {
            return this._promptToEnableAndConfigureTestFramework(
                wkspace,
                'Enable only one of the test frameworks (unittest or pytest).',
                true,
            );
        }
        const option = 'Enable and configure a Test Framework';
        const item = await this.appShell.showInformationMessage(
            'No test framework configured (unittest, or pytest)',
            option,
        );
        if (item !== option) {
            throw NONE_SELECTED;
        }
        return this._promptToEnableAndConfigureTestFramework(wkspace);
    }

    public async selectTestRunner(placeHolderMessage: string): Promise<UnitTestProduct | undefined> {
        const items = [
            {
                label: 'unittest',
                product: Product.unittest,
                description: 'Standard Python test framework',
                detail: 'https://docs.python.org/3/library/unittest.html',
            },
            {
                label: 'pytest',
                product: Product.pytest,
                description: 'pytest framework',

                detail: 'http://docs.pytest.org/',
            },
        ];
        const options = {
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: placeHolderMessage,
        };
        const selectedTestRunner = await this.appShell.showQuickPick(items, options);

        return selectedTestRunner ? (selectedTestRunner.product as UnitTestProduct) : undefined;
    }

    public async selectManagementAction(): Promise<string | undefined> {
        const items = [
            {
                label: 'Create a new configuration',
                description: 'Create a new configuration for settings.json',
            },
            {
                label: 'Go to settings.json',
                description: 'Go directly to python.configs in settings.json to edit',
            },
        ];
        const options = {
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: 'Select the action to perform',
        };
        const selectedAction = await this.appShell.showQuickPick(items, options);
        console.log(selectedAction);
        return selectedAction ? selectedAction.label : undefined;
    }

    public async enableTest(wkspace: Uri, product: UnitTestProduct): Promise<void> {
        const factory = this.serviceContainer.get<ITestConfigurationManagerFactory>(ITestConfigurationManagerFactory);
        const configMgr = factory.create(wkspace, product);
        return this._enableTest(wkspace, configMgr);
    }

    public async promptToEnableAndConfigureTestFramework(wkspace: Uri, framework?: UnitTestProduct): Promise<void> {
        await this._promptToEnableAndConfigureTestFramework(wkspace, undefined, false, 'commandpalette', framework);
    }

    public async setupQuickRun(wkspace: Uri, frameworkEnum: UnitTestProduct): Promise<void> {
        await this._setupQuickRun(wkspace, frameworkEnum);
    }

    // public async manageConfigs(wkspace: Uri, frameworkEnum: UnitTestProduct): Promise<void> {
    //     await this._manageConfigs(wkspace, frameworkEnum);
    // }

    private _enableTest(wkspace: Uri, configMgr: ITestConfigurationManager) {
        const pythonConfig = this.workspaceService.getConfiguration('python', wkspace);
        if (pythonConfig.get<boolean>('testing.promptToConfigure')) {
            return configMgr.enable();
        }
        return pythonConfig.update('testing.promptToConfigure', undefined).then(
            () => configMgr.enable(),
            (reason) => configMgr.enable().then(() => Promise.reject(reason)),
        );
    }

    private async _manageConfigs(wkspace: Uri, frameworkEnum: UnitTestProduct): Promise<void> {
        const selectedAction = await this.selectManagementAction();
        console.log(selectedAction);
        if (selectedAction === 'Create a new configuration') {
            // send down configure path
            this.promptToEnableAndConfigureTestFramework(wkspace, frameworkEnum);
        } else if (selectedAction === 'Go to settings.json') {
            // open settings.json

            // open settings.json at the "python.configs" if it exists, if not then at the top level
            // Get the path to the settings.json file
            const settingsUri = Uri.file(`${workspace.rootPath}/.vscode/settings.json`);
            if (!settingsUri) {
                traceError('Unable to find settings.json, please create one!');
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
        console.log(frameworkEnum, wkspace);
    }

    private async _promptToEnableAndConfigureTestFramework(
        wkspace: Uri,
        messageToDisplay = 'Select a test framework/tool to enable',
        enableOnly = false,
        trigger: 'ui' | 'commandpalette' = 'ui',
        framework?: UnitTestProduct,
    ): Promise<void> {
        const telemetryProps: TestConfiguringTelemetry = {
            trigger,
            failed: false,
        };
        try {
            let selectedTestRunner;
            if (!framework) {
                // ask user to select a test framework
                selectedTestRunner = await this.selectTestRunner(messageToDisplay);
                if (typeof selectedTestRunner !== 'number') {
                    throw NONE_SELECTED;
                }
            } else {
                selectedTestRunner = framework;
            }

            const helper = this.serviceContainer.get<ITestsHelper>(ITestsHelper);
            telemetryProps.tool = helper.parseProviderName(selectedTestRunner);
            const delayed = new BufferedTestConfigSettingsService();
            const factory = this.serviceContainer.get<ITestConfigurationManagerFactory>(
                ITestConfigurationManagerFactory,
            );
            const configMgr = factory.create(wkspace, selectedTestRunner, delayed);
            if (enableOnly) {
                await configMgr.enable();
            } else {
                // Configure everything before enabling.
                // Cuz we don't want the test engine (in main.ts file - tests get discovered when config changes are detected)
                // to start discovering tests when tests haven't been configured properly.
                // EJFB where config is called
                await configMgr
                    .configure(wkspace)
                    .then(() => this._enableTest(wkspace, configMgr))
                    .catch((reason) => this._enableTest(wkspace, configMgr).then(() => Promise.reject(reason)));
            }
            const cfg = this.serviceContainer.get<ITestConfigSettingsService>(ITestConfigSettingsService);
            try {
                await delayed.apply(cfg);
            } catch (exc) {
                traceError('Python Extension: applying unit test config updates', exc);
                telemetryProps.failed = true;
            }
        } finally {
            sendTelemetryEvent(EventName.UNITTEST_CONFIGURING, undefined, telemetryProps);
        }
    }

    private async _setupQuickRun(wkspace: Uri, frameworkEnum: UnitTestProduct): Promise<void> {
        console.log('Setting up quick run');
        const factory = this.serviceContainer.get<ITestConfigurationManagerFactory>(ITestConfigurationManagerFactory);
        const delayed = new BufferedTestConfigSettingsService();
        // set enablement to frameworkEnum passed to quick run
        const configMgr = factory.create(wkspace, frameworkEnum, delayed);

        await configMgr.enable();
        await configMgr
            .enable()
            .then(() => this._enableTest(wkspace, configMgr))
            .catch((reason) => this._enableTest(wkspace, configMgr).then(() => Promise.reject(reason)));

        const cfg = this.serviceContainer.get<ITestConfigSettingsService>(ITestConfigSettingsService);
        try {
            await delayed.apply(cfg);
        } catch (exc) {
            traceError('Python Extension: applying unit test config updates', exc);
        }
    }
}
