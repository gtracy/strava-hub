const fs = require('fs');
const path = require('path');
const appRegistry = require('../services/app-registry');

describe('App Registry Service', () => {
  const testDir = path.join(__dirname, '__test_apps__');
  const mockAppDir = path.join(testDir, 'sample-app');

  beforeAll(() => {
    fs.mkdirSync(mockAppDir, { recursive: true });

    const manifest = {
      id: 'sample-app',
      name: 'Sample App',
      version: '1.2.0',
      description: 'A test mini app',
      category: 'Analytics',
      author: 'Tester',
      icon: 'zap',
      image: 'assets/sample.png',
      capabilities: ['activity.created'],
      docsPath: 'README.md',
    };

    fs.writeFileSync(path.join(mockAppDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(mockAppDir, 'README.md'), '# Sample App Documentation\nHow to use.');
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('discovers apps, parses manifest and includes markdown docs', () => {
    const apps = appRegistry.getRegisteredApps(testDir);
    expect(apps).toHaveLength(1);

    const app = apps[0];
    expect(app.id).toBe('sample-app');
    expect(app.name).toBe('Sample App');
    expect(app.image).toBe('assets/sample.png');
    expect(app.documentation).toContain('# Sample App Documentation');
  });

  test('returns empty array if apps directory does not exist', () => {
    const apps = appRegistry.getRegisteredApps('/non/existent/path');
    expect(apps).toEqual([]);
  });
});
