import * as eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import prettier from 'eslint-config-prettier';

export default [
    {
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
            globals: {
                ...eslint.configs.node.globals,
                mocha: true,
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
            'no-only-tests': noOnlyTests,
        },
        settings: {
            'import/resolver': {
                node: {
                    extensions: ['.js', '.ts'],
                },
            },
        },
        rules: {
            ...eslint.configs.recommended.rules,
            ...prettier.rules,
            '@typescript-eslint/ban-ts-comment': [
                'error',
                {
                    'ts-ignore': 'allow-with-description',
                },
            ],
            '@typescript-eslint/explicit-module-boundary-types': 'error',
            'no-bitwise': 'off',
            'no-dupe-class-members': 'off',
            '@typescript-eslint/no-dupe-class-members': 'error',
            'no-empty-function': 'off',
            '@typescript-eslint/no-empty-function': ['error'],
            '@typescript-eslint/no-empty-interface': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'off',
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                },
            ],
            'no-use-before-define': 'off',
            '@typescript-eslint/no-use-before-define': [
                'error',
                {
                    functions: false,
                },
            ],
            'no-useless-constructor': 'off',
            '@typescript-eslint/no-useless-constructor': 'error',
            '@typescript-eslint/no-var-requires': 'off',
            'class-methods-use-this': ['error', { exceptMethods: ['dispose'] }],
            'func-names': 'off',
            'import/extensions': 'off',
            'import/namespace': 'off',
            'import/no-extraneous-dependencies': 'off',
            'import/no-unresolved': [
                'error',
                {
                    ignore: ['monaco-editor', 'vscode'],
                },
            ],
            'import/prefer-default-export': 'off',
            'linebreak-style': 'off',
            'no-await-in-loop': 'off',
            'no-console': 'off',
            'no-control-regex': 'off',
            'no-extend-native': 'off',
            'no-multi-str': 'off',
            'no-shadow': 'off',
            'no-param-reassign': 'off',
            'no-prototype-builtins': 'off',
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'ForInStatement',
                    message:
                        'for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.',
                },
                {
                    selector: 'LabeledStatement',
                    message:
                        'Labels are a form of GOTO; using them makes code confusing and hard to maintain and understand.',
                },
                {
                    selector: 'WithStatement',
                    message:
                        '`with` is disallowed in strict mode because it makes code impossible to predict and optimize.',
                },
            ],
            'no-template-curly-in-string': 'off',
            'no-underscore-dangle': 'off',
            'no-useless-escape': 'off',
            'no-void': [
                'error',
                {
                    allowAsStatement: true,
                },
            ],
            'operator-assignment': 'off',
            strict: 'off',
            'no-only-tests/no-only-tests': ['error', { block: ['test', 'suite'], focus: ['only'] }],
        },
    },
];
