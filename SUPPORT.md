# Support

AI Server Commander is maintained on a best-effort basis.

## Before asking for help

1. Read the README and deployment guide.
2. Run `npm run check` and `npm test`.
3. Confirm the Node version with `node --version`.
4. Test `/openapi.json` locally.
5. Check the service log and reverse-proxy log.
6. Remove all tokens, private hostnames, usernames, paths and command output that may contain secrets.

## Where to ask

- Use GitHub Discussions for setup questions and design proposals when enabled.
- Use GitHub Issues for reproducible bugs and feature requests.
- Use private vulnerability reporting for security problems.

## Bug reports should include

- version or commit;
- operating system and Node version;
- REST or MCP client type;
- minimal configuration with secrets replaced;
- exact request and sanitized response;
- relevant sanitized logs;
- expected and actual behavior.

Do not request support by posting real authentication tokens or production configuration.
