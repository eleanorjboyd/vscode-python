import { inject, injectable } from 'inversify';
import { Uri, WorkspaceConfiguration } from 'vscode';
import { IWorkspaceService } from '../../common/application/types';
import { Product } from '../../common/types';
import { IServiceContainer } from '../../ioc/types';
import { ITestConfigSettingsService, UnitTestProduct } from './types';
import { TestConfig } from '../configuration/types';

@injectable()
export class TestConfigSettingsService implements ITestConfigSettingsService {
    private readonly workspaceService: IWorkspaceService;

    constructor(@inject(IServiceContainer) serviceContainer: IServiceContainer) {
        this.workspaceService = serviceContainer.get<IWorkspaceService>(IWorkspaceService);
    }

    public async updateTestArgs(
        testDirectory: string | Uri,
        product: UnitTestProduct,
        args: string[] | TestConfig,
    ): Promise<void> {
        // get the general config one
        const settingConfig = 'testing.configs';
        let argArray: string[] | TestConfig[] = [];
        if (Array.isArray(args)) {
            argArray = args;
        } else {
            argArray = [args];
        }
        // EJFB: picks the setting from setting.json and then updates it with the correct args
        const setting = this.getTestArgSetting(product);
        console.log('setting', setting);
        return this.updateSetting(testDirectory, settingConfig, argArray);
    }

    public async enable(testDirectory: string | Uri, product: UnitTestProduct): Promise<void> {
        const setting = this.getTestEnablingSetting(product);
        return this.updateSetting(testDirectory, setting, true);
    }

    public async disable(testDirectory: string | Uri, product: UnitTestProduct): Promise<void> {
        const setting = this.getTestEnablingSetting(product);
        return this.updateSetting(testDirectory, setting, false);
    }

    // eslint-disable-next-line class-methods-use-this
    public getTestEnablingSetting(product: UnitTestProduct): string {
        switch (product) {
            case Product.unittest:
                return 'testing.unittestEnabled';
            case Product.pytest:
                return 'testing.pytestEnabled';
            default:
                throw new Error('Invalid Test Product');
        }
    }

    // eslint-disable-next-line class-methods-use-this
    private getTestArgSetting(product: UnitTestProduct): string {
        switch (product) {
            case Product.unittest:
                return 'testing.unittestArgs';
            case Product.pytest:
                return 'testing.pytestArgs';
            default:
                throw new Error('Invalid Test Product');
        }
    }

    private async updateSetting(testDirectory: string | Uri, setting: string, value: unknown) {
        // EJFB: this is called multiple times it seems
        let pythonConfig: WorkspaceConfiguration;
        const resource = typeof testDirectory === 'string' ? Uri.file(testDirectory) : testDirectory;
        const hasWorkspaceFolders = (this.workspaceService.workspaceFolders?.length || 0) > 0;
        if (!hasWorkspaceFolders) {
            pythonConfig = this.workspaceService.getConfiguration('python');
        } else if (this.workspaceService.workspaceFolders!.length === 1) {
            pythonConfig = this.workspaceService.getConfiguration(
                'python',
                this.workspaceService.workspaceFolders![0].uri,
            );
        } else {
            const workspaceFolder = this.workspaceService.getWorkspaceFolder(resource);
            if (!workspaceFolder) {
                throw new Error(`Test directory does not belong to any workspace (${testDirectory})`);
            }

            pythonConfig = this.workspaceService.getConfiguration('python', workspaceFolder.uri);
        }

        return pythonConfig.update(setting, value);
    }
}
