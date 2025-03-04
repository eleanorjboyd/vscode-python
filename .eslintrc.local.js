/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * This file configures ESLint to look for locally defined plugins in the .eslintplugin folder
 */
module.exports = {
    plugins: ['local'],
    rules: {
        'local/no-bad-gdpr-comment': 'error',
    },
    settings: {
        local: {
            pluginDirectory: '.eslintplugin',
        },
    },
};
