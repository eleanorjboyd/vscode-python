// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { ConfigurationTarget, Disposable } from 'vscode';
import { Commands } from '../../common/constants';
import { IDisposableRegistry, IInterpreterPathService } from '../../common/types';
import { registerCommand } from '../../common/vscodeApis/commandApis';
import { IInterpreterQuickPick } from '../../interpreter/configuration/types';
import { getCreationEvents, handleCreateEnvironmentCommand } from './createEnvironment';
import { condaCreationProvider } from './provider/condaCreationProvider';
import { VenvCreationProvider } from './provider/venvCreationProvider';
import { CreateEnvironmentOptions, CreateEnvironmentProvider, CreateEnvironmentResult } from './types';
import { showInformationMessage } from '../../common/vscodeApis/windowApis';
import { CreateEnv } from '../../common/utils/localize';

class CreateEnvironmentProviders {
    private _createEnvProviders: CreateEnvironmentProvider[] = [];

    constructor() {
        this._createEnvProviders = [];
    }

    public add(provider: CreateEnvironmentProvider) {
        this._createEnvProviders.push(provider);
    }

    public remove(provider: CreateEnvironmentProvider) {
        this._createEnvProviders = this._createEnvProviders.filter((p) => p !== provider);
    }

    public getAll(): readonly CreateEnvironmentProvider[] {
        return this._createEnvProviders;
    }
}

const _createEnvironmentProviders: CreateEnvironmentProviders = new CreateEnvironmentProviders();

export function registerCreateEnvironmentProvider(provider: CreateEnvironmentProvider): Disposable {
    _createEnvironmentProviders.add(provider);
    return new Disposable(() => {
        _createEnvironmentProviders.remove(provider);
    });
}

export const { onCreateEnvironmentStarted, onCreateEnvironmentExited, isCreatingEnvironment } = getCreationEvents();

export function registerCreateEnvironmentFeatures(
    disposables: IDisposableRegistry,
    interpreterQuickPick: IInterpreterQuickPick,
    interpreterPathService: IInterpreterPathService,
): void {
    disposables.push(
        registerCommand(
            Commands.Create_Environment,
            (options?: CreateEnvironmentOptions): Promise<CreateEnvironmentResult | undefined> => {
                const providers = _createEnvironmentProviders.getAll();
                return handleCreateEnvironmentCommand(providers, options);
            },
        ),
    );
    disposables.push(registerCreateEnvironmentProvider(new VenvCreationProvider(interpreterQuickPick)));
    disposables.push(registerCreateEnvironmentProvider(condaCreationProvider()));
    disposables.push(
        onCreateEnvironmentExited(async (e: CreateEnvironmentResult | undefined) => {
            if (e && e.path) {
                await interpreterPathService.update(e.uri, ConfigurationTarget.WorkspaceFolder, e.path);
                showInformationMessage(`${CreateEnv.informEnvCreation} ${e.path}`);
            }
        }),
    );
}
