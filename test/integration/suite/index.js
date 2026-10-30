const vscode = require('vscode');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

exports.run = async function run() {
  const modulePath = path.join(__dirname, 'index.mjs');
  const mod = await import(pathToFileURL(modulePath).href);
  await mod.run();
};
