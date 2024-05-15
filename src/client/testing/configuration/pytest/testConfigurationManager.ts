import * as path from 'path';
import { QuickPickItem, Uri } from 'vscode';
import { IFileSystem } from '../../../common/platform/types';
import { Product } from '../../../common/types';
import { IServiceContainer } from '../../../ioc/types';
import { TestConfigurationManager } from '../../common/testConfigurationManager';
import { ITestConfigSettingsService } from '../../common/types';
import { traceInfo } from '../../../logging';
import { TestConfig, configSubType, configType, frameworkType } from '../types';

export class ConfigurationManager extends TestConfigurationManager {
    constructor(workspace: Uri, serviceContainer: IServiceContainer, cfg?: ITestConfigSettingsService) {
        super(workspace, Product.pytest, serviceContainer, cfg);
    }

    public async requiresUserToConfigure(wkspace: Uri): Promise<boolean> {
        const configFiles = await this.getConfigFiles(wkspace.fsPath);
        // If a config file exits, there's nothing to be configured.
        if (configFiles.length > 0 && configFiles.length !== 1 && configFiles[0] !== 'setup.cfg') {
            return false;
        }
        return true;
    }

    public async configure(wkspace: Uri): Promise<void> {
        // Here is the function used for configuring pytest.
        // new flow:
        const args: string[] = [];
        const configFileOptionLabel = 'Use existing config file';
        const options: QuickPickItem[] = [];

        // optional: name of new config
        const configName = await this.selectConfigName();
        console.log(configName);
        // config type (discovery, run, debug)
        const configSubTypeListRaw: string[] = await this.selectConfigType();

        // convert user selected list to the right enum type
        const configSubTypeList: configSubType[] = [];
        for (const subtype of configSubTypeListRaw) {
            switch (subtype) {
                case 'testRun':
                    configSubTypeList.push(configSubType.testRun);
                    break;
                case 'testDiscovery':
                    configSubTypeList.push(configSubType.testDiscovery);
                    break;
                case 'testDebug':
                    configSubTypeList.push(configSubType.testDebug);
                    break;
                default:
                    console.log(`Unknown test config subtype: ${subtype}`);
                    break;
            }
        }

        // test directory
        const subDirs = await this.getTestDirs(wkspace.fsPath);
        const testDir = await this.selectTestDir(wkspace.fsPath, subDirs, options);
        if (typeof testDir === 'string' && testDir !== configFileOptionLabel) {
            args.push(testDir);
        }
        // optional? testing args
        // optional: env file, config file, environment variables

        const installed = await this.installer.isInstalled(Product.pytest);
        if (!installed) {
            await this.installer.install(Product.pytest);
        }
        const configArg: TestConfig = {
            name: configName,
            type: configType.test,
            subtype: configSubTypeList,
            args: [],
            framework: frameworkType.pytest,
        };
        await this.testConfigSettingsService.updateTestArgs(wkspace.fsPath, Product.pytest, configArg);

        // print out the traceInfo the entire new configuration
        traceInfo('THE UPDATED CONFIG IS AS FOLLOWS \n \n:', configArg);
    }

    private async getConfigFiles(rootDir: string): Promise<string[]> {
        const fs = this.serviceContainer.get<IFileSystem>(IFileSystem);
        const promises = ['pytest.ini', 'tox.ini', 'setup.cfg'].map(async (cfg) =>
            (await fs.fileExists(path.join(rootDir, cfg))) ? cfg : '',
        );
        const values = await Promise.all(promises);
        return values.filter((exists) => exists.length > 0);
    }
}
