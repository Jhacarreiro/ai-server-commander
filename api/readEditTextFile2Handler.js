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

const replaceTextInSection = async ( filePath, replacements ) => {
    // The file must exist regardless of mode: a missing file cannot be edited,
    // and creating one implicitly would leave an empty artifact behind.
    if ( !fs.existsSync( filePath ) ) {
        throw new Error( 'File does not exist, if you want to create it ask for initial content and try again.' );
    }

    let fileHandle;
    try {
        fileHandle = await fs.promises.open( filePath, 'r+' ); // read-write; never creates files
        const fileContent = await fileHandle.readFile( 'utf8' );
        const result = await mergeText( fileContent, replacements );
        // Keep the same descriptor for the write: truncate + write at position 0
        // so a concurrent delete/replace of the pathname cannot redirect the
        // write to a different inode, and so a stale offset after readFile
        // cannot insert NUL padding. write on a handle does not create a new path.
        await fileHandle.truncate( 0 );
        await fileHandle.write( result.updatedContent, 0, 'utf8' );
        return result;
    } catch ( err ) {
        // Do not leak absolute filesystem paths via the shared /api/logs
        // buffer (Node ENOENT/EACCES errors carry an enumerable `path`); log
        // only the message text server-side.
        log( 'Error reading file:', err instanceof Error ? err.message : String( err ) );
        throw err;
    } finally {
        if ( fileHandle !== undefined ) await fileHandle.close();
    }
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
                await fs.promises.writeFile( filePath, replaceResult.originalContent );
                responseMessage += "\nError happened, explain it to user";
                responseMessage += "\nFile reverted to original form before changes";
                responseMessage += '\nIssues found in the file: \n' + JSON.stringify( issues );
                responseMessage += `\nFile content before change: ${replaceResult.originalContent.split('\n').map((l, i) => `${i}: ${l}`).join('\n')}`;
                responseMessage += `\nFile content after change: ${replaceResult.updatedContent.split('\n').map((l, i) => `${i}: ${l}`).join('\n')}`;
                log( 'responseMessage', responseMessage );
                res.status( 400 ).send( responseMessage );
                return;
            }
        }

        if ( replaceResult.unsuccessfulReplacements.length > 0 ) {
            await fs.promises.writeFile( filePath, replaceResult.originalContent );
            let unsuccessfulMessages = replaceResult.unsuccessfulReplacements.join( "; " );
            responseMessage += "\nError happened, explain it to user";
            responseMessage += `\nUnsuccessful replacements due to missing texts: ${unsuccessfulMessages}`;
            responseMessage += `\nFile reverted to original version before changes`;
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
        console.error( error );
        const logData = {
            error: error instanceof Error ? error.message : String( error ),
            request: req.body || req.query,
            filePath: filePath || 'N/A',
            fileContentBefore: replaceResult?.originalContent || 'N/A',
            fileContentAfter: replaceResult?.updatedContent || 'N/A'
        };
        // TODO no such dir fix
        // fs.appendFileSync( path.join( __dirname, '../logs/http_error_responses.log' ), JSON.stringify( logData, null, 2 ) + '\\n', 'utf8' );
        // Never leak filesystem paths or stacks to clients; keep details in server logs.
        const msg = error instanceof Error ? error.message : String( error );
        const clientSafe = typeof msg === 'string' && msg.startsWith('File does not exist');
        log( 'read-or-edit-file failed', clientSafe ? msg : 'Internal server error.' );
        res.status( 500 ).json( {
            error: clientSafe ? msg : 'Internal server error.'
        } );
    }
};

module.exports = readEditTextFileHandler;
module.exports.replaceTextInSection = replaceTextInSection;