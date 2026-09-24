const fs = require('fs');
const espree = require('espree');

// Parse as an ES module first and fall back to a classic script, so files
// that are only valid in one of the two (import/export vs. `with`, legacy
// octals, non-strict code) are accepted. Only report an issue when both fail.
function checkJavaScriptContent(fileContent) {
    const fileLines = fileContent.split('\n');
    let firstError = null;
    for (const sourceType of ['module', 'script']) {
        try {
            espree.parse(fileContent, { ecmaVersion: 'latest', loc: true, sourceType });
            return Promise.resolve([]);
        } catch (error) {
            if (!firstError) firstError = error;
        }
    }
    return Promise.resolve([{
        line: firstError.lineNumber,
        column: firstError.column,
        message: firstError.message,
        codeLine: fileLines[firstError.lineNumber - 1]
    }]);
}

async function checkJavaScriptFile(filePath) {
    return checkJavaScriptContent(await fs.promises.readFile(filePath, { encoding: 'utf8' }));
}

module.exports = { checkJavaScriptContent, checkJavaScriptFile };
