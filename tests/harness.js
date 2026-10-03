'use strict';
// Loads the browser game scripts into a Node VM context so the simulation can be tested without a browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['js/data.js', 'js/state.js', 'js/sim.js'];

function createGame() {
  const context = vm.createContext({console});
  for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, {filename: file});
  const run = code => vm.runInContext(code, context);
  run('portfolio = freshPortfolio(); G = portfolio.airports.main;');
  return {context, run};
}

module.exports = {createGame, ROOT};
