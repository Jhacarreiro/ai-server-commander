const { parseConflicts, applyReplacements, mergeText } = require('../serverModules/fileEdit');

function assert(cond, label, details = '') {
    if (!cond) throw new Error(label + (details ? ': ' + details : ''));
    console.log('PASS ' + label);
}

(async () => {
    assert(typeof parseConflicts === 'function', 'parseConflicts export exists');
    assert(typeof applyReplacements === 'function', 'applyReplacements export exists');
    assert(typeof mergeText === 'function', 'mergeText export exists');

    const wellFormed = [
        '<<<<<<< HEAD',
        'old text',
        '=======',
        'new text',
        '>>>>>>> feature-branch'
    ].join('\n');
    const parsed = parseConflicts(wellFormed);
    assert(parsed.length === 1, 'parseConflicts extracts one well-formed conflict');
    assert(parsed[0].originalText.includes('old text'), 'parseConflicts originalText from well-formed block', JSON.stringify(parsed[0]));
    assert(parsed[0].replacementText.includes('new text'), 'parseConflicts replacementText from well-formed block', JSON.stringify(parsed[0]));

    const withSeparatorInReplacement = [
        '<<<<<<< HEAD',
        'keep me',
        '=======',
        'first=======second',
        '>>>>>>> feature-branch'
    ].join('\n');
    const parsedInner = parseConflicts(withSeparatorInReplacement);
    assert(parsedInner.length === 1, 'parseConflicts extracts block whose replacement contains =======');
    assert(parsedInner[0].replacementText.includes('first=======second'), 'parseConflicts preserves ======= inside replacement via join', JSON.stringify(parsedInner[0]));

    const malformed = '<<<<<<< HEAD\norphan body\n>>>>>>> feature-branch';
    let malformedThrew = false;
    try {
        parseConflicts(malformed);
    } catch (err) {
        malformedThrew = true;
        const message = err && err.message ? err.message : String(err);
        assert(/Malformed conflict|separator/i.test(message), 'malformed conflict error mentions Malformed conflict or separator', message);
    }
    assert(malformedThrew, 'parseConflicts throws on malformed block without =======');

    const mixed = [
        wellFormed,
        malformed
    ].join('\n');
    let mixedThrew = false;
    try {
        parseConflicts(mixed);
    } catch (err) {
        mixedThrew = true;
        const message = err && err.message ? err.message : String(err);
        assert(/Malformed conflict|separator/i.test(message), 'mixed payload error mentions Malformed conflict or separator', message);
    }
    assert(mixedThrew, 'parseConflicts throws on mixed valid+malformed payload');

    const originalFile = 'alpha beta gamma';
    const nullResult = await applyReplacements(originalFile, [{ originalText: 'beta', replacementText: null }]);
    assert(nullResult.updatedContent === originalFile, 'null replacementText leaves fileContent unchanged', JSON.stringify(nullResult));
    assert(
        nullResult.unsuccessfulReplacements.some((msg) => String(msg).includes('Replacement text')),
        'null replacementText records Replacement text unsuccessful message',
        JSON.stringify(nullResult.unsuccessfulReplacements)
    );

    const undefinedResult = await applyReplacements(originalFile, [{ originalText: 'beta', replacementText: undefined }]);
    assert(undefinedResult.updatedContent === originalFile, 'undefined replacementText leaves fileContent unchanged', JSON.stringify(undefinedResult));
    assert(
        undefinedResult.unsuccessfulReplacements.some((msg) => String(msg).includes('Replacement text')),
        'undefined replacementText records Replacement text unsuccessful message',
        JSON.stringify(undefinedResult.unsuccessfulReplacements)
    );

    const deleteResult = await applyReplacements(originalFile, [{ originalText: 'beta ', replacementText: '' }]);
    assert(deleteResult.updatedContent === 'alpha gamma', 'empty replacementText deletes matched text', JSON.stringify(deleteResult));
    assert(deleteResult.unsuccessfulReplacements.length === 0, 'empty replacementText has no unsuccessful entries', JSON.stringify(deleteResult.unsuccessfulReplacements));

    const happy = await applyReplacements(originalFile, [{ originalText: 'beta', replacementText: 'BETA' }]);
    assert(happy.updatedContent === 'alpha BETA gamma', 'happy path replaces the single occurrence', JSON.stringify(happy));
    assert(happy.unsuccessfulReplacements.length === 0, 'happy path has no unsuccessful entries', JSON.stringify(happy.unsuccessfulReplacements));

    const merged = await mergeText(originalFile, [{ originalText: 'gamma', replacementText: 'omega' }]);
    assert(merged.updatedContent === 'alpha beta omega', 'mergeText happy path updates content', JSON.stringify(merged));
    assert(merged.unsuccessfulReplacements.length === 0, 'mergeText happy path has no unsuccessful entries', JSON.stringify(merged.unsuccessfulReplacements));
})().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
