const config = require('./config');
const { app } = require('./server');
const { startBot } = require('./bot');

app.listen(config.port, () => console.log(`[web] dashboard listening at ${config.publicUrl}`));
startBot().catch((error) => { console.error('[discord] unable to start:', error); process.exitCode = 1; });
