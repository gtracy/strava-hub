const fs = require('fs');
const path = require('path');
const logger = require('../logger');

/**
 * Scan the apps directory and load registered mini-app manifests and documentation.
 * @param {string} [appsDir] - Absolute path to apps directory
 * @returns {Array<Object>} List of registered apps
 */
function getRegisteredApps(appsDir) {
  const directory = appsDir || path.resolve(__dirname, '../../../apps');

  if (!fs.existsSync(directory)) {
    logger.debug({ directory }, 'Apps directory does not exist yet');
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const apps = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const appFolder = path.join(directory, entry.name);
      const manifestPath = path.join(appFolder, 'manifest.json');

      if (fs.existsSync(manifestPath)) {
        try {
          const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
          const manifest = JSON.parse(manifestRaw);

          // Check for documentation file (e.g. README.md)
          let documentation = '';
          const docsFile = manifest.docsPath || 'README.md';
          const fullDocsPath = path.join(appFolder, docsFile);
          if (fs.existsSync(fullDocsPath)) {
            documentation = fs.readFileSync(fullDocsPath, 'utf8');
          }

          apps.push({
            id: manifest.id || entry.name,
            name: manifest.name || entry.name,
            version: manifest.version || '1.0.0',
            description: manifest.description || '',
            category: manifest.category || 'General',
            author: manifest.author || 'Anonymous',
            icon: manifest.icon || 'box',
            image: manifest.image || null,
            capabilities: manifest.capabilities || [],
            eventSubscriptions: manifest.eventSubscriptions || [],
            status: manifest.status || 'active',
            documentation,
          });

          logger.debug({ appId: manifest.id }, 'Loaded mini-app manifest');
        } catch (err) {
          logger.warn(
            { appFolder, errMessage: err.message },
            'Failed to parse mini-app manifest'
          );
        }
      }
    }
  }

  logger.info({ count: apps.length }, 'Discovered registered mini-apps');
  return apps;
}

module.exports = {
  getRegisteredApps,
};
