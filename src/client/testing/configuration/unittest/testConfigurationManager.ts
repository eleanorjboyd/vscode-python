import { QuickPickItem, Uri } from 'vscode';
import { Product } from '../../../common/types';
import { IServiceContainer } from '../../../ioc/types';
import { TestConfigurationManager } from '../../common/testConfigurationManager';
import { ITestConfigSettingsService } from '../../common/types';
import { TestConfig, configSubType, configType, frameworkType } from '../types';
import { traceInfo } from '../../../logging';

export class ConfigurationManager extends TestConfigurationManager {
    constructor(workspace: Uri, serviceContainer: IServiceContainer, cfg?: ITestConfigSettingsService) {
        super(workspace, Product.unittest, serviceContainer, cfg);
    }

    // eslint-disable-next-line class-methods-use-this
    public async requiresUserToConfigure(_wkspace: Uri): Promise<boolean> {
        return true;
    }

    public async selectManageConfigAction(): Promise<string | undefined> {
        return this.selectConfigAction();
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
            args.push('-s');
            args.push(testDir);
        }
        const testfilePattern = await this.selectTestFilePattern();
        args.push('-p');
        if (typeof testfilePattern === 'string') {
            args.push(testfilePattern);
        } else {
            args.push('test*.py');
        }

        const installed = await this.installer.isInstalled(Product.unittest);
        if (!installed) {
            await this.installer.install(Product.unittest);
        }
        const configArg: TestConfig = {
            name: configName,
            type: configType.test,
            subtype: configSubTypeList,
            args,
            framework: frameworkType.unittest,
        };
        await this.testConfigSettingsService.updateTestArgs(wkspace.fsPath, Product.unittest, configArg);

        // print out the traceInfo the entire new configuration
        traceInfo('THE UPDATED CONFIG IS AS FOLLOWS \n \n:', configArg);
    }
}
