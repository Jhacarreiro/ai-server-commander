const fs = require( 'fs' );
const {
    checkJavaScriptContent
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

const MAX_REPLACEMENTS = Math.max( 1, Number.parseInt( process.env.MAX_REPLACEMENTS || '50', 10 ) || 50 );
const MAX_EDIT_FILE_BYTES = Math.max( 1024, Number.parseInt( process.env.MAX_EDIT_FILE_BYTES || String( 2 * 1024 * 1024 ), 10 ) || 2 * 1024 * 1024 );
// JavaScript files that espree can parse. TypeScript and JSX are left alone:
// they would fail the syntax check and every edit would be reverted.
const JAVASCRIPT_FILE = /\.(?:js|mjs|cjs)$/i;
// js-beautify joins lines after restricted productions, so `return\n{a: 1}`
// becomes `return {a: 1}`: still valid, but it now returns the object instead
// of undefined. Such files are written without reformatting.
const ASI_HAZARD = /(?:^|[;{}\s])(?:return|break|continue|throw|yield)[ \t]*\r?\n|(?:\+\+|--)[ \t]*\r?\n/;

const tooLarge = () => Object.assign(
    new Error( `File exceeds MAX_EDIT_FILE_BYTES (${MAX_EDIT_FILE_BYTES}).` ),
    { status: 413 }
);

// Beautify a JavaScript edit only when that cannot change its meaning or
// break it; otherwise keep the content exactly as edited. A leading BOM is
// preserved (js-beautify drops it).
const formatJavaScript = async ( content ) => {
    const hasBom = content.charCodeAt( 0 ) === 0xFEFF;
    const source = hasBom ? content.slice( 1 ) : content;
    if ( ASI_HAZARD.test( source ) ) return content;
    const beautified = beautify( source, { indent_size: 2 } );
    if ( ( await checkJavaScriptContent( beautified ) ).length > 0 ) return content;
    return ( hasBom ? '\uFEFF' : '' ) + beautified;
};

// Resolve symlinks so a link inside the workspace cannot point at files
// outside it. When the target does not exist yet (POST may create it),
// resolve the deepest existing ancestor and re-append the missing tail
// lexically; fall back to the lexical path if that also fails.
const resolveRealPath = ( target ) => {
    try {
        return fs.realpathSync( target );
    } catch {
        let probe = path.dirname( target );
        const tail = [ path.basename( target ) ];
        while ( !fs.existsSync( probe ) ) {
            const parent = path.dirname( probe );
            if ( parent === probe ) break;
            tail.unshift( path.basename( probe ) );
            probe = parent;
        }
        try {
            return path.join( fs.realpathSync( probe ), ...tail );
        } catch {
            return target;
        }
    }
};

const replaceTextInSection = async ( filePath, replacements ) => {
    let fileContent = '';
    let created = false;
    const readOnly = !replacements || replacements.length === 0;

    try {
        const stat = await fs.promises.stat( filePath );
        if ( stat.size > MAX_EDIT_FILE_BYTES ) throw tooLarge();
        fileContent = await fs.promises.readFile( filePath, 'utf8' );
    } catch ( err ) {
        // Only a missing file may become a new one; any other read error must
        // not be mistaken for empty content that would then be written back.
        if ( !err || err.code !== 'ENOENT' ) throw err;
        if ( readOnly ) {
            throw new Error( 'File does not exist, if you want to create it ask for initial content and try again.' );
        }
        created = true;
    }

    if ( readOnly ) {
        return {
            updatedContent: fileContent,
            unsuccessfulReplacements: [],
            fuzzyReplacements: [],
            originalContent: fileContent
        };
    }

    const result = await mergeText( fileContent, replacements );

    // A new file is only written when every replacement applied, so a failed
    // edit never leaves an empty or partial file behind.
    const written = !created || result.unsuccessfulReplacements.length === 0;
    if ( written ) {
        await fs.promises.writeFile( filePath, result.updatedContent );
    }

    return Object.assign( result, { created, written } );
};

// Undo an edit that cannot be kept: restore the previous content, or remove
// the file entirely when this request created it.
const revertEdit = async ( filePath, replaceResult ) => {
    if ( !replaceResult.written ) return;
    if ( replaceResult.created ) {
        await fs.promises.rm( filePath, { force: true } );
        return;
    }
    await fs.promises.writeFile( filePath, replaceResult.originalContent );
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
    const resolvedPath = path.resolve( currentDir, filePath );
    const workspaceRoot = path.resolve( currentDir );
    if ( resolvedPath !== workspaceRoot && !resolvedPath.startsWith( workspaceRoot + path.sep ) ) {
        return res.status( 400 ).send( 'File path is outside the workspace directory.' );
    }

    // Re-check the boundary against symlink-resolved paths so a link inside
    // the workspace cannot reach files outside it (reads and writes).
    const resolvedWorkspace = resolveRealPath( workspaceRoot );
    const resolvedFile = resolveRealPath( resolvedPath );
    if ( resolvedFile !== resolvedWorkspace && !resolvedFile.startsWith( resolvedWorkspace + path.sep ) ) {
        return res.status( 400 ).send( 'File path is outside the workspace directory.' );
    }
    filePath = resolvedFile;

    // GET is a pure read: return the raw file content without minting access
    // tokens, syntax checking, beautifying, or writing anything.
    if ( req.method === 'GET' ) {
        let content;
        try {
            if ( ( await fs.promises.stat( filePath ) ).size > MAX_EDIT_FILE_BYTES ) {
                return res.status( 413 ).send( `File exceeds MAX_EDIT_FILE_BYTES (${MAX_EDIT_FILE_BYTES}). Read it in parts through the terminal instead.` );
            }
            content = await fs.promises.readFile( filePath, 'utf8' );
        } catch ( error ) {
            console.error( error );
            return res.status( 400 ).send( `Error reading the file: ${error.message}` );
        }
        return res.type( 'text/plain' ).send( content );
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
            if ( body.replacements !== undefined && !Array.isArray( body.replacements ) ) {
                return res.status( 400 ).json( { error: 'replacements must be an array.' } );
            }
            replacements = body.replacements || (body.replacement && [body.replacement]) || [];
        }
        if ( replacements.length > MAX_REPLACEMENTS ) {
            return res.status( 400 ).json( { error: `Too many replacements (max ${MAX_REPLACEMENTS}).` } );
        }

        replaceResult = await replaceTextInSection( filePath, replacements );

        let responseMessage = '';
        if ( replaceResult.fuzzyReplacements.length > 0 ) {
            responseMessage += `\nFuzzy replacements: ${replaceResult.fuzzyReplacements.join('\n')}`;
        }

        if ( replaceResult.unsuccessfulReplacements.length > 0 ) {
            await revertEdit( filePath, replaceResult );
            let unsuccessfulMessages = replaceResult.unsuccessfulReplacements.join( "; " );
            responseMessage += "\nError happened, explain it to user";
            responseMessage += `\nUnsuccessful replacements due to missing texts: ${unsuccessfulMessages}`;
            responseMessage += replaceResult.created
                ? `\nNew file was not created`
                : `\nFile reverted to original version before changes`;
            if ( replacements.length > replaceResult.unsuccessfulReplacements.length ) {
                responseMessage += `\n${replacements.length - replaceResult.unsuccessfulReplacements.length} replacements were successful do them first, then try fixing failing ones in separate request`;
            }
            res.status( 400 ).send( responseMessage );
            return;
        }

        let finalContent = replaceResult.updatedContent;
        if ( JAVASCRIPT_FILE.test( filePath ) ) {
            const issues = await checkJavaScriptContent( finalContent );
            if ( issues.length > 0 ) {
                await revertEdit( filePath, replaceResult );
                responseMessage += "\nError happened, explain it to user";
                responseMessage += replaceResult.created
                    ? "\nNew file was not kept"
                    : "\nFile reverted to original form before changes";
                responseMessage += '\nIssues found in the file: \n' + JSON.stringify( issues );
                responseMessage += `\nFile content before change: ${replaceResult.originalContent.split('\n').map((l, i) => `${i}: ${l}`).join('\n')}`;
                responseMessage += `\nFile content after change: ${replaceResult.updatedContent.split('\n').map((l, i) => `${i}: ${l}`).join('\n')}`;
                log( 'responseMessage', responseMessage );
                res.status( 400 ).send( responseMessage );
                return;
            }
            finalContent = await formatJavaScript( finalContent );
            if ( finalContent !== replaceResult.updatedContent ) await fs.promises.writeFile( filePath, finalContent );
        }

        // Mint the share link only for an edit that was kept, and only once:
        // createToken rotates, so a second call would revoke the first URL and
        // a rejected edit must not revoke a link that is still in use.
        const url = createToken( getURL, filePath );
        responseMessage = `
        File url: ${url}
        Changed diff url: ${url}?diff=1` + responseMessage + `\nFile content: ${finalContent}`;
        res.type( 'text/plain' ).send( responseMessage );
    } catch ( error ) {
        console.error( error );
        if ( replaceResult && replaceResult.created && replaceResult.written ) {
            await fs.promises.rm( filePath, { force: true } ).catch( () => {} );
        }
        const logData = {
            error: error.message,
            request: req.body || req.query,
            filePath: filePath || 'N/A',
            fileContentBefore: replaceResult?.originalContent || 'N/A',
            fileContentAfter: replaceResult?.updatedContent || 'N/A'
        };
        // TODO no such dir fix
        // fs.appendFileSync( path.join( __dirname, '../logs/http_error_responses.log' ), JSON.stringify( logData, null, 2 ) + '\n', 'utf8' );
        res.status( error.status || 500 ).json( {
            error: stringifyError( error )
        } );
    }
};

module.exports = readEditTextFileHandler;
module.exports.replaceTextInSection = replaceTextInSection;