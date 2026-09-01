const fs = require( 'fs' );
const {
    checkJavaScriptFile
} = require( '../serverModules/checkjs' );
const beautify = require( 'js-beautify' ).js;
const {
    stringifyError
} = require( "../serverModules/stringifyError" );
const {
    log
} = require( "../serverModules/logger" );
const {
    createToken
} = require( "../serverModules/fileAccessHandler" );
const {
    getCurrentDirectory
} = require( "./terminal" );
const {
    mergeText,
    parseConflicts
} = require( '../serverModules/fileEdit' );
const path = require('node:path');

const missingFileClientError = () => {
    const error = new Error( 'File does not exist and no replacement starts from an empty originalText; ask for initial content and try again.' );
    error.status = 400;
    return error;
};

const allowsMissingFileCreate = ( replacements ) =>
    ( replacements || [] ).some( ( r ) => r && r.originalText === '' );

const assertStringOriginalTexts = ( replacements ) => {
    for ( const r of replacements || [] ) {
        if ( r && Object.prototype.hasOwnProperty.call( r, 'originalText' ) && typeof r.originalText !== 'string' ) {
            const error = new Error( 'Search text (originalText) must be a string.' );
            error.status = 400;
            throw error;
        }
    }
};

const revertFileToOriginal = async ( filePath, replaceResult ) => {
    if ( replaceResult.created ) {
        try {
            await fs.promises.unlink( filePath );
        } catch ( err ) {
            if ( !err || err.code !== 'ENOENT' ) throw err;
        }
        return;
    }
    await fs.promises.writeFile( filePath, replaceResult.originalContent );
};

const replaceTextInSection = async ( filePath, replacements ) => {
    let fileHandle;
    let fileContent = '';
    let created = false;

    assertStringOriginalTexts( replacements );

    // Missing paths may only be created by a replacement whose originalText
    // is a literal empty string. Open existing files with 'r' (not 'a+')
    // and fail closed on read errors so a path that vanishes after a
    // previous exists check cannot be recreated as an empty file.
    try {
        fileHandle = await fs.promises.open( filePath, 'r' );
        fileContent = await fileHandle.readFile( 'utf8' );
    } catch ( err ) {
        if ( err && err.code === 'ENOENT' ) {
            if ( !allowsMissingFileCreate( replacements ) ) {
                throw missingFileClientError();
            }
            fileContent = '';
            created = true;
        } else {
            throw err;
        }
    } finally {
        if ( fileHandle !== undefined ) await fileHandle.close();
    }

    const result = await mergeText( fileContent, replacements );

    await fs.promises.writeFile( filePath, result.updatedContent );

    return Object.assign( result, { created } );
};

/**
 * @openapi
 * /api/read-or-edit-file:
 *   get:
 *      operationId: readTextInFile
 *      summary: Read a file content
 *      parameters:
 *        - in: query
 *          name: filePath
 *          required: true
 *          schema:
 *            type: string
 *          description: Path to the file to be read
 *      responses:
 *        200:
 *          description: File read successfully
 *          content:
 *            text/plain:
 *              schema:
 *                type: string
 *        400:
 *          description: Error reading the file
 *          content:
 *            application/json:
 *              schema:
 *                type: object
 *                properties:
 *                  error:
 *                    type: string
 *                    description: Error message explaining the reason for failure
 *   post:
 *     summary: Modify a file using search and replace command list
 *     description: Accepts a file path and a search and replace strings
 *     operationId: replaceTextInSection
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               filePath:
 *                 type: string
 *                 description: Path to the file to be edited
 *               replacements:
 *                 type: array
 *                 description: Array of text replacement
 *                 items:
 *                   type: object
 *                   properties:
 *                     originalText:
 *                       type: string
 *                       description: Text to be replaced
 *                     replacementText:
 *                       type: string
 *                       description: Text to replace with
 *     responses:
 *       200:
 *         description: File modification was successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                   description: Updated file content and urls
 *       400:
 *         description: There was an error in the text replacement
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Details of the error along with file current content and access url
 */
const readEditTextFileHandler = ( getURL ) => async ( req, res ) => {
    let filePath;
    let body = {}; // Initialize with an empty object for safety

    if ( req.method === 'GET' ) {
        filePath = req.query.filePath; // Get the file path from query parameters
        body = {
            filePath
        }; // Mimic the structure expected by replaceTextInSection
    } else if ( req.method === 'POST' ) {
        body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
        filePath = body.filePath;
    }

    const currentDir = await getCurrentDirectory();
    if ( typeof filePath !== 'string' || !filePath.trim() ) {
        return res.status( 400 ).json( { error: 'File path is required.' } );
    }
    if ( !filePath.startsWith( currentDir ) ) {
        filePath = currentDir + '/' + filePath;
    }

    let replaceResult;

    try {

        let replacements;
        if ( body.mergeText ) {
            replacements = parseConflicts( body.mergeText );

            if ( replacements.length === 0 && body.mergeText.length > 0 ) {
                throw new Error( 'mergeText was not empty, but no conflict blocks were found, they are checked using regex like this /<<<<<<< HEAD[\\s\\S]*?>>>>>>> [\\w-]+/g Check what you send and try again' )
            }
        } else {
            replacements = body.replacements || (body.replacement && [body.replacement]) || [];
        }

        replaceResult = await replaceTextInSection( filePath, replacements );

        const url = createToken( getURL, filePath );
        let responseMessage = `
        File url: ${url}
        Changed diff url: ${createToken(getURL, filePath)}?diff=1`;

        if ( replaceResult.fuzzyReplacements.length > 0 ) {
            responseMessage += `Fuzzy replacements: ${replaceResult.fuzzyReplacements.join('\n')}`
        }

        if ( filePath.endsWith( '.js' ) ) {
            debugger;
            let issues = await checkJavaScriptFile( filePath );
            if ( issues.length > 0 ) {
                await revertFileToOriginal( filePath, replaceResult );
                responseMessage += "\nError happened, explain it to user";
                responseMessage += replaceResult.created
                    ? "\nCreated file removed because the edit could not be kept"
                    : "\nFile reverted to original form before changes";
                responseMessage += '\nIssues found in the file: \n' + JSON.stringify( issues );
                responseMessage += `\nFile content before change: ${replaceResult.originalContent.split('\n').map((l, i) => `${i}: ${l}`).join('\n')}`;
                responseMessage += `\nFile content after change: ${replaceResult.updatedContent.split('\n').map((l, i) => `${i}: ${l}`).join('\n')}`;
                log( 'responseMessage', responseMessage );
                res.status( 400 ).send( responseMessage );
                return;
            }
        }

        if ( replaceResult.unsuccessfulReplacements.length > 0 ) {
            await revertFileToOriginal( filePath, replaceResult );
            let unsuccessfulMessages = replaceResult.unsuccessfulReplacements.join( "; " );
            responseMessage += "\nError happened, explain it to user";
            responseMessage += `\nUnsuccessful replacements due to missing texts: ${unsuccessfulMessages}`;
            responseMessage += replaceResult.created
                ? `\nCreated file removed because the edit could not be kept`
                : `\nFile reverted to original version before changes`;
            if ( replacements.length > replaceResult.unsuccessfulReplacements.length ) {
                responseMessage += `\n${replacements.length - replaceResult.unsuccessfulReplacements.length} replacements were successful do them first, then try fixing failing ones in separate request`;
            }
            res.status( 400 ).send( responseMessage );
            return;
        }

        if (filePath.endsWith('.js')) {
            const beautifiedContent = beautify(replaceResult.updatedContent, {
                indent_size: 2,
                //space_in_paren: true
            });
            await fs.promises.writeFile(filePath, beautifiedContent);
            responseMessage += `\nFile content: ${beautifiedContent}`;
        } else {
            responseMessage += `\nFile content: ${replaceResult.updatedContent || replaceResult.originalContent}`;
        }
        res.type( 'text/plain' ).send( responseMessage );
    } catch ( error ) {
        if ( replaceResult && replaceResult.created ) {
            try {
                await fs.promises.unlink( filePath );
            } catch ( err ) {
                if ( !err || err.code !== 'ENOENT' ) {
                    console.error( err );
                }
            }
        }
        console.error( error );
        const logData = {
            error: error.message,
            request: req.body || req.query,
            filePath: filePath || 'N/A',
            fileContentBefore: replaceResult?.originalContent || 'N/A',
            fileContentAfter: replaceResult?.updatedContent || 'N/A'
        };
        // TODO no such dir fix
        // fs.appendFileSync( path.join( __dirname, '../logs/http_error_responses.log' ), JSON.stringify( logData, null, 2 ) + '\n', 'utf8' );
        res.status( error.status === 400 ? 400 : 500 ).json( {
            error: stringifyError( error )
        } );
    }
};

module.exports = readEditTextFileHandler;