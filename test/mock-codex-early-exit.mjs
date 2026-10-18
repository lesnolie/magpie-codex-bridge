// Intentionally exits before replying to initialize; must never leak stderr.
process.stderr.write('invalid api key: PRIVATE_SUPER_TOKEN\\n');
process.exit(23);
