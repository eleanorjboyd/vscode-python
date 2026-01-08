"use strict";
// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PythonExtension = exports.PVSC_EXTENSION_ID = void 0;
const vscode_1 = require("vscode");
exports.PVSC_EXTENSION_ID = 'ms-python.python';
// eslint-disable-next-line @typescript-eslint/no-namespace
var PythonExtension;
(function (PythonExtension) {
    /**
     * Returns the API exposed by the Python extension in VS Code.
     */
    function api() {
        return __awaiter(this, void 0, void 0, function* () {
            const extension = vscode_1.extensions.getExtension(exports.PVSC_EXTENSION_ID);
            if (extension === undefined) {
                throw new Error(`Python extension is not installed or is disabled`);
            }
            if (!extension.isActive) {
                yield extension.activate();
            }
            const pythonApi = extension.exports;
            return pythonApi;
        });
    }
    PythonExtension.api = api;
})(PythonExtension || (exports.PythonExtension = PythonExtension = {}));
//# sourceMappingURL=main.js.map