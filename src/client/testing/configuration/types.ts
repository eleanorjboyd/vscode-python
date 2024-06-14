// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export enum configSubType {
    testRun = 'testRun',
    testDiscovery = 'testDiscovery',
    testDebug = 'testDebug',

    terminalRun = 'terminalRun',
    terminalDebug = 'terminalDebug',
}
export enum configType {
    terminal = 'terminal',
    test = 'test',
}

export enum frameworkType {
    pytest = 'pytest',
    unittest = 'unittest',
}

export interface TestConfig {
    name: string;
    type: configType; // this type refers to if it is `terminal` or `test` type
    subtype?: configSubType[]; // this subtype refers to if it is `run`, `debug`, or `discovery` type
    args: string[];
    framework: frameworkType;
    env?: { [key: string]: string };
    envFile?: string; // TODO: should this be a string or path type?
}
export interface ITestingSettings {
    readonly promptToConfigure: boolean;
    readonly debugPort: number;
    pytestEnabled: boolean;
    pytestPath: string;
    pytestArgs: string[];
    unittestEnabled: boolean;
    unittestArgs: string[];
    cwd?: string;
    readonly autoTestDiscoverOnSaveEnabled: boolean;

    configs: TestConfig[];
}

export type TestSettingsPropertyNames = {
    enabledName: keyof ITestingSettings;
    argsName: keyof ITestingSettings;
    pathName?: keyof ITestingSettings;
};
