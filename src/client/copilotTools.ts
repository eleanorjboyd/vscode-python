import * as vscode from 'vscode';

interface IGetActiveEnvironment {
    filePath: string;
}

export class GetErrorsTool implements vscode.LanguageModelTool<IGetActiveEnvironment> {
    public static readonly toolName = 'getActiveEnvironment';

    constructor(private isThisTrue: boolean) {}

    invoke(
        options: vscode.LanguageModelToolInvocationOptions<IGetActiveEnvironment>,
        _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.LanguageModelToolResult> {
        const parameters: IGetActiveEnvironment = options.input;
        if (!parameters.filePath) {
            throw new Error('Invalid input');
        }
        this.isThisTrue = true;
        console.log('This is true', this.isThisTrue);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('invoked finished!')]);
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<IGetActiveEnvironment>,
        _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        console.log(this.isThisTrue, options);
        console.log('preparing invocation');
        return {
            invocationMessage: 'preparing the invocation..... ',
        };
    }
}

export function registerChatTools(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.lm.registerTool('python_get_active_environment', new GetErrorsTool(false)));
}
