// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { inject, injectable } from 'inversify';

import { IEnvironmentActivationService } from '../../interpreter/activation/types';
import { IActivatedEnvironmentLaunch, IComponentAdapter } from '../../interpreter/contracts';
import { IServiceContainer } from '../../ioc/types';
import { sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { IFileSystem } from '../platform/types';
import { IConfigurationService, IDisposableRegistry, IInterpreterPathService } from '../types';
import { ProcessService } from './proc';
import { createCondaEnv, createPythonEnv, createMicrosoftStoreEnv, createPixiEnv } from './pythonEnvironment';
import { createPythonProcessService } from './pythonProcess';
import {
    ExecutionFactoryCreateWithEnvironmentOptions,
    ExecutionFactoryCreationOptions,
    IProcessLogger,
    IProcessService,
    IProcessServiceFactory,
    IPythonEnvironment,
    IPythonExecutionFactory,
    IPythonExecutionService,
} from './types';
import { IInterpreterAutoSelectionService } from '../../interpreter/autoSelection/types';
import { sleep } from '../utils/async';
import { traceError } from '../../logging';
import { getPixi, getPixiEnvironmentFromInterpreter } from '../../pythonEnvironments/common/environmentManagers/pixi';

@injectable()
export class PythonExecutionFactory implements IPythonExecutionFactory {
    private readonly disposables: IDisposableRegistry;

    private readonly logger: IProcessLogger;

    private readonly fileSystem: IFileSystem;

    constructor(
        @inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(IEnvironmentActivationService) private readonly activationHelper: IEnvironmentActivationService,
        @inject(IProcessServiceFactory) private readonly processServiceFactory: IProcessServiceFactory,
        @inject(IConfigurationService) private readonly configService: IConfigurationService,
        @inject(IComponentAdapter) private readonly pyenvs: IComponentAdapter,
        @inject(IInterpreterAutoSelectionService) private readonly autoSelection: IInterpreterAutoSelectionService,
        @inject(IInterpreterPathService) private readonly interpreterPathExpHelper: IInterpreterPathService,
    ) {
        // Acquire other objects here so that if we are called during dispose they are available.
        this.disposables = this.serviceContainer.get<IDisposableRegistry>(IDisposableRegistry);
        this.logger = this.serviceContainer.get<IProcessLogger>(IProcessLogger);
        this.fileSystem = this.serviceContainer.get<IFileSystem>(IFileSystem);
    }

    public async create(options: ExecutionFactoryCreationOptions): Promise<IPythonExecutionService> {
        console.log('EJFB, 4.1');
        let { pythonPath } = options;
        if (!pythonPath || pythonPath === 'python') {
            const activatedEnvLaunch = this.serviceContainer.get<IActivatedEnvironmentLaunch>(
                IActivatedEnvironmentLaunch,
            );
            console.log('EJFB, 4.2');
            await activatedEnvLaunch.selectIfLaunchedViaActivatedEnv();
            // If python path wasn't passed in, we need to auto select it and then read it
            // from the configuration.
            const interpreterPath = this.interpreterPathExpHelper.get(options.resource);
            console.log('EJFB, 4.3');
            if (!interpreterPath || interpreterPath === 'python') {
                // Block on autoselection if no interpreter selected.
                // Note autoselection blocks on discovery, so we do not want discovery component
                // to block on this code. Discovery component should 'options.pythonPath' before
                // calling into this, so this scenario should not happen. But in case consumer
                // makes such an error. So break the loop via timeout and log error.
                console.log('EJFB, 4.4');
                const success = await Promise.race([
                    this.autoSelection.autoSelectInterpreter(options.resource).then(() => true),
                    sleep(50000).then(() => false),
                ]);
                console.log('EJFB, 4.5');
                if (!success) {
                    traceError(
                        'Autoselection timeout out, this is likely a issue with how consumer called execution factory API. Using default python to execute.',
                    );
                }
            }
            console.log('EJFB, 4.6');
            pythonPath = this.configService.getSettings(options.resource).pythonPath;
        }
        console.log('EJFB, 4.7');
        const processService: IProcessService = await this.processServiceFactory.create(options.resource);
        console.log('EJFB, 4.8');
        if (await getPixi()) {
            const pixiExecutionService = await this.createPixiExecutionService(pythonPath, processService);
            if (pixiExecutionService) {
                return pixiExecutionService;
            }
        }
        console.log('EJFB, 4.9');
        const condaExecutionService = await this.createCondaExecutionService(pythonPath, processService);
        if (condaExecutionService) {
            return condaExecutionService;
        }
        console.log('EJFB, 4.10');
        const windowsStoreInterpreterCheck = this.pyenvs.isMicrosoftStoreInterpreter.bind(this.pyenvs);
        console.log('EJFB, 4.11');
        const env = (await windowsStoreInterpreterCheck(pythonPath))
            ? createMicrosoftStoreEnv(pythonPath, processService)
            : createPythonEnv(pythonPath, processService, this.fileSystem);
        console.log('EJFB, 4.12');
        return createPythonService(processService, env);
    }

    public async createActivatedEnvironment(
        options: ExecutionFactoryCreateWithEnvironmentOptions,
    ): Promise<IPythonExecutionService> {
        console.log('EJFB, inside createAE');
        const envVars = await this.activationHelper.getActivatedEnvironmentVariables(
            options.resource,
            options.interpreter,
            options.allowEnvironmentFetchExceptions,
        );
        console.log('EJFB, 1');
        const hasEnvVars = envVars && Object.keys(envVars).length > 0;
        sendTelemetryEvent(EventName.PYTHON_INTERPRETER_ACTIVATION_ENVIRONMENT_VARIABLES, undefined, { hasEnvVars });
        if (!hasEnvVars) {
            return this.create({
                resource: options.resource,
                pythonPath: options.interpreter ? options.interpreter.path : undefined,
            });
        }
        console.log('EJFB,2');
        const pythonPath = options.interpreter
            ? options.interpreter.path
            : this.configService.getSettings(options.resource).pythonPath;
        const processService: IProcessService = new ProcessService({ ...envVars });
        console.log('EJFB,2.5');
        processService.on('exec', this.logger.logProcess.bind(this.logger));
        this.disposables.push(processService);
        console.log('EJFB, 3');
        if (await getPixi()) {
            const pixiExecutionService = await this.createPixiExecutionService(pythonPath, processService);
            console.log('EJFB, 3.5');
            if (pixiExecutionService) {
                return pixiExecutionService;
            }
        }
        console.log('EJFB, 4');
        const condaExecutionService = await this.createCondaExecutionService(pythonPath, processService);
        console.log('EJFB,4.5');
        if (condaExecutionService) {
            return condaExecutionService;
        }
        console.log('EJFB, a5');
        const env = createPythonEnv(pythonPath, processService, this.fileSystem);
        console.log('EJFB,5.5');
        return createPythonService(processService, env);
    }

    public async createCondaExecutionService(
        pythonPath: string,
        processService: IProcessService,
    ): Promise<IPythonExecutionService | undefined> {
        const condaLocatorService = this.serviceContainer.get<IComponentAdapter>(IComponentAdapter);
        const [condaEnvironment] = await Promise.all([condaLocatorService.getCondaEnvironment(pythonPath)]);
        if (!condaEnvironment) {
            return undefined;
        }
        const env = await createCondaEnv(condaEnvironment, processService, this.fileSystem);
        if (!env) {
            return undefined;
        }
        return createPythonService(processService, env);
    }

    public async createPixiExecutionService(
        pythonPath: string,
        processService: IProcessService,
    ): Promise<IPythonExecutionService | undefined> {
        const pixiEnvironment = await getPixiEnvironmentFromInterpreter(pythonPath);
        if (!pixiEnvironment) {
            return undefined;
        }

        const env = await createPixiEnv(pixiEnvironment, processService, this.fileSystem);
        if (env) {
            return createPythonService(processService, env);
        }

        return undefined;
    }
}

function createPythonService(procService: IProcessService, env: IPythonEnvironment): IPythonExecutionService {
    const procs = createPythonProcessService(procService, env);
    return {
        getInterpreterInformation: () => env.getInterpreterInformation(),
        getExecutablePath: () => env.getExecutablePath(),
        isModuleInstalled: (m) => env.isModuleInstalled(m),
        getModuleVersion: (m) => env.getModuleVersion(m),
        getExecutionInfo: (a) => env.getExecutionInfo(a),
        execObservable: (a, o) => procs.execObservable(a, o),
        execModuleObservable: (m, a, o) => procs.execModuleObservable(m, a, o),
        exec: (a, o) => procs.exec(a, o),
        execModule: (m, a, o) => procs.execModule(m, a, o),
        execForLinter: (m, a, o) => procs.execForLinter(m, a, o),
    };
}
