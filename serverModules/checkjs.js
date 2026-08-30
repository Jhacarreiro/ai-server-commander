const fs = require('fs');
const path = require('path');
const espree = require('espree');

function parseIssues(fileContent) {
    const fileLines = fileContent.split('\n');  // Split content into lines
    const analyze = () => new Promise((resolve, reject) => {
        try {
            espree.parse(fileContent, {
                ecmaVersion: "latest", // or whichever ECMAScript version you are targeting
                loc: true,  // Enable line/column location information
                sourceType: "module",
            });
            resolve([]); // No syntax errors
        } catch (error) {
            if (error.message.includes("'import' and 'export'")) {
                try {
                    espree.parse(fileContent, {
                        ecmaVersion: "latest", // or whichever ECMAScript version you are targeting
                        loc: true,  // Enable line/column location information
                        sourceType: "script",
                    });
                } catch (error) {
                    const errorLine = fileLines[error.lineNumber - 1];
                    resolve([{
                        line: error.lineNumber,
                        column: error.column,
                        message: error.message,
                        codeLine: errorLine
                    }]);
                }
            } else {
                const errorLine = fileLines[error.lineNumber - 1];
                resolve([{line: error.lineNumber, column: error.column, message: error.message, codeLine: errorLine}]);
            }
        }
    });
    return analyze();
}

// Validate a content string (used to re-check beautified output before write)
function checkJavaScriptContent(content) {
    return parseIssues(content);
}

function checkJavaScriptFile(filePath) {
    return new Promise((resolve, reject) => {
        const fileContent = fs.readFileSync(filePath, {encoding: 'utf8'});
        const fileLines = fileContent.split('\n');  // Split content into lines
        try {
            espree.parse(fileContent, {
                ecmaVersion: "latest", // or whichever ECMAScript version you are targeting
                loc: true,  // Enable line/column location information
                sourceType: "module",
            });
            resolve([]); // No syntax errors
        } catch (error) {
            if (error.message.includes("'import' and 'export'")) {
                try {
                    espree.parse(fileContent, {
                        ecmaVersion: "latest", // or whichever ECMAScript version you are targeting
                        loc: true,  // Enable line/column location information
                        sourceType: "script",
                    });
                } catch (error) {
                    const errorLine = fileLines[error.lineNumber - 1];
                    resolve([{
                        line: error.lineNumber,
                        column: error.column,
                        message: error.message,
                        codeLine: errorLine
                    }]);
                }
            } else {
                const errorLine = fileLines[error.lineNumber - 1];
                resolve([{line: error.lineNumber, column: error.column, message: error.message, codeLine: errorLine}]);
            }
        }
    });
}

module.exports = {checkJavaScriptFile, checkJavaScriptContent};