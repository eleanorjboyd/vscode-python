import { expect, use } from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as utils from '../../client/testing/utils';
import sinon from 'sinon';
import { env } from 'vscode';
use(chaiAsPromised.default);

function test_idToModuleClassMethod() {
    try {
        expect(utils.idToModuleClassMethod('foo')).to.equal('foo');
        expect(utils.idToModuleClassMethod('a/b/c.py\\MyClass')).to.equal('c.MyClass');
        expect(utils.idToModuleClassMethod('a/b/c.py\\MyClass\\my_method')).to.equal('c.MyClass.my_method');
        expect(utils.idToModuleClassMethod('\\MyClass')).to.be.undefined;
        console.log('test_idToModuleClassMethod passed');
    } catch (e) {
        console.error('test_idToModuleClassMethod failed:', e);
    }
}

async function test_writeTestIdToClipboard() {
    let clipboardStub = sinon.stub(env.clipboard, 'writeText').resolves();
    try {
        // unittest id
        const testItem = { id: 'a/b/c.py\\MyClass\\my_method' };
        await utils.writeTestIdToClipboard(testItem as any);
        sinon.assert.calledOnceWithExactly(clipboardStub, 'c.MyClass.my_method');
        clipboardStub.resetHistory();

        // pytest id
        const testItem2 = { id: 'tests/test_foo.py::TestClass::test_method' };
        await utils.writeTestIdToClipboard(testItem2 as any);
        sinon.assert.calledOnceWithExactly(clipboardStub, 'tests/test_foo.py::TestClass::test_method');
        clipboardStub.resetHistory();

        // undefined
        await utils.writeTestIdToClipboard(undefined as any);
        sinon.assert.notCalled(clipboardStub);

        console.log('test_writeTestIdToClipboard passed');
    } catch (e) {
        console.error('test_writeTestIdToClipboard failed:', e);
    } finally {
        sinon.restore();
    }
}

// Run tests
(async () => {
    test_idToModuleClassMethod();
    await test_writeTestIdToClipboard();
})();
