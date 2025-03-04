/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const glob = require('glob');
const path = require('path');

try {
    require('tsx/cjs');
} catch (error) {
    // If tsx is not available, we'll only support JS files
    console.warn('tsx module not available, TypeScript ESLint rules will not be loaded.');
}

// Re-export all .ts and .js files as rules
const rules = {};
glob.sync(`**/!(index).?(js|ts)`, { cwd: __dirname }).forEach((file) => {
    const basename = path.basename(file, path.extname(file));
    rules[basename] = require(`./${file}`);
});

exports.rules = rules;
