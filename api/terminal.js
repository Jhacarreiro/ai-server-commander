const { spawn } = require('child_process');
const { getPendingNotices } = require('./notices');
const { appendActivity, preview, hashText, getActivityContext } = require('./activityLog');

// Create a persistent shell
let shell;
let allOutput = '';
try {
    shell = spawn('zsh', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (shell.stdin.writable) {
        shell.stdin.write('source ~/.zshrc\n');
    }

    shell.stdout.on('data', (data) => {
        allOutput += data.toString(); // Append to buffer
    });

    shell.on('error', (err) => {
        console.error('Failed to start zsh:', err);
        // Fallback to bash if zsh fails
        shell = spawn('bash', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    });

    shell.on('exit', (code, signal) => {
        console.log(`Shell exited with code ${code} and signal ${signal}`);
    });

} catch (e) {
    console.error('Error spawning shell:', e);
    // Fallback to bash in case of an unexpected error in try block
    shell = spawn('bash', [], { stdio: ['pipe', 'pipe', 'pipe'] });
}
const delimiter = 'COMMAND_FINISHED_DELIMITER';
let output = "";

/**
 * @openapi
 * /api/runTerminalScript:
 *   get:
 *     summary: Execute a shell command - from git commands to running code, listing files, or anything else that's possible to do through a shell command.
 *     description: This endpoint allows users to execute arbitrary shell commands, use it only after checking listCommands to check if appropriate command was created before.
 *     operationId: runTerminalScript
 *     parameters:
 *       - in: query
 *         name: command
 *         required: true
 *         description: The shell command to execute.
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Command executed successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   description: A message indicating the success of the command execution.
 *                 output:
 *                   type: string
 *                   description: The output of the executed command.
 *                 notices:
 *                   type: array
 *                   description: Pending notices attached to the command response.
 *                   items:
 *                     type: object
 *       '400':
 *         description: Bad request (e.g., missing command parameter).
 *       '500':
 *         description: Internal server error (e.g., error executing command).
 */
function terminalHandler(req, res) {
    console.log('execute command');
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, openai-conversation-id, openai-ephemeral-user-id');
    res.setHeader('Access-Control-Allow-Credentials', true);

    // Handle preflight request (OPTIONS method)
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const command = req.query.command || req.body?.command;
    if (!command) {
        return res.status(400).json({message: 'Command parameter is required.'});
    }

    const activityContext = getActivityContext(req);
    const activityId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAtMs = Date.now();
    appendActivity({
        type: 'command_started',
        id: activityId,
        commandHash: hashText(command),
        commandPreview: preview(command, 240)
    }, activityContext);

    let didTimeOut = false;
    const getOutput = (data) => {
        let timeoutId = setTimeout(() => {
            console.log("Command timed out.");
            didTimeOut = true;
            shell.stdin.write("\x03"); // Send Ctrl+C to interrupt
            processOutput(output + "\n[INFO] Command timed out.");
            output = "";
        }, 10000); // 10-second timeout
        output += data.toString();
        console.log('data', data.toString())
        clearTimeout(timeoutId);
        if (output.includes(delimiter)) {
            console.log('delimeter found');
            // Remove the delimiter from the output
            output = output.replace(delimiter, '');
            processOutput(output);
            output = '';
        }
    };
    shell.stdout.on('data', getOutput);
    const getError = (data) => {
        output += data;
    };
    shell.stderr.on('data', getError);

    function processOutput(output) {
        console.log(`Command executed successfully. Output: ${output}`);
        shell.stdout.removeListener('data', getOutput);
        shell.stderr.removeListener('data', getError);
        const notices = getPendingNotices(activityContext);
        appendActivity({
            type: 'command_finished',
            id: activityId,
            commandHash: hashText(command),
            exitCode: didTimeOut ? 124 : 0,
            timedOut: didTimeOut,
            durationMs: Date.now() - startedAtMs,
            outputLength: output.length,
            outputTruncated: output.length >= 4097,
            outputPreview: preview(output, 1200),
            noticesCount: notices.length,
            errorPreview: null
        }, activityContext);
        if (output.length < 4097) {
            return res.status(200).json({message: 'Command executed successfully.', output, notices});
        } else {
            return res.status(200).json({
                message: 'Command executed successfully. But size is too big, returning 3900 first symbols',
                output: output.substr(0, 3900),
                notices
            });
        }
    }

    // Append the delimiter to the command
    console.log(command);
    shell.stdin.write(`${command}; echo ${delimiter}\n`);
}

/**
 * @openapi
 * /api/interrupt:
 *   post:
 *     summary: Interrupts a running terminal command.
 *     description: This endpoint allows users to send a SIGINT signal to interrupt any currently running terminal command.
 *     operationId: interruptCommand
 *     responses:
 *       200:
 *         description: Command interrupted successfully.
 *       405:
 *         description: Method not allowed. Please use POST.
 */
function interruptHandler(req, res) {
    if (req.method === "POST") {
        // Send SIGKILL to terminate the shell
        shell.kill("SIGKILL");
        console.log("Sent SIGKILL to terminate the command.");
        
        // Create a new shell instance
        shell = spawn('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        // Return the latest output and then reset it
        res.status(200).json({ message: "Command interrupted.", output });
        output = "";
    } else {
        res.status(405).json({ message: "Method not allowed. Please use POST." });
    }
}

function getCurrentDirectory() {
    return new Promise((resolve, reject) => {
        shell.stdin.write("pwd\n");
        shell.stdout.once('data', (data) => {
            resolve(data.toString().trim());
        });
        shell.stderr.once('data', (data) => {
            reject(new Error(data.toString().trim()));
        });
    });
}

module.exports = {getCurrentDirectory, interruptHandler, terminalHandler};